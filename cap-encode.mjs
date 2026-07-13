// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNewFile, sandboxResolve } from './lib/safe-fs.mjs';
import { JournalJobStore } from './lib/job-store.mjs';

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function sweepStaleEncodeTemps(root, options = {}) {
  const cutoff = Date.now() - (options.maxAgeMs || 24 * 60 * 60 * 1000); let removed = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase() === 'raw') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith('.encode-') && statSync(path).mtimeMs < cutoff) { rmSync(path, { force: true }); removed += 1; }
    }
  };
  if (existsSync(root)) walk(resolve(root)); return removed;
}
export function encodeKey(job) {
  const c = job.context || {};
  return hash(JSON.stringify([c.projectId || '', c.shotId || '', c.take || '', c.versionId || '', job.preset, job.source, job.output]));
}

const runProcess = (command, args, onProgress) => new Promise((done, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    const text = String(chunk); stderr += text;
    const time = text.match(/time=(\d\d:\d\d:\d\d\.\d+)/)?.[1];
    if (time) onProgress?.({ event: 'encode.job:progress', time });
  });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? done() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`)));
});

function inputArgs(source, productionRoot) {
  if (source.type === 'frames') {
    const directory = sandboxResolve(productionRoot, source.path);
    return ['-framerate', String(source.fps || 25), '-start_number', String(source.startNumber || 1), '-i', join(directory, source.pattern || 'frame_%05d.png')];
  }
  if (source.type === 'movie') return ['-i', sandboxResolve(productionRoot, source.path)];
  throw new Error('source.type must be frames or movie');
}

export async function encodeJob(job, options) {
  const productionRoot = resolve(options.productionRoot);
  sweepStaleEncodeTemps(productionRoot);
  const store = options.store || new JournalJobStore(options.storePath);
  const key = job.idempotencyKey || encodeKey(job);
  const prior = store.get(key);
  if (prior?.status === 'completed' && existsSync(prior.output)) return { ...prior, noop: true };
  const presetPath = join(options.presetsDir || join(appRoot, 'presets'), `${job.preset}.json`);
  const preset = JSON.parse(readFileSync(presetPath, 'utf8').replace(/^\uFEFF/, ''));
  const requestedOutput = sandboxResolve(productionRoot, job.output);
  mkdirSync(dirname(requestedOutput), { recursive: true });
  const tempOutput = join(dirname(requestedOutput), `.encode-${process.pid}-${randomBytes(6).toString('hex')}${preset.extension || extname(requestedOutput)}`);
  const emit = (value) => options.onEvent?.({ ...value, key, preset: job.preset });
  store.put({ key, type: 'encode', status: 'running', preset: job.preset });
  emit({ event: 'encode.job:started' });
  try {
    const args = [...inputArgs(job.source, productionRoot), ...preset.args, tempOutput];
    await runProcess(options.ffmpeg || 'ffmpeg', args, emit);
    const written = copyNewFile(productionRoot, tempOutput, requestedOutput);
    rmSync(tempOutput, { force: true });
    const record = store.put({ key, type: 'encode', status: 'completed', preset: job.preset, output: written.path, collision: written.collision });
    emit({ event: 'encode.job:done', output: written.path });
    return { ...record, noop: false };
  } catch (error) {
    rmSync(tempOutput, { force: true });
    store.put({ key, type: 'encode', status: 'failed', preset: job.preset, error: error.message });
    emit({ event: 'encode.job:failed', error: error.message });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const jobPath = resolve(arg('job', ''));
  const configPath = resolve(arg('config', join(appRoot, 'companion.json')));
  if (!jobPath) throw new Error('--job is required');
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const base = dirname(configPath);
  const local = (value, fallback) => resolve(isAbsolute(value || '') ? value : join(base, value || fallback));
  const result = await encodeJob(JSON.parse(readFileSync(jobPath, 'utf8').replace(/^\uFEFF/, '')), {
    productionRoot: local(config.productionRoot, './production'),
    storePath: local(config.jobStore, './state/jobs.jsonl'),
    ffmpeg: config.ffmpeg || 'ffmpeg',
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify(result));
}
