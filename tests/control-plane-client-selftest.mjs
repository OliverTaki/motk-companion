// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runner } from '../cap-runner.mjs';
import { handleRequest } from '../cloudflare/src/worker.mjs';
import { MemoryControlStore } from '../cloudflare/src/store.mjs';

const adminToken = 'admin-test-token';
const projectToken = 'runner-project-token-with-thirty-two-characters';

test('Runner sends canonical project-scoped events to the durable control plane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'motk-control-client-'));
  try {
    mkdirSync(join(root, 'production'));
    const store = new MemoryControlStore();
    const env = { CONTROL_STORE: store, CONTROL_PLANE_ADMIN_TOKEN: adminToken, MOTK_ENVIRONMENT: 'test' };
    const controlFetch = (input, init) => handleRequest(input instanceof Request ? input : new Request(input, init), env);
    const provision = await controlFetch('https://control.test/v1/projects/project_a', {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ spreadsheetRef: 'sheet-project-a', token: projectToken, allowedOrigins: [] }),
    });
    assert.equal(provision.status, 201);

    const runner = new Runner({
      productionRoot: join(root, 'production'),
      storePath: join(root, 'state', 'jobs.jsonl'),
      controlPlaneEndpoint: 'https://control.test',
      controlPlaneToken: projectToken,
      controlPlaneFetch: controlFetch,
    });
    const recipe = { recipe: 'control-plane-register', version: 1, steps: [{ id: 'register', uses: 'motk.version.register', with: { data: { version_id: 'version_001', status: 'ready' } } }] };
    const result = await runner.run(recipe, { projectId: 'project_a', shotId: 'shot_001', take: 1 });
    assert.equal(result.status, 'completed');

    const listed = await controlFetch('https://control.test/v1/events?projectId=project_a', { headers: { authorization: `Bearer ${projectToken}` } });
    const body = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].event, 'motk.version:registered');
    assert.equal(body.events[0].payload.context.shotId, 'shot_001');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
