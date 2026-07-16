// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlLoop } from '../cap-control.mjs';
import { Runner } from '../cap-runner.mjs';
import { handleRequest } from '../cloudflare/src/worker.mjs';
import { MemoryControlStore } from '../cloudflare/src/store.mjs';

const adminToken = 'admin-control-test-token';
const companionToken = 'companion-command-token-with-thirty-two-characters';
const operatorToken = 'operator-command-token-with-thirty-two-characters';

test('Production command is claimed, executed by Runner, acknowledged, and project isolated', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'motk-control-loop-'));
  try {
    const store = new MemoryControlStore();
    const env = { CONTROL_STORE: store, CONTROL_PLANE_ADMIN_TOKEN: adminToken, MOTK_ENVIRONMENT: 'test' };
    const workerFetch = (input, init) => handleRequest(input instanceof Request ? input : new Request(input, init), env);
    const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    const provision = await workerFetch('https://control.test/v1/projects/project_a', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ spreadsheetRef: 'abcdefghij123456', token: companionToken, allowedOrigins: [] }) });
    assert.equal(provision.status, 201);
    const productionScopes = ['commands.write', 'events.read', 'project.read', 'production.recipe_run', 'production.proxy_generate'];
    const issued = await workerFetch('https://control.test/v1/projects/project_a/tokens', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ token: operatorToken, label: 'Production operator', scopes: productionScopes }) });
    assert.equal(issued.status, 201);

    const recipe = 'production-proxy';
    const firstContext = { projectId: 'project_a', shotId: 'shot_001', take: 1 };
    const previewResponse = await workerFetch('https://control.test/v1/commands?projectId=project_a', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'runner.run', context: firstContext, payload: { recipe, dryRun: true }, idempotencyKey: 'production-proxy-preview-shot_001-take_1' }),
    });
    assert.equal(previewResponse.status, 202);
    const previewId = (await previewResponse.json()).commandId;

    const runner = new Runner({ productionRoot: temp, storePath: join(temp, 'jobs.jsonl'), recipes: [{ recipe, version: 1, steps: [{ id: 'notify', uses: 'bridge.cmd', with: { action: 'test' } }] }] });
    const loop = new ControlLoop({ endpoint: 'https://control.test', projectId: 'project_a', token: companionToken, runtimeId: 'runtime_test', runner, capabilities: ['production.recipe_run', 'production.proxy_generate'], fetch: workerFetch, pollMs: 500 });
    const previewed = await loop.pollOnce();
    assert.equal(previewed.status, 'completed');
    assert.equal(previewed.result.dryRun, true);

    const commandResponse = await workerFetch('https://control.test/v1/commands?projectId=project_a', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'runner.run', context: firstContext, payload: { recipe, dryRunCommandId: previewId }, idempotencyKey: 'production-proxy-shot_001-take_1' }),
    });
    assert.equal(commandResponse.status, 202);

    const executed = await loop.pollOnce();
    assert.equal(executed.status, 'completed');

    const listed = await workerFetch('https://control.test/v1/commands?projectId=project_a', { headers: { authorization: `Bearer ${operatorToken}` } });
    const body = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(body.commands.length, 2);
    assert.ok(body.commands.every((command) => command.status === 'completed'));
    assert.ok(body.commands.every((command) => command.runtimeId === 'runtime_test'));

    const duplicate = await workerFetch('https://control.test/v1/commands?projectId=project_a', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'runner.run', context: firstContext, payload: { recipe, dryRunCommandId: previewId }, idempotencyKey: 'production-proxy-shot_001-take_1' }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);

    const secondContext = { projectId: 'project_a', shotId: 'shot_002', take: 1 };
    const secondPreview = await workerFetch('https://control.test/v1/commands?projectId=project_a', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'runner.run', context: secondContext, payload: { recipe, dryRun: true }, idempotencyKey: 'production-proxy-preview-shot_002-take_1' }),
    });
    assert.equal(secondPreview.status, 202);
    const secondPreviewId = (await secondPreview.json()).commandId;
    assert.equal((await loop.pollOnce()).status, 'completed');

    const second = await workerFetch('https://control.test/v1/commands?projectId=project_a', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'runner.run', context: secondContext, payload: { recipe, dryRunCommandId: secondPreviewId }, idempotencyKey: 'production-proxy-shot_002-take_1' }),
    });
    assert.equal(second.status, 202);
    const secondId = (await second.json()).commandId;
    await store.claimCommand('project_a', 'dead_runtime');
    store.commands.get(secondId).claimedAt = '2000-01-01T00:00:00Z';
    const recovered = await loop.pollOnce();
    assert.equal(recovered.status, 'completed');
    assert.equal(store.commands.get(secondId).runtimeId, 'runtime_test');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
