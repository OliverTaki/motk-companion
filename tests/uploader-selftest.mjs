// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Uploader } from '../cap-uploader.mjs';
import { JournalJobStore } from '../lib/job-store.mjs';
import { postCoarseStatus } from '../lib/motk-client.mjs';

const temp = mkdtempSync(join(tmpdir(), 'motk-companion-uploader-'));
const productionRoot = join(temp, 'production'); const targetRoot = join(temp, 'nas');
mkdirSync(join(productionRoot, 'Sample Production', 'exports'), { recursive: true });
const source = join(productionRoot, 'Sample Production', 'exports', 'proxy.mp4');
const bytes = Buffer.alloc(2 * 1024 * 1024 + 12345);
for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
writeFileSync(source, bytes);
const storePath = join(temp, 'state', 'uploads.jsonl');
const targets = { 'fs:PROXY': { type: 'fs', root: targetRoot } };
let chunks = 0;

const serverPayloads = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    serverPayloads.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));

try {
  const first = new Uploader({ productionRoot, targets, store: new JournalJobStore(storePath), chunkSize: 256 * 1024, afterChunk: () => { chunks += 1; if (chunks === 3) throw new Error('simulated transfer interruption'); } });
  const queued = first.enqueue({ source, target: 'fs:PROXY', destination: 'SCENE_A_SHOT_001/T01/proxy.mp4' });
  let interrupted = false;
  try { await first.run(queued.key); } catch (error) { interrupted = error.message === 'simulated transfer interruption'; }
  if (!interrupted) throw new Error('upload did not stop mid-transfer');
  const persisted = new JournalJobStore(storePath).get(queued.key);
  if (persisted.offset !== 3 * 256 * 1024) throw new Error(`unexpected persisted offset ${persisted.offset}`);

  const restarted = new Uploader({ productionRoot, targets, store: new JournalJobStore(storePath), chunkSize: 256 * 1024 });
  const result = await restarted.run(queued.key);
  if (result.status !== 'completed' || !result.output) throw new Error('resumed upload did not complete');
  if (statSync(result.output).size !== bytes.length) throw new Error('uploaded file size differs');
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  if (digest(readFileSync(result.output)) !== digest(bytes)) throw new Error('uploaded checksum differs');

  const endpoint = `http://127.0.0.1:${server.address().port}/companion`;
  await postCoarseStatus(endpoint, 'version.register', { version_id: 'version_sample_1', shot_id: 'SCENE_A_SHOT_001', take: 1, kind: 'proxy', file_ref: 'fs:proxy.mp4', duration_frames: 24, checksum: result.checksum }, { token: 'test-only-token' });
  const request = serverPayloads[0];
  if (request.body.action !== 'version.register' || request.body.data.shot_id !== 'SCENE_A_SHOT_001') throw new Error('registration payload shape differs');
  if (request.body.token !== 'test-only-token') throw new Error('registration payload omitted the configured endpoint token');
  if (!String(request.headers['content-type']).startsWith('text/plain')) throw new Error('registration did not use GAS-compatible content type');
  console.log('PASS');
  console.log('Resumed an interrupted chunked fs upload from its persisted offset, verified checksum, and sent the expected version.register payload to a mock endpoint.');
} finally {
  await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
}
