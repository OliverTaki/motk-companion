// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, loadRecipes } from './cap-runner.mjs';

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export class ControlLoop {
  constructor(options) {
    this.endpoint = String(options.endpoint || '').replace(/\/$/, '');
    this.projectId = String(options.projectId || '');
    this.token = String(options.token || '');
    this.runtimeId = String(options.runtimeId || `companion-${hostname()}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    this.runner = options.runner;
    this.fetch = options.fetch || globalThis.fetch;
    this.pollMs = Math.max(500, Number(options.pollMs || 2000));
    this.stopped = false;
    if (!this.endpoint || !this.projectId || !this.token || !this.runner) throw new Error('control loop configuration is incomplete');
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.endpoint}${path}`, { ...options, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(options.headers || {}) } });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body?.ok) throw new Error(body?.error || `control_plane_http_${response.status}`);
    return body;
  }

  async execute(command) {
    if (command.action === 'runner.run') return this.runner.handleMessage({ cmd: 'runner.run', recipe: command.payload.recipe, context: command.context, dryRun: Boolean(command.payload.dryRun) });
    if (command.action === 'runner.gate.approve') return this.runner.handleMessage({ cmd: 'runner.gate.approve', key: command.payload.key });
    if (command.action === 'runner.resume') return this.runner.resumeAll();
    throw new Error(`unsupported control command: ${command.action}`);
  }

  async pollOnce() {
    const query = new URLSearchParams({ projectId: this.projectId, runtimeId: this.runtimeId });
    const claimed = await this.request(`/v1/commands/claim?${query}`, { method: 'POST', body: '{}' });
    if (!claimed.command) return { claimed: false };
    const command = claimed.command;
    let status = 'completed'; let result = {}; let error = '';
    try { result = await this.execute(command); }
    catch (executionError) { status = 'failed'; error = String(executionError.message || executionError).slice(0, 500); }
    const ackQuery = new URLSearchParams({ projectId: this.projectId });
    await this.request(`/v1/commands/${encodeURIComponent(command.commandId)}/ack?${ackQuery}`, { method: 'POST', body: JSON.stringify({ runtimeId: this.runtimeId, status, result, error }) });
    return { claimed: true, commandId: command.commandId, status, result, error };
  }

  stop() { this.stopped = true; }
  async run() {
    while (!this.stopped) {
      try { await this.pollOnce(); }
      catch (error) { process.stderr.write(`[control] ${String(error.message || error)}\n`); }
      if (!this.stopped) await wait(this.pollMs);
    }
  }
}

function buildFromConfig(configPath) {
  const absoluteConfig = resolve(configPath);
  if (!existsSync(absoluteConfig)) throw new Error(`configuration not found: ${absoluteConfig}`);
  const config = JSON.parse(readFileSync(absoluteConfig, 'utf8').replace(/^\uFEFF/, ''));
  const base = dirname(absoluteConfig);
  const local = (value, fallback) => resolve(isAbsolute(value || '') ? value : join(base, value || fallback));
  const uploadTargets = Object.fromEntries(Object.entries(config.uploadTargets || {}).map(([name, target]) => [name, target.type === 'fs' ? { ...target, root: local(target.root, './uploads') } : target]));
  const runner = new Runner({
    productionRoot: local(config.productionRoot, './production'),
    storePath: local(config.jobStore, './state/jobs.jsonl'),
    recipes: loadRecipes(local(config.recipesDir, join(appRoot, 'recipes'))),
    ffmpeg: config.ffmpeg || 'ffmpeg', cliCommands: config.cliCommands || {}, uploadTargets,
    motkEndpoint: config.motkEndpoint || '', motkToken: config.motkToken || '',
    controlPlaneEndpoint: config.controlPlaneEndpoint || '', controlPlaneToken: config.controlPlaneToken || '',
    onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  return new ControlLoop({ endpoint: config.controlPlaneEndpoint, projectId: config.projectId, token: config.controlPlaneToken, runtimeId: config.runtimeId, pollMs: config.controlPlanePollMs, runner });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--config');
  const configPath = at >= 0 ? process.argv[at + 1] : join(appRoot, 'companion.json');
  const loop = buildFromConfig(configPath);
  process.stdout.write(`[control] ready project=${loop.projectId} runtime=${loop.runtimeId}\n`);
  const stop = () => loop.stop();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await loop.run();
}
