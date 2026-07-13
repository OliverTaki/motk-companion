// SPDX-License-Identifier: AGPL-3.0-or-later

import { D1ControlStore, hashToken } from './store.mjs';
import { googleSheetsAdapterFromEnv } from './google-sheets.mjs';

const SERVICE = 'motk-control-plane';
const VERSION = '0.3.0-beta.1';
const MAX_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const COMMAND_ACTIONS = new Set(['runner.run', 'runner.gate.approve', 'runner.resume']);
const TOKEN_SCOPES = new Set(['events.write', 'events.read', 'commands.write', 'commands.read', 'commands.ack', 'project.read', 'admin.project', 'admin.tokens', 'admin.audit']);
const COMPANION_SCOPES = ['events.write', 'events.read', 'commands.read', 'commands.ack', 'project.read'];

const securityHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'content-type': 'application/json; charset=utf-8',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const browserSecurityHeaders = {
  'cache-control': 'no-cache',
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...securityHeaders, ...extraHeaders } });
}

function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function adminAuthorized(request, env) {
  const expected = env.CONTROL_PLANE_ADMIN_TOKEN;
  return Boolean(expected) && bearerToken(request) === expected;
}

function projectIdFromPath(pathname) {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

async function eventId(event) {
  const bytes = new TextEncoder().encode(JSON.stringify([event.event, event.context, event.data, event.occurredAt]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function auditId(entry) {
  const bytes = new TextEncoder().encode(JSON.stringify([entry.projectId || '', entry.action, entry.outcome, entry.occurredAt, crypto.randomUUID()]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function recordAudit(store, projectId, action, outcome, detail = {}) {
  const occurredAt = new Date().toISOString();
  await store.addAudit({ auditId: await auditId({ projectId, action, outcome, occurredAt }), projectId, action, outcome, detail, occurredAt });
}

function validateProjectBody(projectId, body) {
  if (!ID_PATTERN.test(projectId)) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('invalid_project'), { status: 400 });
  if (typeof body.spreadsheetRef !== 'string' || !body.spreadsheetRef.trim()) throw Object.assign(new Error('invalid_spreadsheet_ref'), { status: 400 });
  if (typeof body.token !== 'string' || body.token.length < 32) throw Object.assign(new Error('invalid_project_token'), { status: 400 });
  const allowedOrigins = body.allowedOrigins || [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => { try { const url = new URL(origin); return url.origin !== origin || !['http:', 'https:'].includes(url.protocol); } catch { return true; } })) {
    throw Object.assign(new Error('invalid_allowed_origins'), { status: 400 });
  }
  return { projectId, spreadsheetRef: body.spreadsheetRef.trim(), allowedOrigins: [...new Set(allowedOrigins)] };
}

function validateEvent(body) {
  if (!body || body.type !== 'event' || !EVENT_PATTERN.test(body.event || '')) throw Object.assign(new Error('invalid_event'), { status: 400 });
  if (!body.context || !ID_PATTERN.test(body.context.projectId || '')) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
  if (body.context.shotId !== undefined && !ID_PATTERN.test(body.context.shotId)) throw Object.assign(new Error('invalid_shot_id'), { status: 400 });
  if (body.data === null || typeof body.data !== 'object' || Array.isArray(body.data)) throw Object.assign(new Error('invalid_event_data'), { status: 400 });
  if (typeof body.occurredAt !== 'string' || !Number.isFinite(Date.parse(body.occurredAt))) throw Object.assign(new Error('invalid_occurred_at'), { status: 400 });
  return body;
}

function corsHeaders(origin, project) {
  if (!origin) return {};
  if (!project.allowedOrigins.includes(origin)) throw Object.assign(new Error('origin_forbidden'), { status: 403 });
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function corsPreflight(origin, project) {
  const headers = corsHeaders(origin, project);
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function requireProject(request, store, projectId, scope) {
  if (!ID_PATTERN.test(projectId)) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
  const token = bearerToken(request);
  if (!token || !(await store.authenticate(projectId, await hashToken(token), scope))) throw Object.assign(new Error('unauthorized'), { status: 401 });
  const project = await store.project(projectId);
  if (!project?.active) throw Object.assign(new Error('project_not_found'), { status: 404 });
  return project;
}

async function handleProjectPut(request, env, store, projectId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const project = validateProjectBody(projectId, body);
  const scopes = COMPANION_SCOPES;
  const saved = await store.upsertProject(project, await hashToken(body.token), scopes);
  await recordAudit(store, projectId, 'project.provision', 'success', { allowedOriginCount: project.allowedOrigins.length });
  return json({ ok: true, project: saved }, 201);
}

function rotatedProjectId(pathname) {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)\/tokens\/rotate$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

async function handleTokenRotation(request, env, store, projectId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!ID_PATTERN.test(projectId) || !(await store.project(projectId))?.active) return json({ ok: false, error: 'project_not_found' }, 404);
  const body = await readJson(request);
  if (typeof body.token !== 'string' || body.token.length < 32) return json({ ok: false, error: 'invalid_project_token' }, 400);
  const scopes = COMPANION_SCOPES;
  const revokeExisting = body.revokeExisting !== false;
  await store.rotateProjectToken(projectId, await hashToken(body.token), scopes, revokeExisting);
  await recordAudit(store, projectId, 'project.token.rotate', 'success', { revokeExisting, scopes });
  return json({ ok: true, projectId, rotated: true, revokedExisting: revokeExisting });
}

function tokenIssueProjectId(pathname) {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)\/tokens$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

async function handleTokenIssue(request, env, store, projectId) {
  if (!ID_PATTERN.test(projectId) || !(await store.project(projectId))?.active) return json({ ok: false, error: 'project_not_found' }, 404);
  if (!adminAuthorized(request, env)) await requireProject(request, store, projectId, 'admin.tokens');
  const body = await readJson(request);
  if (typeof body.token !== 'string' || body.token.length < 32) return json({ ok: false, error: 'invalid_project_token' }, 400);
  const label = String(body.label || 'operator').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(label)) return json({ ok: false, error: 'invalid_token_label' }, 400);
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
  if (!scopes.length || scopes.some((scope) => !TOKEN_SCOPES.has(scope))) return json({ ok: false, error: 'invalid_token_scopes' }, 400);
  await store.addProjectToken(projectId, await hashToken(body.token), label, scopes);
  await recordAudit(store, projectId, 'project.token.issue', 'success', { label, scopes });
  return json({ ok: true, projectId, label, scopes }, 201);
}

async function handleProjectPatch(request, env, store, projectId) {
  if (!ID_PATTERN.test(projectId) || !(await store.project(projectId))?.active) return json({ ok: false, error: 'project_not_found' }, 404);
  if (!adminAuthorized(request, env)) await requireProject(request, store, projectId, 'admin.project');
  const body = await readJson(request);
  const patch = {};
  if (body.spreadsheetRef !== undefined) {
    if (typeof body.spreadsheetRef !== 'string' || !body.spreadsheetRef.trim()) return json({ ok: false, error: 'invalid_spreadsheet_ref' }, 400);
    patch.spreadsheetRef = body.spreadsheetRef.trim();
  }
  if (body.allowedOrigins !== undefined) {
    if (!Array.isArray(body.allowedOrigins) || body.allowedOrigins.some((origin) => { try { const url = new URL(origin); return url.origin !== origin || !['http:', 'https:'].includes(url.protocol); } catch { return true; } })) return json({ ok: false, error: 'invalid_allowed_origins' }, 400);
    patch.allowedOrigins = [...new Set(body.allowedOrigins)];
  }
  if (!Object.keys(patch).length) return json({ ok: false, error: 'empty_project_patch' }, 400);
  const project = await store.updateProject(projectId, patch);
  await recordAudit(store, projectId, 'project.update', 'success', { fields: Object.keys(patch), allowedOriginCount: project.allowedOrigins.length });
  return json({ ok: true, project });
}

function validateCommand(body) {
  if (!body || !COMMAND_ACTIONS.has(body.action)) throw Object.assign(new Error('invalid_command_action'), { status: 400 });
  const context = body.context || {};
  if (!ID_PATTERN.test(context.projectId || '')) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
  if (context.shotId !== undefined && !ID_PATTERN.test(context.shotId)) throw Object.assign(new Error('invalid_shot_id'), { status: 400 });
  if (body.payload === null || typeof body.payload !== 'object' || Array.isArray(body.payload)) throw Object.assign(new Error('invalid_command_payload'), { status: 400 });
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) throw Object.assign(new Error('invalid_idempotency_key'), { status: 400 });
  return { action: body.action, context, payload: body.payload || {}, idempotencyKey };
}

async function handleCommandPost(request, store, url) {
  const command = validateCommand(await readJson(request));
  const projectId = command.context.projectId;
  if ((url.searchParams.get('projectId') || projectId) !== projectId) throw Object.assign(new Error('project_id_mismatch'), { status: 400 });
  const project = await requireProject(request, store, projectId, 'commands.write');
  const headers = corsHeaders(request.headers.get('origin') || '', project);
  const commandId = crypto.randomUUID();
  const result = await store.insertCommand({ commandId, projectId, ...command });
  return json({ ok: true, accepted: true, duplicate: !result.inserted, commandId: result.commandId, status: result.status }, result.inserted ? 202 : 200, headers);
}

async function handleCommandList(request, store, url) {
  const projectId = url.searchParams.get('projectId') || '';
  const project = await requireProject(request, store, projectId, 'commands.write');
  const headers = corsHeaders(request.headers.get('origin') || '', project);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
  return json({ ok: true, projectId, commands: await store.listCommands(projectId, limit) }, 200, headers);
}

async function handleCommandClaim(request, store, url, env) {
  const projectId = url.searchParams.get('projectId') || '';
  const runtimeId = url.searchParams.get('runtimeId') || '';
  await requireProject(request, store, projectId, 'commands.read');
  if (!ID_PATTERN.test(runtimeId)) throw Object.assign(new Error('invalid_runtime_id'), { status: 400 });
  return json({ ok: true, projectId, command: await store.claimCommand(projectId, runtimeId, Number(env.MOTK_COMMAND_LEASE_SECONDS || 300)) });
}

async function securedAsset(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(browserSecurityHeaders)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

function commandAckId(pathname) {
  const match = pathname.match(/^\/v1\/commands\/([^/]+)\/ack$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

async function handleCommandAck(request, store, url, commandId) {
  const projectId = url.searchParams.get('projectId') || '';
  await requireProject(request, store, projectId, 'commands.ack');
  const body = await readJson(request);
  if (!ID_PATTERN.test(body.runtimeId || '')) throw Object.assign(new Error('invalid_runtime_id'), { status: 400 });
  if (!['completed', 'failed'].includes(body.status)) throw Object.assign(new Error('invalid_command_status'), { status: 400 });
  const acknowledged = await store.acknowledgeCommand(projectId, commandId, body.runtimeId, body.status, body.result || {}, String(body.error || '').slice(0, 500));
  if (!acknowledged) return json({ ok: false, error: 'command_ack_conflict' }, 409);
  return json({ ok: true, commandId, status: body.status });
}

async function handleEventPost(request, env, store, url) {
  const event = validateEvent(await readJson(request));
  const projectId = event.context.projectId;
  const queryProjectId = url.searchParams.get('projectId') || '';
  if (queryProjectId && queryProjectId !== projectId) throw Object.assign(new Error('project_id_mismatch'), { status: 400 });
  const project = await requireProject(request, store, projectId, 'events.write');
  const headers = corsHeaders(request.headers.get('origin') || '', project);
  const limit = Math.max(1, Number(env.MOTK_RATE_LIMIT_PER_MINUTE || 120));
  const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  if (!(await store.consumeRate(projectId, windowStart, limit))) return json({ ok: false, error: 'rate_limited' }, 429, { ...headers, 'retry-after': '60' });
  const result = await store.insertEvent({ eventId: await eventId(event), projectId, event: event.event, occurredAt: new Date(event.occurredAt).toISOString(), payload: event });
  let delivery = 'not_applicable';
  const adapter = googleSheetsAdapterFromEnv(env);
  if (result.inserted && (adapter?.supports(event.event) || ['motk.job:status', 'motk.runtime:status', 'motk.version:registered'].includes(event.event))) {
    await store.queueDelivery(result.eventId, projectId);
    delivery = 'pending';
    if (adapter) {
      try { await adapter.writeEvent(project.spreadsheetRef, event); await store.markDelivery(result.eventId, 'delivered'); delivery = 'delivered'; }
      catch (error) { await store.markDelivery(result.eventId, 'failed', String(error.message || error).slice(0, 500)); delivery = 'pending'; }
    }
  }
  return json({ ok: true, accepted: true, duplicate: !result.inserted, eventId: result.eventId, delivery }, result.inserted ? 202 : 200, headers);
}

export async function processPendingDeliveries(env, limit = 25) {
  const store = env.CONTROL_STORE || (env.CONTROL_DB ? new D1ControlStore(env.CONTROL_DB) : null);
  const adapter = googleSheetsAdapterFromEnv(env);
  if (!store || !adapter) return { ok: false, processed: 0, delivered: 0, failed: 0, error: !store ? 'storage_not_configured' : 'google_not_configured' };
  const pending = await store.pendingDeliveries(Math.max(1, Math.min(100, Number(limit || 25))));
  let delivered = 0; let failed = 0;
  for (const item of pending) {
    try { await adapter.writeEvent(item.project.spreadsheetRef, item.event); await store.markDelivery(item.eventId, 'delivered'); delivered += 1; }
    catch (error) { await store.markDelivery(item.eventId, 'failed', String(error.message || error).slice(0, 500)); failed += 1; }
  }
  return { ok: failed === 0, processed: pending.length, delivered, failed };
}

async function handleEventList(request, store, url) {
  const projectId = url.searchParams.get('projectId') || '';
  const project = await requireProject(request, store, projectId, 'events.read');
  const headers = corsHeaders(request.headers.get('origin') || '', project);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 25)));
  return json({ ok: true, projectId, events: await store.listEvents(projectId, limit) }, 200, headers);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const store = env.CONTROL_STORE || (env.CONTROL_DB ? new D1ControlStore(env.CONTROL_DB) : null);
  try {
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: SERVICE, version: VERSION, environment: env.MOTK_ENVIRONMENT || 'development', writes_enabled: Boolean(store) });
    if (env.ASSETS && request.method === 'GET' && !url.pathname.startsWith('/v1/')) return securedAsset(request, env);
    if (!store) return json({ ok: false, error: 'storage_not_configured', accepted: false }, 503);
    const projectId = projectIdFromPath(url.pathname);
    const tokenProjectId = rotatedProjectId(url.pathname);
    const issueProjectId = tokenIssueProjectId(url.pathname);
    if (request.method === 'POST' && issueProjectId) return await handleTokenIssue(request, env, store, issueProjectId);
    if (request.method === 'POST' && tokenProjectId) return await handleTokenRotation(request, env, store, tokenProjectId);
    if (request.method === 'PUT' && projectId) return await handleProjectPut(request, env, store, projectId);
    if (request.method === 'PATCH' && projectId) return await handleProjectPatch(request, env, store, projectId);
    if (request.method === 'GET' && projectId) {
      const project = await requireProject(request, store, projectId, 'project.read');
      return json({ ok: true, project });
    }
    if (request.method === 'OPTIONS' && url.pathname === '/v1/events') {
      const preflightProjectId = url.searchParams.get('projectId') || '';
      if (!ID_PATTERN.test(preflightProjectId)) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
      const project = await store.project(preflightProjectId);
      if (!project?.active) throw Object.assign(new Error('project_not_found'), { status: 404 });
      return corsPreflight(request.headers.get('origin') || '', project);
    }
    if (request.method === 'POST' && url.pathname === '/v1/events') return await handleEventPost(request, env, store, url);
    if (request.method === 'GET' && url.pathname === '/v1/events') return await handleEventList(request, store, url);
    if (request.method === 'OPTIONS' && url.pathname === '/v1/commands') {
      const preflightProjectId = url.searchParams.get('projectId') || '';
      if (!ID_PATTERN.test(preflightProjectId)) throw Object.assign(new Error('invalid_project_id'), { status: 400 });
      const project = await store.project(preflightProjectId);
      if (!project?.active) throw Object.assign(new Error('project_not_found'), { status: 404 });
      return corsPreflight(request.headers.get('origin') || '', project);
    }
    if (request.method === 'POST' && url.pathname === '/v1/commands') return await handleCommandPost(request, store, url);
    if (request.method === 'GET' && url.pathname === '/v1/commands') return await handleCommandList(request, store, url);
    if (request.method === 'POST' && url.pathname === '/v1/commands/claim') return await handleCommandClaim(request, store, url, env);
    const ackId = commandAckId(url.pathname);
    if (request.method === 'POST' && ackId) return await handleCommandAck(request, store, url, ackId);
    if (request.method === 'POST' && url.pathname === '/v1/deliveries/retry') {
      if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      const result = await processPendingDeliveries(env, url.searchParams.get('limit') || 25);
      return json(result, result.ok ? 200 : 503);
    }
    if (request.method === 'GET' && url.pathname === '/v1/audit') {
      const auditProjectId = url.searchParams.get('projectId') || '';
      if (auditProjectId && !ID_PATTERN.test(auditProjectId)) return json({ ok: false, error: 'invalid_project_id' }, 400);
      if (!adminAuthorized(request, env)) {
        if (!auditProjectId) return json({ ok: false, error: 'project_id_required' }, 400);
        await requireProject(request, store, auditProjectId, 'admin.audit');
      }
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
      return json({ ok: true, audit: await store.listAudit(auditProjectId, limit) });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    return json({ ok: false, error: error.message || 'internal_error' }, error.status || 500);
  }
}

export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) { context.waitUntil(processPendingDeliveries(env)); },
};
