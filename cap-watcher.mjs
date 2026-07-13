// SPDX-License-Identifier: GPL-3.0-or-later
import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function snapshot(root) {
  const found = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await stat(path); found.set(path, `${info.size}:${info.mtimeMs}`); }
    }
  }
  await walk(root); return found;
}

export class FileWatcher {
  constructor(options) { this.root = resolve(options.root); this.intervalMs = options.intervalMs || 2000; this.onEvent = options.onEvent || (() => {}); this.known = new Map(); this.timer = null; this.watcher = null; this.scanning = false; }
  async start() {
    this.known = await snapshot(this.root);
    try { this.watcher = watch(this.root, { recursive: true }, () => this.scan()); } catch { this.watcher = watch(this.root, () => this.scan()); }
    this.timer = setInterval(() => this.scan(), this.intervalMs); this.timer.unref(); return this;
  }
  async scan() {
    if (this.scanning) return; this.scanning = true;
    try {
      const next = await snapshot(this.root);
      for (const [path, fingerprint] of next) {
        if (!this.known.has(path)) this.onEvent({ event: 'watcher.file:appeared', path });
        else if (this.known.get(path) !== fingerprint) this.onEvent({ event: 'watcher.sequence:changed', path });
      }
      this.known = next;
    } finally { this.scanning = false; }
  }
  stop() { this.watcher?.close(); if (this.timer) clearInterval(this.timer); this.timer = null; }
}
