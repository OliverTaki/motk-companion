// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMarkerCutJob } from '../cap-media-cut.mjs';

const root = mkdtempSync(join(tmpdir(), 'motk-media-cut-'));
try {
  mkdirSync(join(root, 'incoming'), { recursive: true });
  writeFileSync(join(root, 'incoming', 'reference.mov'), 'invented source media');
  const job = {
    kind: 'motk.media.job', schemaVersion: '1.0', jobId: 'cut_test_001', operation: 'video.cut.markers', createdAt: '2026-07-16T00:00:00Z',
    execution: { target: 'companion' }, source: { kind: 'companion-file', relativePath: 'incoming/reference.mov' },
    output: { kind: 'companion-directory', relativePath: 'deliveries/clips', collisionPolicy: 'create-new' }, timing: { unit: 'seconds', fps: 24 },
    parameters: { mode: 'accurate', markers: [
      { id: 'm_001', name: 'Shot / 10', startSeconds: 0, endSeconds: 1 },
      { id: 'm_002', name: 'Shot 20', startSeconds: 1, endSeconds: 2 },
    ] },
  };
  let calls = 0;
  const fakeFfmpeg = async (_command, args, progress) => {
    calls += 1; progress('00:00:00.50');
    const output = args.at(-1); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `invented clip ${calls}`);
  };
  const events = [];
  const options = { productionRoot: root, storePath: join(root, 'state', 'jobs.jsonl'), runProcess: fakeFfmpeg, onEvent: (event) => events.push(event) };
  const first = await runMarkerCutJob(job, options);
  if (first.status !== 'succeeded' || first.artifacts.length !== 2 || calls !== 2) throw new Error('marker cut did not complete');
  if (!first.artifacts[0].relativePath.includes('001_Shot _ 10.mp4')) throw new Error('output name was not safely normalized');
  if (!first.artifacts.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.checksum))) throw new Error('artifact checksums missing');
  const second = await runMarkerCutJob(job, options);
  if (!second.noop || calls !== 2) throw new Error('completed media job was not idempotent');
  if (!events.some((event) => event.status === 'succeeded')) throw new Error('completion event missing');
  JSON.parse(readFileSync(join(root, 'state', 'jobs.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1));
  console.log('PASS');
  console.log('Universal VideoCutter Companion execution is create-new, checksummed, progress-reporting, and idempotent.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
