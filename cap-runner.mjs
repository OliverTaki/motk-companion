// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNewFile, sandboxResolve } from './lib/safe-fs.mjs';
import { encodeJob } from './cap-encode.mjs';
import { JournalJobStore } from './lib/job-store.mjs';
import { Uploader } from './cap-uploader.mjs';
import { postCoarseStatus, postControlEvent } from './lib/motk-client.mjs';
import { normalizeIdentity } from './lib/contracts.mjs';

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function formatValue(value, format) {
  if (!format) return String(value ?? '');
  const width = Number(format);
  return Number.isFinite(width) ? String(value ?? '').padStart(width, '0') : String(value ?? '');
}
function expand(value, context, artifacts) {
  if (typeof value === 'string') return value.replace(/\{([A-Za-z0-9_.]+)(?::(\d+))?\}/g, (_match, path, format) => {
    const roots = { ...context, ...artifacts };
    const resolved = path.split('.').reduce((item, key) => item?.[key], roots);
    if (resolved === undefined) throw new Error(`unknown recipe placeholder: ${path}`);
    return formatValue(resolved, format);
  });
  if (Array.isArray(value)) return value.map((item) => expand(item, context, artifacts));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, context, artifacts)]));
  return value;
}

function recipeRunKey(recipe, context) {
  return sha(JSON.stringify([context.projectId || '', context.shotId || '', context.take || '', context.versionId || '', recipe.recipe, recipe.version]));
}
function stepKey(recipe, context, step) {
  return sha(JSON.stringify([context.projectId || '', context.shotId || '', context.take || '', context.versionId || '', recipe.recipe, recipe.version, step.id]));
}

export class Runner {
  constructor(options) {
    this.productionRoot = resolve(options.productionRoot);
    this.store = options.store || new JournalJobStore(options.storePath);
    this.ffmpeg = options.ffmpeg || 'ffmpeg';
    this.recipes = options.recipes || [];
    this.cliCommands = options.cliCommands || {};
    this.onEvent = options.onEvent || (() => {});
    this.afterStep = options.afterStep;
    this.stubExternal = Boolean(options.stubExternal);
    this.uploader = options.uploader || (options.uploadTargets ? new Uploader({ productionRoot: this.productionRoot, store: this.store, targets: options.uploadTargets, onEvent: this.onEvent }) : null);
    this.motkEndpoint = options.motkEndpoint || '';
    this.motkToken = options.motkToken || '';
    this.controlPlaneEndpoint = options.controlPlaneEndpoint || '';
    this.controlPlaneToken = options.controlPlaneToken || '';
    this.controlPlaneFetch = options.controlPlaneFetch;
    this.assemblyHandler = options.assemblyHandler;
  }

  recipesForEvent(event) { return this.recipes.filter((recipe) => recipe.on?.event === event); }

  async handleMessage(message) {
    if (message.type === 'event') return this.handleEvent(message.event, message.data || {});
    if (message.cmd === 'runner.run') {
      const recipe = this.recipes.find((item) => item.recipe === message.recipe);
      if (!recipe) throw new Error(`recipe not found: ${message.recipe}`);
      return this.run(recipe, message.context || {}, { dryRun: Boolean(message.dryRun) });
    }
    if (message.cmd === 'runner.gate.approve') return this.approveGate(message.key);
    throw new Error('unsupported runner message');
  }

  async handleEvent(event, context) {
    const results = [];
    for (const recipe of this.recipesForEvent(event)) results.push(await this.run(recipe, context));
    return results;
  }

  async resumeAll() {
    const results = [];
    for (const record of this.store.values().filter((item) => item.type === 'recipe' && item.status === 'running')) {
      const recipe = this.recipes.find((item) => item.recipe === record.recipe && item.version === record.recipeVersion);
      if (recipe) results.push(await this.run(recipe, record.context, { resume: true }));
    }
    return results;
  }

  async approveGate(key) {
    const record = this.store.get(key);
    if (!record || record.status !== 'waiting_gate') throw new Error('waiting gate not found');
    this.store.put({ ...record, status: 'running', gateApproved: true });
    const recipe = this.recipes.find((item) => item.recipe === record.recipe && item.version === record.recipeVersion);
    return this.run(recipe, record.context, { resume: true });
  }

