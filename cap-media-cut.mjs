// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalJobStore } from './lib/job-store.mjs';
import { normalizeMediaJob } from './lib/media-contracts.mjs';
import { assertWritablePath, copyNewFile, sandboxResolve } from './lib/safe-fs.mjs';

const hashText = (value) => createHash('sha256').update(value).digest('hex');
const checksumFile = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const safeName = (value, index) => (String(value).trim() || `clip_${String(index + 1).padStart(3, '0')}`)
  .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 96);

export function mediaJobKey(job) {
  return job.idempotencyKey || hashText(JSON.stringify(job));
}

export function planMarkerCuts(input, productionRoot) {
  const job = normalizeMediaJob(input, { target: 'companion' });
  const root = resolve(productionRoot);
  const source = sandboxResolve(root, job.source.relativePath);
  if (!existsSync(source)) throw new Error('source file does not exist inside the configured Companion root');
  const outputDirectory = assertWritablePath(root, sandboxResolve(root, job.output.relativePath));
  return {
    job, root, source, outputDirectory,
    markers: job.parameters.markers.map((marker, index) => ({
      ...marker,
      requestedName: `${String(index + 1).padStart(3, '0')}_${safeName(marker.name, index)}.mp4`,
    })),
  };
}

const runFfmpeg = (command, args, onProgress) => new Promise((done, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    const value = String(chunk); stderr += value;
    const time = value.match(/time=(\d\d:\d\d:\d\d\.\d+)/)?.[1];
    if (time) onProgress?.(time);
  });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? done() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`)));
});

export async function runMarkerCutJob(input, options) {
  const plan = planMarkerCuts(input, options.productionRoot);
  const { job, root, source, outputDirectory } = plan;
  const store = options.store || new JournalJobStore(options.storePath);
  const key = mediaJobKey(job);
  const prior = store.get(key);
  const priorArtifacts = Array.isArray(prior?.artifacts) ? prior.artifacts.filter((item) => item.relativePath && existsSync(sandboxResolve(root, item.relativePath))) : [];
  if (prior?.status === 'succeeded' && priorArtifacts.length === plan.markers.length) return { ...prior.result, noop: true };
  const completed = new Map(priorArtifacts.map((item) => [item.markerId, item]));
  const artifacts = [...completed.values()];
  const emit = (event) => options.onEvent?.({ kind: 'motk.media.progress', schemaVersion: '1.0', jobId: job.jobId, operation: job.operation, ...event });
  mkdirSync(outputDirectory, { recursive: true });
  store.put({ key, type: 'media', status: 'running', jobId: job.jobId, operation: job.operation, job, artifacts });
  emit({ status: 'running', completed: artifacts.length, total: plan.markers.length });
  try {
    for (let index = 0; index < plan.markers.length; index += 1) {
      const marker = plan.markers[index];
      if (completed.has(marker.id)) continue;
      const temporary = assertWritablePath(root, resolve(outputDirectory, `.media-${randomBytes(6).toString('hex')}.mp4`));
      const common = ['-hide_banner', '-loglevel', 'info', '-ss', marker.startSeconds.toFixed(6), '-i', source, '-t', (marker.endSeconds - marker.startSeconds).toFixed(6), '-map', '0:v:0?', '-map', '0:a:0?'];
      const encode = job.parameters.mode === 'accurate'
        ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', '-y', temporary]
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', temporary];
      emit({ status: 'running', markerId: marker.id, markerIndex: index, completed: artifacts.length, total: plan.markers.length });
      await (options.runProcess || runFfmpeg)(options.ffmpeg || 'ffmpeg', [...common, ...encode], (time) => emit({ status: 'running', markerId: marker.id, markerIndex: index, time, completed: artifacts.length, total: plan.markers.length }));
      const requested = resolve(outputDirectory, marker.requestedName);
      const written = copyNewFile(root, temporary, requested);
      rmSync(temporary, { force: true });
      const artifact = {
        markerId: marker.id,
        name: marker.name,
        relativePath: relative(root, written.path).replaceAll('\\', '/'),
        bytes: statSync(written.path).size,
        checksum: checksumFile(written.path),
        collision: written.collision,
      };
      artifacts.push(artifact);
      completed.set(marker.id, artifact);
      store.put({ key, type: 'media', status: 'running', jobId: job.jobId, operation: job.operation, job, artifacts });
    }
    const result = { kind: 'motk.media.result', schemaVersion: '1.0', jobId: job.jobId, operation: job.operation, status: 'succeeded', artifacts, completedAt: new Date().toISOString() };
    store.put({ key, type: 'media', status: 'succeeded', jobId: job.jobId, operation: job.operation, job, artifacts, result });
    emit({ status: 'succeeded', completed: artifacts.length, total: plan.markers.length, artifacts });
    return { ...result, noop: false };
  } catch (error) {
    store.put({ key, type: 'media', status: 'failed', jobId: job.jobId, operation: job.operation, job, artifacts, error: error.message });
    emit({ status: 'failed', completed: artifacts.length, total: plan.markers.length, error: error.message });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const jobPath = resolve(value('job'));
  const configPath = resolve(value('config', 'companion.json'));
  if (!jobPath) throw new Error('--job is required');
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const base = dirname(configPath);
  const local = (path, fallback) => resolve(base, path || fallback);
  const result = await runMarkerCutJob(JSON.parse(readFileSync(jobPath, 'utf8').replace(/^\uFEFF/, '')), {
    productionRoot: local(config.productionRoot, './production'),
    storePath: local(config.jobStore, './state/jobs.jsonl'),
    ffmpeg: config.ffmpeg || 'ffmpeg',
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify(result));
}
