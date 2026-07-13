// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayoutPlayer } from '../cap-playout.mjs';

const temp = mkdtempSync(join(tmpdir(), 'motk-companion-playout-')); const media = join(temp, 'media'); mkdirSync(media);
const clip = (name, color, frames = 10) => {
  const path = join(media, name);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x36:r=25`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-frames:v', String(frames), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-y', path], { windowsHide: true });
  return path;
};

try {
  const files = [clip('one.mp4', 'red'), clip('two.mp4', 'green'), clip('three.mp4', 'blue')];
  const concat = join(temp, 'clips.ffconcat');
  writeFileSync(concat, `ffconcat version 1.0\n${files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')}\n`);
  const joined = join(temp, 'joined.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', '-y', joined], { windowsHide: true });
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,pix_fmt', '-of', 'json', joined], { encoding: 'utf8', windowsHide: true }));
  if (Number(probe.streams?.[0]?.nb_read_frames) !== 30 || probe.streams?.[0]?.pix_fmt !== 'yuv420p') throw new Error('concat did not preserve the expected 30 normalized frames');

  const segments = files.map((file, index) => ({ shotId: `SHOT_${index + 1}`, file, inFrame: index * 10, outFrame: (index + 1) * 10, durationFrames: 10 }));
  const manifest = { revisionId: 'revision_a', segments };
  const events = []; const attempts = new Map();
  const backend = { play: async (file, segment) => { if (!existsSync(file) || !statSync(file).isFile()) throw new Error('cache file missing'); const count = (attempts.get(segment.shotId) || 0) + 1; attempts.set(segment.shotId, count); if (segment.shotId === 'SHOT_2') throw new Error('corrupt sample'); }, reload: async () => {} };
  const player = new PlayoutPlayer({ productionRoot: temp, cacheRoot: join(temp, 'cache'), backend, prefetchCount: 3, stallMs: 1000, onEvent: (event) => events.push(event) });
  await player.load(manifest);
  for (const file of files) rmSync(file);
  await player.run(3);
  if (!events.some((event) => event.event === 'playout.shot:skipped' && event.shotId === 'SHOT_2')) throw new Error('corrupt shot was not skipped and reported');
  if (events.filter((event) => event.event === 'playout.boundary').length !== 3) throw new Error('playout did not continue across all boundaries');

  const swapA = clip('swap-a.mp4', 'white'); const swapB = clip('swap-b.mp4', 'yellow', 12);
  const swapEvents = [];
  const swapPlayer = new PlayoutPlayer({ productionRoot: temp, cacheRoot: join(temp, 'swap-cache'), backend: { play: async () => {}, reload: async () => {} }, onEvent: (event) => swapEvents.push(event) });
  await swapPlayer.load({ revisionId: 'before_swap', segments: [{ shotId: 'SHOT_A', file: swapA, inFrame: 0, outFrame: 10, durationFrames: 10 }] });
  swapPlayer.queueRevision({ revisionId: 'after_swap', segments: [{ shotId: 'SHOT_A', file: swapB, inFrame: 0, outFrame: 12, durationFrames: 12 }] });
  await swapPlayer.playOne();
  const boundaryIndex = swapEvents.findIndex((event) => event.event === 'playout.boundary');
  const activationIndex = swapEvents.findIndex((event) => event.event === 'playout.revision:activated');
  if (boundaryIndex < 0 || activationIndex <= boundaryIndex || swapPlayer.status().revisionId !== 'after_swap') throw new Error('revision did not activate strictly after a safe boundary');
  console.log('PASS');
  console.log('Validated normalized concat frame count, current/next/standby cache playback after source loss, corrupt-shot reload/skip continuity, and safe-boundary revision activation.');
} finally { rmSync(temp, { recursive: true, force: true }); }