  async run(recipe, context, options = {}) {
    context = { ...context, ...normalizeIdentity(context) };
    const takeName = `T${String(Math.max(1, Number(context.take) || 1)).padStart(2, '0')}`;
    context.takeFolder = context.takeFolder || join(context.shotId || 'PROJECT', takeName);
    context.framesFolder = context.framesFolder || join(context.takeFolder, 'frames');
    const key = recipeRunKey(recipe, context);
    if (!options.dryRun && this.store.get(key)?.status === 'completed') return { ...this.store.get(key), noop: true };
    const state = options.dryRun ? null : this.store.get(key);
    const artifacts = { ...(state?.artifacts || {}) };
    const report = { recipe: recipe.recipe, dryRun: Boolean(options.dryRun), files: [], bytes: 0, collisions: [] };
    const completed = new Set(state?.completedSteps || []);
    if (!options.dryRun) this.store.put({ key, type: 'recipe', status: 'running', recipe: recipe.recipe, recipeVersion: recipe.version, context, completedSteps: [...completed], artifacts });
    for (const step of recipe.steps) {
      if (completed.has(step.id)) continue;
      for (const dependency of step.needs || []) if (!completed.has(dependency)) throw new Error(`step ${step.id} needs incomplete step ${dependency}`);
      const input = expand(step.with || {}, context, artifacts);
      if (options.dryRun) {
        await this.dryRunStep(step, input, context, artifacts, report);
        completed.add(step.id);
        continue;
      }
      const retries = Number.isInteger(step.retries) ? step.retries : 2;
      let artifact;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try { artifact = await this.executeStep(recipe, step, input, context, artifacts, key); break; }
        catch (error) {
          if (attempt === retries) {
            this.store.put({ key, type: 'recipe', status: 'failed', recipe: recipe.recipe, recipeVersion: recipe.version, context, completedSteps: [...completed], artifacts, error: error.message });
            throw error;
          }
          await wait(Math.min(2000, 100 * (2 ** attempt)));
        }
      }
      if (artifact?.waitingGate) {
        return this.store.put({ key, type: 'recipe', status: 'waiting_gate', recipe: recipe.recipe, recipeVersion: recipe.version, context, completedSteps: [...completed], artifacts, gateStep: step.id });
      }
      artifacts[step.id] = artifact || {};
      completed.add(step.id);
      this.store.put({ key, type: 'recipe', status: 'running', recipe: recipe.recipe, recipeVersion: recipe.version, context, completedSteps: [...completed], artifacts });
      await this.afterStep?.(step, { key, artifacts });
    }
    if (options.dryRun) return report;
    return this.store.put({ key, type: 'recipe', status: 'completed', recipe: recipe.recipe, recipeVersion: recipe.version, context, completedSteps: [...completed], artifacts });
  }

  async executeStep(recipe, step, input, context, artifacts, runKey) {
    const key = stepKey(recipe, context, step);
    if (step.uses === 'sequence.validate') {
      const directory = sandboxResolve(this.productionRoot, input.path);
      const files = readdirSync(directory).filter((name) => /\.(png|ppm|jpe?g|tiff?)$/i.test(name)).sort();
      if (!files.length) throw new Error('sequence contains no supported frames');
      return { path: directory, files: files.length, bytes: files.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0) };
    }
    if (step.uses === 'encode.ffmpeg') {
      const source = input.source || { type: 'frames', path: artifacts.validate?.path || context.framesFolder, pattern: input.pattern || 'frame_%05d.ppm', fps: input.fps || context.fps || 25 };
      const output = input.output || join(context.takeFolder, 'proxy', 'player.mp4');
      return encodeJob({ context, source, preset: input.preset, output, idempotencyKey: key }, { productionRoot: this.productionRoot, store: this.store, storePath: this.store.path, ffmpeg: this.ffmpeg, onEvent: this.onEvent });
    }
    if (step.uses === 'file.copy') {
      const requestedSource = input.from || artifacts.proxy?.output;
      if (!requestedSource) throw new Error(`file.copy step ${step.id} requires 'from' or a proxy artifact`);
      const source = sandboxResolve(this.productionRoot, requestedSource);
      const destination = sandboxResolve(this.productionRoot, input.to, input.name || basename(source));
      return copyNewFile(this.productionRoot, source, destination);
    }
    if (step.uses === 'run.cli') {
      const command = this.cliCommands[input.command];
      if (!command) throw new Error(`CLI command is not allowlisted: ${input.command}`);
      await new Promise((done, reject) => execFile(command, input.args || [], { cwd: this.productionRoot, windowsHide: true }, (error) => error ? reject(error) : done()));
      return { command: input.command };
    }
    if (step.uses === 'gate.manual') {
      const state = this.store.get(runKey);
      if (!state?.gateApproved) return { waitingGate: true };
      return { approved: true };
    }
    if (this.stubExternal && (step.uses === 'upload.enqueue' || step.uses.startsWith('motk.') || step.uses === 'playout.assembly.invalidate')) {
      this.onEvent({ event: 'runner.step:stubbed', step: step.id, uses: step.uses });
      return { stubbed: true, input };
    }
    if (step.uses === 'upload.enqueue') {
      if (!this.uploader) throw new Error('uploader is not configured');
      return this.uploader.enqueueAndRun({ source: input.from || artifacts.proxy?.output, target: input.target, destination: input.destination || join(context.shotId, `T${String(context.take).padStart(2, '0')}`, basename(input.from || artifacts.proxy?.output)), idempotencyKey: key });
    }
    if (step.uses === 'motk.version.register' || step.uses === 'motk.sheet.update') {
      const action = step.uses === 'motk.version.register' ? 'version.register' : 'job.status';
      const data = input.data || { version_id: key, shot_id: context.shotId, take: context.take, kind: 'proxy', file_ref: artifacts.upload?.output || artifacts.proxy?.output, checksum: artifacts.upload?.checksum || '', updated_at: new Date().toISOString() };
      if (this.controlPlaneEndpoint) {
        const event = step.uses === 'motk.version.register' ? 'motk.version:registered' : 'motk.job:status';
        return postControlEvent(this.controlPlaneEndpoint, event, { projectId: context.projectId, shotId: context.shotId, take: context.take }, data, { token: this.controlPlaneToken, fetch: this.controlPlaneFetch });
      }
      if (!this.motkEndpoint) throw new Error('MOTK endpoint or control plane is not configured');
      return postCoarseStatus(this.motkEndpoint, action, data, { token: this.motkToken });
    }
    if (step.uses === 'playout.assembly.invalidate') {
      const event = { event: 'motk.version:registered', shotId: context.shotId, take: context.take };
      this.onEvent(event);
      if (this.assemblyHandler) return this.assemblyHandler({ context, artifacts, event });
      return event;
    }
    if (step.uses === 'bridge.cmd') { this.onEvent({ event: 'runner.bridge:command', input }); return { queued: true, input }; }
    throw new Error(`unsupported step type: ${step.uses}`);
  }

  async dryRunStep(step, input, context, artifacts, report) {
    if (step.uses === 'sequence.validate') {
      const directory = sandboxResolve(this.productionRoot, input.path);
      const files = readdirSync(directory).filter((name) => /\.(png|ppm|jpe?g|tiff?)$/i.test(name));
      artifacts[step.id] = { path: directory, files: files.length, bytes: files.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0) };
      report.files.push(...files.map((name) => join(directory, name)));
      report.bytes += artifacts[step.id].bytes;
    } else if (step.uses === 'encode.ffmpeg') {
      const output = sandboxResolve(this.productionRoot, input.output || join(context.takeFolder, 'proxy', 'player.mp4'));
      artifacts[step.id] = { output };
      report.files.push(output); if (existsSync(output)) report.collisions.push(output);
    } else if (step.uses === 'file.copy') {
      const source = sandboxResolve(this.productionRoot, input.from || artifacts.proxy?.output);
      const destination = sandboxResolve(this.productionRoot, input.to, input.name || basename(source));
      report.files.push(destination); if (existsSync(destination)) report.collisions.push(destination);
      if (existsSync(source)) report.bytes += statSync(source).size;
      artifacts[step.id] = { path: destination };
    } else artifacts[step.id] = { planned: true };
  }
}

