// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const endpoint = String(process.env.MOTK_REMOTE_ENDPOINT || '').replace(/\/$/, '');
const adminToken = String(process.env.MOTK_REMOTE_ADMIN_TOKEN || '');
const prefix = String(process.env.MOTK_REMOTE_LOAD_PREFIX || 'motk_load_acceptance');
const projectCount = Math.min(20, Math.max(2, Number(process.env.MOTK_REMOTE_LOAD_PROJECTS || 5)));
const eventsPerProject = Math.min(100, Math.max(1, Number(process.env.MOTK_REMOTE_LOAD_EVENTS || 20)));
if (!endpoint || adminToken.length < 32) throw new Error('remote endpoint and admin token are required');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(prefix)) throw new Error('remote load prefix is invalid');

const token = () => randomBytes(48).toString('base64url');
const auth = (value) => ({ authorization: `Bearer ${value}`, 'content-type': 'application/json' });
const request = async (path, options = {}) => {
  const response = await fetch(`${endpoint}${path}`, options);
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
};
const runId = Date.now().toString(36);
const projects = Array.from({ length: projectCount }, (_, index) => ({ id: `${prefix}_${runId}_${index + 1}`, token: token() }));

const adminPreflight = await request('/v1/audit?limit=1', { headers: auth(adminToken) });
assert.equal(adminPreflight.response.status, 200, 'remote admin preflight failed');

for (const [index, project] of projects.entries()) {
  const { response } = await request(`/v1/projects/${project.id}`, { method: 'PUT', headers: auth(adminToken), body: JSON.stringify({ spreadsheetRef: `disposable-${project.id}`, token: project.token, allowedOrigins: [] }) });
  assert.equal(response.status, 201, `project provisioning failed at index ${index}`);
}

const startedAt = performance.now();
await Promise.all(projects.map(async (project, projectIndex) => {
  await Promise.all(Array.from({ length: eventsPerProject }, async (_, sequence) => {
    const event = { type: 'event', event: 'motk.load:test', context: { projectId: project.id }, data: { sequence, owner: project.id }, occurredAt: new Date(Date.UTC(2026, 6, 13, 14, sequence, projectIndex)).toISOString() };
    const { response } = await request('/v1/events', { method: 'POST', headers: auth(project.token), body: JSON.stringify(event) });
    assert.equal(response.status, 202);
  }));
}));
const elapsedMs = Math.round(performance.now() - startedAt);

let crossProjectRejections = 0;
for (let index = 0; index < projects.length; index += 1) {
  const project = projects[index];
  const listed = await request(`/v1/events?projectId=${project.id}&limit=100`, { headers: auth(project.token) });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.events.length, eventsPerProject);
  assert.ok(listed.body.events.every((event) => event.payload.context.projectId === project.id && event.payload.data.owner === project.id));
  const other = projects[(index + 1) % projects.length];
  const cross = await request(`/v1/events?projectId=${other.id}&limit=1`, { headers: auth(project.token) });
  assert.equal(cross.response.status, 401);
  crossProjectRejections += 1;
}

console.log(JSON.stringify({ ok: true, prefix, projects: projectCount, events: projectCount * eventsPerProject, crossProjectRejections, elapsedMs }));
