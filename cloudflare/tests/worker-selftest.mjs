// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleRequest, processPendingDeliveries } from '../src/worker.mjs';
import { MemoryControlStore } from '../src/store.mjs';

const projectToken = 'project-token-with-at-least-thirty-two-characters';
const otherToken = 'other-project-token-with-thirty-two-characters';
const baseEnv = { CONTROL_PLANE_ADMIN_TOKEN: 'admin-test-token', MOTK_ENVIRONMENT: 'test', MOTK_RATE_LIMIT_PER_MINUTE: '2' };
const request = (path, options = {}) => new Request(`https://control.example.test${path}`, options);
const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });
const event = (projectId, data = { status: 'online' }) => ({ type: 'event', event: 'motk.runtime:status', context: { projectId }, data, occurredAt: '2026-07-13T00:00:00Z' });

async function provision(store, projectId, token, allowedOrigins = []) {
  const response = await handleRequest(request(`/v1/projects/${projectId}`, { method: 'PUT', headers: auth('admin-test-token'), body: JSON.stringify({ spreadsheetRef: `sheet-${projectId}`, token, allowedOrigins }) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(response.status, 201);
}

test('health distinguishes safe refusal from durable storage', async () => {
  const withoutStore = await handleRequest(request('/health'), baseEnv);
  assert.equal((await withoutStore.json()).writes_enabled, false);
  const withStore = await handleRequest(request('/health'), { ...baseEnv, CONTROL_STORE: new MemoryControlStore() });
  assert.equal((await withStore.json()).writes_enabled, true);
});

test('project provisioning requires the control-plane admin token', async () => {
  const response = await handleRequest(request('/v1/projects/project_a', { method: 'PUT', headers: auth('wrong'), body: JSON.stringify({ spreadsheetRef: 'sheet-a', token: projectToken }) }), { ...baseEnv, CONTROL_STORE: new MemoryControlStore() });
  assert.equal(response.status, 401);
});

test('project token rotation revokes the old token and records a secret-free audit event', async () => {
  const store = new MemoryControlStore();
  await provision(store, 'project_a', projectToken);
  const newToken = 'replacement-project-token-with-thirty-two-characters';
  const rotated = await handleRequest(request('/v1/projects/project_a/tokens/rotate', { method: 'POST', headers: auth('admin-test-token'), body: JSON.stringify({ token: newToken }) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(rotated.status, 200);
  const oldResponse = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a')) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(oldResponse.status, 401);
  const newResponse = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(newToken), body: JSON.stringify(event('project_a')) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(newResponse.status, 202);
  const auditResponse = await handleRequest(request('/v1/audit?projectId=project_a', { headers: auth('admin-test-token') }), { ...baseEnv, CONTROL_STORE: store });
  const auditBody = await auditResponse.json();
  assert.equal(auditResponse.status, 200);
  assert.equal(auditBody.audit[0].action, 'project.token.rotate');
  assert.doesNotMatch(JSON.stringify(auditBody), new RegExp(newToken));
});

test('project Admin tokens update only their project, issue limited keys, and read scoped audit', async () => {
  const store = new MemoryControlStore();
  await provision(store, 'project_a', projectToken);
  await provision(store, 'project_b', otherToken);
  const env = { ...baseEnv, CONTROL_STORE: store };
  const projectAdminToken = 'project-admin-token-with-thirty-two-characters';
  const issuedAdmin = await handleRequest(request('/v1/projects/project_a/tokens', { method: 'POST', headers: auth('admin-test-token'), body: JSON.stringify({ token: projectAdminToken, label: 'Project administrator', scopes: ['project.read', 'admin.project', 'admin.tokens', 'admin.audit'] }) }), env);
  assert.equal(issuedAdmin.status, 201);

  const updated = await handleRequest(request('/v1/projects/project_a', { method: 'PATCH', headers: auth(projectAdminToken), body: JSON.stringify({ spreadsheetRef: 'sheet-project-a-next', allowedOrigins: ['https://production.example.test'] }) }), env);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).project.spreadsheetRef, 'sheet-project-a-next');
  const crossProject = await handleRequest(request('/v1/projects/project_b', { method: 'PATCH', headers: auth(projectAdminToken), body: JSON.stringify({ spreadsheetRef: 'forbidden' }) }), env);
  assert.equal(crossProject.status, 401);

  const operatorToken = 'admin-created-operator-token-thirty-two-characters';
  const issuedOperator = await handleRequest(request('/v1/projects/project_a/tokens', { method: 'POST', headers: auth(projectAdminToken), body: JSON.stringify({ token: operatorToken, label: 'Production operator', scopes: ['commands.write', 'events.read', 'project.read'] }) }), env);
  assert.equal(issuedOperator.status, 201);
  const auditResponse = await handleRequest(request('/v1/audit?projectId=project_a', { headers: auth(projectAdminToken) }), env);
  const auditBody = await auditResponse.json();
  assert.equal(auditResponse.status, 200);
  assert.ok(auditBody.audit.some((entry) => entry.action === 'project.update'));
  assert.ok(auditBody.audit.some((entry) => entry.action === 'project.token.issue'));
  assert.doesNotMatch(JSON.stringify(auditBody), new RegExp(operatorToken));
});

test('project tokens are scoped and browser origins are exact', async () => {
  const store = new MemoryControlStore();
  await provision(store, 'project_a', projectToken, ['https://shoot.example.test']);
  await provision(store, 'project_b', otherToken);

  const crossProject = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(otherToken), body: JSON.stringify(event('project_a')) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(crossProject.status, 401);

  const badOrigin = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken, { origin: 'https://untrusted.example' }), body: JSON.stringify(event('project_a')) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(badOrigin.status, 403);

  const accepted = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken, { origin: 'https://shoot.example.test' }), body: JSON.stringify(event('project_a')) }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://shoot.example.test');

  const preflight = await handleRequest(request('/v1/events?projectId=project_a', { method: 'OPTIONS', headers: { origin: 'https://shoot.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } }), { ...baseEnv, CONTROL_STORE: store });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://shoot.example.test');
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
});

test('event writes are idempotent, readable, and rate limited per project', async () => {
  const store = new MemoryControlStore();
  await provision(store, 'project_a', projectToken);
  const env = { ...baseEnv, CONTROL_STORE: store };

  const first = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a')) }), env);
  assert.equal(first.status, 202);
  const duplicate = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a')) }), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const limited = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a', { status: 'busy' })) }), env);
  assert.equal(limited.status, 429);

  const listed = await handleRequest(request('/v1/events?projectId=project_a&limit=10', { headers: auth(projectToken) }), env);
  const body = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].event, 'motk.runtime:status');
});

