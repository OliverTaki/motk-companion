// SPDX-License-Identifier: GPL-3.0-or-later
import { validateEventEnvelope } from './contracts.mjs';

export async function postCoarseStatus(endpoint, action, data, options = {}) {
  if (!['version.register', 'job.status', 'runtime.status'].includes(action)) throw new Error(`unsupported MOTK action: ${action}`);
  const payload = { action, data, ...(options.token ? { token: options.token } : {}) };
  const response = await (options.fetch || globalThis.fetch)(endpoint, {
    method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`MOTK endpoint HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || 'MOTK endpoint rejected request');
  return result;
}

export async function postControlEvent(endpoint, event, context, data = {}, options = {}) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('control-plane endpoint is required');
  if (typeof options.token !== 'string' || !options.token) throw new Error('control-plane token is required');
  const payload = validateEventEnvelope({ type: 'event', event, context, data, occurredAt: options.occurredAt || new Date().toISOString() });
  const url = new URL(`${endpoint.replace(/\/$/, '')}/v1/events`);
  url.searchParams.set('projectId', payload.context.projectId);
  const response = await (options.fetch || globalThis.fetch)(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) throw new Error(result?.error || `control-plane HTTP ${response.status}`);
  if (!result?.ok) throw new Error(result?.error || 'control-plane rejected event');
  return result;
}
