// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class JournalJobStore {
  constructor(path) {
    this.path = resolve(path);
    this.records = new Map();
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.key) this.records.set(record.key, record);
      }
    }
  }

  get(key) { return this.records.get(String(key)); }
  values() { return [...this.records.values()]; }

  put(record) {
    if (!record?.key) throw new Error('job record key is required');
    const value = { ...record, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.records.set(value.key, value);
    return value;
  }

  summary() {
    const out = { queued: 0, running: 0, waiting_gate: 0, completed: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const record of this.records.values()) if (record.status in out) out[record.status] += 1;
    return out;
  }
}
