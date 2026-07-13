// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeJob } from '../cap-encode.mjs';
import { JournalJobStore } from '../lib/job-store.mjs';

const temp = mkdtempSync(join(tmpdir(), 'motk-companion-encode-'));
const frames = join(temp, 'Sample Production', 'SCENE_A_SHOT_001', 'T01', 'frames');
mkdirSync(frames, { recursive: true });
for (let index = 1; index <= 24; index += 1) {
  const width = 64; const height = 36;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = index * 8; pixels[i + 1] = (i / 3) % width * 3; pixels[i + 2] = 120;
  }
  writeFileSync(join(frames, `frame_${String(index).padStart(5, '0')}.ppm`), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
}

const job = {
  context: { projectId: 'project_sample', shotId: 'SCENE_A_SHOT_001', take: 1 },
  source: { type: 'frames', path: 'Sample Production/SCENE_A_SHOT_001/T01/frames', pattern: 'frame_%05d.ppm', fps: 25 },
  preset: 'player-proxy-1080p25',
  output: 'Sample Production/SCENE_A_SHOT_001/T01/proxy/player.mp4',
};
const store = new JournalJobStore(join(temp, 'state', 'jobs.jsonl'));
const staleTemp = join(temp, '.encode-stale.mp4'); writeFileSync(staleTemp, 'stale');
const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); utimesSync(staleTemp, old, old);

try {
  const first = await encodeJob(job, { productionRoot: temp, store, storePath: store.path });
  if (existsSync(staleTemp)) throw new Error('stale encode temporary was not swept');
  if (first.noop || first.status !== 'completed') throw new Error('first encode did not complete');
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,pix_fmt', '-of', 'json', first.output,
  ], { encoding: 'utf8', windowsHide: true }));
  const video = probe.streams?.[0];
  if (video?.width !== 1920 || video?.height !== 1080) throw new Error(`unexpected size ${video?.width}x${video?.height}`);
  if (video?.r_frame_rate !== '25/1') throw new Error(`unexpected fps ${video?.r_frame_rate}`);
  if (video?.pix_fmt !== 'yuv420p') throw new Error(`unexpected pixel format ${video?.pix_fmt}`);
  const second = await encodeJob(job, { productionRoot: temp, store, storePath: store.path });
  if (!second.noop || second.output !== first.output) throw new Error('idempotent rerun was not a no-op');
  const outputs = readdirSync(join(temp, 'Sample Production', 'SCENE_A_SHOT_001', 'T01', 'proxy'));
  if (outputs.length !== 1) throw new Error(`rerun created extra outputs: ${outputs.join(', ')}`);
  console.log('PASS');
  console.log('Encoded 24 synthetic frames to 1920x1080, 25 fps, yuv420p player proxy; identical rerun was a no-op.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
