// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeNewFile, sandboxResolve } from './lib/safe-fs.mjs';

function probeFrames(path, ffprobe, fallbackFps) {
  const data = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,nb_frames,r_frame_rate,duration', '-of', 'json', path], { encoding: 'utf8', windowsHide: true }));
  const stream = data.streams?.[0]; if (!stream) throw new Error(`no video stream: ${path}`);
  const [num, den] = String(stream.r_frame_rate || `${fallbackFps}/1`).split('/').map(Number);
  const fps = den ? num / den : fallbackFps;
  const frames = Number(stream.nb_read_frames || stream.nb_frames) || Math.round(Number(stream.duration) * fps);
  if (!frames) throw new Error(`duration could not be measured: ${path}`);
  return { frames, fps };
}

export function buildAssembly(options) {
  const productionRoot = resolve(options.productionRoot);
  const versionsByShot = new Map();
  for (const version of options.versions || []) {
    if (version.valid === false) continue;
    const current = versionsByShot.get(version.shotId);
    const rank = String(version.updatedAt || version.createdAt || version.versionId || '');
    const currentRank = String(current?.updatedAt || current?.createdAt || current?.versionId || '');
    if (!current || rank > currentRank) versionsByShot.set(version.shotId, version);
  }
  let cursor = 0;
  const segments = [];
  for (const shot of options.shots || []) {
    const version = versionsByShot.get(shot.shotId);
    if (!version) continue;
    const path = sandboxResolve(productionRoot, version.file);
    if (!existsSync(path)) throw new Error(`version file does not exist: ${version.file}`);
    const measured = probeFrames(path, options.ffprobe || 'ffprobe', options.fps || 25);
    const segment = { order: segments.length, shotId: shot.shotId, versionId: version.versionId, file: path, inFrame: cursor, outFrame: cursor + measured.frames, durationFrames: measured.frames, durationSeconds: measured.frames / measured.fps, fps: measured.fps };
    cursor = segment.outFrame; segments.push(segment);
  }
  const identity = segments.map((segment) => [segment.shotId, segment.versionId, segment.durationFrames, segment.file]);
  const revisionId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const manifest = { schemaVersion: 1, revisionId, state: 'Ready', createdAt: new Date().toISOString(), totalFrames: cursor, segments, safeSwapBoundaries: segments.map((segment) => segment.outFrame) };
  if (options.output) {
    const output = sandboxResolve(productionRoot, options.output);
    manifest.manifestFile = writeNewFile(productionRoot, output, `${JSON.stringify(manifest, null, 2)}\n`).path;
  }
  return manifest;
}

export class AssemblyRevisions {
  constructor() { this.building = null; this.ready = null; this.active = null; }
  begin(input) { this.building = input; return this.building; }
  markReady(manifest) { this.ready = manifest; this.building = null; return manifest; }
  activate(revisionId) {
    if (!this.ready || this.ready.revisionId !== revisionId) throw new Error('ready revision not found');
    this.active = { ...this.ready, state: 'Active', activatedAt: new Date().toISOString() }; this.ready = null; return this.active;
  }
}
