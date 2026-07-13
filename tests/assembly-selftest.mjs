// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssembly } from '../assembly.mjs';
import { FileWatcher } from '../cap-watcher.mjs';

const temp = mkdtempSync(join(tmpdir(), 'motk-companion-assembly-'));
const media = join(temp, 'assembly-media'); mkdirSync(media, { recursive: true });
const makeClip = (name, frames, color) => {
  const path = join(media, name);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x36:r=25`, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path], { windowsHide: true });
  return path;
};

try {
  const shots = [1, 2, 3, 4].map((index) => ({ shotId: `SHOT_${index}` }));
  const versions = shots.map((shot, index) => ({ shotId: shot.shotId, versionId: `${shot.shotId}_v1`, file: makeClip(`${shot.shotId}_v1.mp4`, 10, ['red', 'green', 'blue', 'white'][index]), valid: true, updatedAt: `2026-07-13T00:00:0${index}Z` }));
  const first = buildAssembly({ productionRoot: temp, shots, versions, fps: 25 });
  const replacement = { shotId: 'SHOT_2', versionId: 'SHOT_2_v2', file: makeClip('SHOT_2_v2.mp4', 15, 'yellow'), valid: true, updatedAt: '2026-07-13T01:00:00Z' };
  const second = buildAssembly({ productionRoot: temp, shots, versions: [...versions, replacement], fps: 25 });
  if (first.revisionId === second.revisionId) throw new Error('revision id did not change');
  if (second.segments[2].inFrame - first.segments[2].inFrame !== 5) throw new Error('downstream ripple did not equal the 5-frame replacement delta');
  if (second.segments[3].inFrame - first.segments[3].inFrame !== 5) throw new Error('last segment did not ripple by 5 frames');

  const events = []; const watched = join(temp, 'watched'); mkdirSync(watched);
  const watcher = await new FileWatcher({ root: watched, intervalMs: 50, onEvent: (event) => events.push(event) }).start();
  writeFileSync(join(watched, 'new-frame.ppm'), 'P3\n1 1\n255\n0 0 0\n');
  const deadline = Date.now() + 3000;
  while (!events.some((event) => event.event === 'watcher.file:appeared') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  watcher.stop();
  if (!events.some((event) => event.event === 'watcher.file:appeared')) throw new Error('watcher did not report the new file');
  console.log('PASS');
  console.log('Measured 4 shot versions, rippled downstream segments by the exact 5-frame replacement delta with a new revision id, and observed a watched file appearance.');
} finally { rmSync(temp, { recursive: true, force: true }); }