export function loadRecipes(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8').replace(/^\uFEFF/, '')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const configPath = resolve(arg('config', join(appRoot, 'companion.json')));
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); const base = dirname(configPath);
  const local = (value, fallback) => resolve(isAbsolute(value || '') ? value : join(base, value || fallback));
  const uploadTargets = Object.fromEntries(Object.entries(config.uploadTargets || {}).map(([name, target]) => [name, target.type === 'fs' ? { ...target, root: local(target.root, './uploads') } : target]));
  const runner = new Runner({ productionRoot: local(config.productionRoot, './production'), storePath: local(config.jobStore, './state/jobs.jsonl'), recipes: loadRecipes(local(config.recipesDir, join(appRoot, 'recipes'))), ffmpeg: config.ffmpeg || 'ffmpeg', cliCommands: config.cliCommands || {}, uploadTargets, motkEndpoint: config.motkEndpoint || '', motkToken: config.motkToken || '', controlPlaneEndpoint: config.controlPlaneEndpoint || '', controlPlaneToken: config.controlPlaneToken || '', onEvent: (event) => console.log(JSON.stringify(event)) });
  if (args.includes('--resume')) console.log(JSON.stringify(await runner.resumeAll()));
  const messagePath = arg('message', '');
  if (messagePath) console.log(JSON.stringify(await runner.handleMessage(JSON.parse(readFileSync(resolve(messagePath), 'utf8').replace(/^\uFEFF/, '')))));
}
