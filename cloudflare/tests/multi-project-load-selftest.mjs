// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/worker.mjs';
import { MemoryControlStore } from '../src/store.mjs';

const base = 'https://control.example.test';
const adminToken = 'load-admin-token-with-at-least-thirty-two-characters';
const auth = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('20 projects remain isolated through 800 concurrent control events', async () => {
  const store = new MemoryControlStore();
  const env = { CONTROL_STORE: store, CONTROL_PLANE_ADMIN_TOKEN: adminToken, MOTK_ENVIRONMENT: 'load-test', MOTK_RATE_LIMIT_PER_MINUTE: '1000' };
  const projects = Array.from({ length: 20 }, (_, index) => ({
    id: `load_project_${String(index + 1).padStart(2, '0')}`,
    token: `load-project-${String(index + 1).padStart(2, '0')}-token-with-at-least-thirty-two-characters`,
  }));

  for (const project of projects) {
    const response = await handleRequest(new Request(`${base}/v1/projects/${project.id}`, { method: 'PUT', headers: auth(adminToken), body: JSON.stringify({ spreadsheetRef: `spreadsheet-${project.id}`, token: project.token, allowedOrigins: [] }) }), env);
    assert.equal(response.status, 201);
  }

  const startedAt = performance.now();
  await Promise.all(projects.map(async (project) => {
    for (let sequence = 0; sequence < 40; sequence += 1) {
      const occurredAt = new Date(Date.UTC(2026, 6, 13, 12, sequence, Number(project.id.slice(-2)))).toISOString();
      const event = { type: 'event', event: 'motk.load:test', context: { projectId: project.id }, data: { sequence, owner: project.id }, occurredAt };
      const response = await handleRequest(new Request(`${base}/v1/events`, { method: 'POST', headers: auth(project.token), body: JSON.stringify(event) }), env);
      assert.equal(response.status, 202);
    }
  }));
  const elapsedMs = Math.round(performance.now() - startedAt);

  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    const listed = await handleRequest(new Request(`${base}/v1/events?projectId=${project.id}&limit=100`, { headers: auth(project.token) }), env);
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.events.length, 40);
    assert.ok(body.events.every((event) => event.payload.context.projectId === project.id && event.payload.data.owner === project.id));
    const other = projects[(index + 1) % projects.length];
    const crossProject = await handleRequest(new Request(`${base}/v1/events?projectId=${other.id}&limit=1`, { headers: auth(project.token) }), env);
    assert.equal(crossProject.status, 401);
  }

  assert.equal(store.events.size, 800);
  console.log(JSON.stringify({ projects: projects.length, events: store.events.size, crossProjectRejections: projects.length, elapsedMs }));
});
