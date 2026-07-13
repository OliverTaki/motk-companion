// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { copyNewFile } from './lib/safe-fs.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export class FfmpegValidationBackend {
  constructor(options = {}) { this.ffmpeg = options.ffmpeg || 'ffmpeg'; }
  play(file) {
    return new Promise((done, reject) => {
      execFile(this.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true }, (error, _stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : done());
    });
  }
  async reload() {}
}

export class PlayoutPlayer {
  constructor(options) {
    this.productionRoot = resolve(options.productionRoot);
    this.cacheRoot = resolve(options.cacheRoot);
    mkdirSync(this.cacheRoot, { recursive: true });
    this.backend = options.backend || new FfmpegValidationBackend(options);
    this.prefetchCount = options.prefetchCount || 3;
    this.stallMs = options.stallMs || 30000;
    this.onEvent = options.onEvent || (() => {});
    this.manifest = null; this.pending = null; this.index = 0; this.cache = new Map();
  }
  load(manifest) { this.manifest = manifest; this.index = 0; return this.prefetch(); }
  queueRevision(manifest) { this.pending = manifest; this.onEvent({ event: 'playout.revision:queued', revisionId: manifest.revisionId }); }
  async prefetch() {
    if (!this.manifest) return;
    for (let offset = 0; offset < this.prefetchCount; offset += 1) {
      const index = (this.index + offset) % this.manifest.segments.length;
      const segment = this.manifest.segments[index]; const key = `${this.manifest.revisionId}:${index}`;
      if (this.cache.has(key)) continue;
      const requested = join(this.cacheRoot, this.manifest.revisionId, `${String(index).padStart(5, '0')}-${basename(segment.file)}`);
      if (existsSync(requested)) this.cache.set(key, requested);
      else this.cache.set(key, copyNewFile(this.cacheRoot, segment.file, requested).path);
      this.onEvent({ event: 'playout.cache:ready', index, file: this.cache.get(key) });
    }
  }
  status() {
    const count = this.manifest?.segments.length || 0;
    return { revisionId: this.manifest?.revisionId || '', current: this.index, next: count ? (this.index + 1) % count : null, standby: count ? (this.index + 2) % count : null, pendingRevisionId: this.pending?.revisionId || '' };
  }
  async playOne() {
    if (!this.manifest?.segments.length) throw new Error('playout manifest is empty');
    await this.prefetch();
    const key = `${this.manifest.revisionId}:${this.index}`; const segment = this.manifest.segments[this.index]; const file = this.cache.get(key) || segment.file;
    const attempt = async () => Promise.race([this.backend.play(file, segment), delay(this.stallMs).then(() => { throw new Error('playout stall'); })]);
    try { await attempt(); }
    catch (firstError) {
      this.onEvent({ event: 'playout.watchdog:reload', shotId: segment.shotId, error: firstError.message });
      try { await this.backend.reload?.(); await attempt(); }
      catch (secondError) { this.onEvent({ event: 'playout.shot:skipped', shotId: segment.shotId, error: secondError.message }); }
    }
    this.onEvent({ event: 'playout.boundary', revisionId: this.manifest.revisionId, index: this.index, frame: segment.outFrame });
    this.index = (this.index + 1) % this.manifest.segments.length;
    if (this.pending) {
      const activated = this.pending; this.pending = null; this.manifest = activated;
      this.index = Math.min(this.index, Math.max(0, activated.segments.length - 1));
      this.onEvent({ event: 'playout.revision:activated', revisionId: activated.revisionId });
    }
    await this.prefetch();
  }
  async run(segmentCount) { for (let count = 0; count < segmentCount; count += 1) await this.playOne(); }
}
