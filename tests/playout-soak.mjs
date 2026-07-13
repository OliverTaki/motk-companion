// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PlayoutPlayer } from '../cap-playout.mjs';

const requestedSeconds = Number(process.env.MOTK_SOAK_SECONDS || 60);
if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0 || requestedSeconds > 3 * 24 * 60 * 60) throw new Error('MOTK_SOAK_SECONDS must be between 1 and 259200');
const segmentDelayMs = Math.max(1, Number(process.env.MOTK_SOAK_SEGMENT_MS || 5));
const temp = mkdtempSync(join(tmpdir(), 'motk-playout-soak-'));
const media = join(temp, 'media');
mkdirSync(media);

const eventCounts = new Map();
const recordEvent = (event) => eventCounts.set(event.event, (eventCounts.get(event.event) || 0) + 1);
let playCalls = 0;
let reloads = 0;
let injectedFailures = 0;
let failNext = false;
const backend = {
  async play() {
    playCalls += 1;
    if (playCalls % 211 === 0) {
      injectedFailures += 1;
      failNext = true;
      throw new Error('injected transient backend stall');
    }
    if (failNext) failNext = false;
    await delay(segmentDelayMs);
  },
  async reload() { reloads += 1; },
};

function manifest(revision) {
  return {
    revisionId: `soak_revision_${revision}`,
    segments: [0, 1, 2].map((index) => ({
      shotId: `SHOT_${index + 1}`,
      file: join(media, `shot-${index + 1}.mp4`),
      inFrame: index * 24,
      outFrame: (index + 1) * 24 + revision,
      durationFrames: 24 + revision,
    })),
  };
}

try {
  for (let index = 1; index <= 3; index += 1) writeFileSync(join(media, `shot-${index}.mp4`), `synthetic-soak-media-${index}`);
  const player = new PlayoutPlayer({ productionRoot: temp, cacheRoot: join(temp, 'cache'), backend, prefetchCount: 3, stallMs: 1000, onEvent: recordEvent });
  await player.load(manifest(0));
  const startedAt = Date.now();
  const startedRss = process.memoryUsage().rss;
  let peakRss = startedRss;
  let revision = 0;
  while (Date.now() - startedAt < requestedSeconds * 1000) {
    await player.playOne();
    const boundaries = eventCounts.get('playout.boundary') || 0;
    if (boundaries > 0 && boundaries % 173 === 0 && !player.status().pendingRevisionId) {
      revision += 1;
      player.queueRevision(manifest(revision));
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const boundaries = eventCounts.get('playout.boundary') || 0;
  const activations = eventCounts.get('playout.revision:activated') || 0;
  const skipped = eventCounts.get('playout.shot:skipped') || 0;
  const report = {
    requestedSeconds,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    boundaries,
    revisionActivations: activations,
    watchdogRecoveries: reloads,
    skippedShots: skipped,
    rssGrowthMiB: Number(((process.memoryUsage().rss - startedRss) / 1024 / 1024).toFixed(2)),
    peakRssGrowthMiB: Number(((peakRss - startedRss) / 1024 / 1024).toFixed(2)),
  };
  console.log(JSON.stringify(report));
  const conservativeBoundaryFloor = Math.floor(requestedSeconds * 1000 / Math.max(20, segmentDelayMs * 4));
  assert.ok(boundaries >= conservativeBoundaryFloor, 'playout did not sustain the conservative boundary rate');
  assert.equal(skipped, 0, 'transient failures should recover without skipping a shot');
  assert.equal(reloads, injectedFailures, 'each injected failure should invoke the watchdog exactly once');
  assert.ok(activations > 0 || requestedSeconds < 2, 'no safe-boundary revision activation occurred');
  console.log('PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