test('Google write-through failures stay durable and succeed on retry', async () => {
  const store = new MemoryControlStore();
  await provision(store, 'project_a', projectToken);
  let attempts = 0;
  const adapter = {
    supports: () => true,
    async writeEvent() { attempts += 1; if (attempts === 1) throw new Error('temporary_google_failure'); return { sheet: 'Jobs' }; },
  };
  const env = { ...baseEnv, CONTROL_STORE: store, GOOGLE_SHEETS_ADAPTER: adapter };
  const response = await handleRequest(request('/v1/events?projectId=project_a', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a')) }), env);
  const accepted = await response.json();
  assert.equal(response.status, 202);
  assert.equal(accepted.delivery, 'pending');
  assert.equal(store.events.size, 1);
  const delivery = store.deliveries.get(accepted.eventId);
  assert.equal(delivery.status, 'failed');
  delivery.nextAttemptAt = '2000-01-01T00:00:00Z';
  const retried = await processPendingDeliveries(env);
  assert.deepEqual(retried, { ok: true, processed: 1, delivered: 1, failed: 0 });
  assert.equal(store.deliveries.get(accepted.eventId).status, 'delivered');
});

test('storage-disabled deployments refuse writes and migration defines the D1 boundary', async () => {
  const response = await handleRequest(request('/v1/events', { method: 'POST', headers: auth(projectToken), body: JSON.stringify(event('project_a')) }), baseEnv);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'storage_not_configured');

  const here = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(here, '..', 'migrations', '0001_control_plane.sql'), 'utf8');
  for (const table of ['projects', 'project_tokens', 'events', 'commands', 'event_deliveries', 'rate_windows', 'audit_log']) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test('unknown routes return a hardened JSON 404', async () => {
  const response = await handleRequest(request('/missing'), { ...baseEnv, CONTROL_STORE: new MemoryControlStore() });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal((await response.json()).error, 'not_found');
});
