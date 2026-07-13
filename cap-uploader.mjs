// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { copyNewFile, sandboxResolve } from './lib/safe-fs.mjs';
import { JournalJobStore } from './lib/job-store.mjs';

const fileSha256 = (path) => {
  const hash = createHash('sha256'); const handle = openSync(path, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let read; while ((read = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read)); }
  finally { closeSync(handle); }
  return hash.digest('hex');
};
const keyFor = (source, target, destination, checksum) => createHash('sha256').update(JSON.stringify([source, target, destination, checksum])).digest('hex');

export class Uploader {
  constructor(options) {
    this.productionRoot = resolve(options.productionRoot);
    this.targets = options.targets || {};
    this.store = options.store || new JournalJobStore(options.storePath);
    this.chunkSize = options.chunkSize || 4 * 1024 * 1024;
    this.afterChunk = options.afterChunk;
    this.fetch = options.fetch || globalThis.fetch;
    this.onEvent = options.onEvent || (() => {});
  }

  enqueue(job) {
    const source = sandboxResolve(this.productionRoot, job.source);
    if (!statSync(source).isFile()) throw new Error('upload source is not a file');
    const targetName = String(job.target || '');
    const target = this.targets[targetName];
    if (!target) throw new Error(`undeclared upload target: ${targetName}`);
    const checksum = fileSha256(source);
    const destination = String(job.destination || basename(source)).replace(/\\/g, '/');
    const key = job.idempotencyKey || keyFor(source, targetName, destination, checksum);
    const prior = this.store.get(key);
    if (prior?.status === 'completed') return prior;
    return this.store.put({ key, type: 'upload', status: 'queued', source, target: targetName, destination, checksum, size: statSync(source).size, offset: prior?.offset || 0, sessionUrl: prior?.sessionUrl || '' });
  }

  async run(key) {
    let record = this.store.get(key);
    if (!record) throw new Error('upload job not found');
    if (record.status === 'completed') return { ...record, noop: true };
    const target = this.targets[record.target];
    if (target.type === 'fs') return this.runFs(record, target);
    if (target.type === 'drive') return this.runDrive(record, target);
    throw new Error(`unsupported upload target type: ${target.type}`);
  }

  async enqueueAndRun(job) { const record = this.enqueue(job); return this.run(record.key); }

  async resumeAll() {
    const results = [];
    for (const record of this.store.values().filter((item) => item.type === 'upload' && item.status !== 'completed')) results.push(await this.run(record.key));
    return results;
  }

  async runFs(record, target) {
    const targetRoot = resolve(target.root);
    const requested = sandboxResolve(targetRoot, record.destination);
    const partial = sandboxResolve(targetRoot, '.motk-upload-parts', `${record.key}.part`);
    mkdirSync(dirname(partial), { recursive: true });
    if (!existsSync(partial)) { const created = openSync(partial, 'wx', 0o600); closeSync(created); }
    let offset = statSync(partial).size;
    if (offset > record.size) throw new Error('upload partial exceeds source size');
    const sourceHandle = openSync(record.source, 'r'); const partialHandle = openSync(partial, 'r+');
    try {
      const buffer = Buffer.alloc(this.chunkSize);
      while (offset < record.size) {
        const length = readSync(sourceHandle, buffer, 0, Math.min(buffer.length, record.size - offset), offset);
        if (!length) throw new Error('unexpected end of upload source');
        writeSync(partialHandle, buffer, 0, length, offset); offset += length;
        record = this.store.put({ ...record, status: 'running', offset });
        this.onEvent({ event: 'upload.job:progress', key: record.key, bytes: offset, total: record.size });
        await this.afterChunk?.(record);
      }
    } finally { closeSync(sourceHandle); closeSync(partialHandle); }
    if (fileSha256(partial) !== record.checksum) throw new Error('upload checksum mismatch');
    const written = copyNewFile(targetRoot, partial, requested); rmSync(partial, { force: true });
    const completed = this.store.put({ ...record, status: 'completed', offset: record.size, output: written.path, collision: written.collision });
    this.onEvent({ event: 'upload.job:done', key: record.key, output: written.path });
    return completed;
  }

  async runDrive(record, target) {
    if (!target.endpoint || !target.accessToken) throw new Error('drive target requires user-configured endpoint and accessToken');
    let sessionUrl = record.sessionUrl;
    if (!sessionUrl) {
      const response = await this.fetch(target.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${target.accessToken}`, 'Content-Type': 'application/json; charset=utf-8', 'X-Upload-Content-Length': String(record.size) }, body: JSON.stringify({ name: record.destination, parents: target.folderId ? [target.folderId] : undefined }) });
      if (!response.ok) throw new Error(`drive session HTTP ${response.status}`);
      sessionUrl = response.headers.get('location'); if (!sessionUrl) throw new Error('drive session response has no location');
      record = this.store.put({ ...record, status: 'running', sessionUrl });
    }
    const handle = openSync(record.source, 'r'); let offset = record.offset || 0;
    try {
      const buffer = Buffer.alloc(this.chunkSize);
      while (offset < record.size) {
        const length = readSync(handle, buffer, 0, Math.min(buffer.length, record.size - offset), offset);
        const response = await this.fetch(sessionUrl, { method: 'PUT', headers: { Authorization: `Bearer ${target.accessToken}`, 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${record.size}` }, body: buffer.subarray(0, length) });
        if (![200, 201, 308].includes(response.status)) throw new Error(`drive chunk HTTP ${response.status}`);
        offset += length; record = this.store.put({ ...record, status: 'running', offset, sessionUrl });
      }
    } finally { closeSync(handle); }
    return this.store.put({ ...record, status: 'completed', offset: record.size, output: `drive:${record.destination}` });
  }
}
