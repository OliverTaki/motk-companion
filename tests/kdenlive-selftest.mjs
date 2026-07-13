// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildKdenliveProject, editorialVersionFromRender, inspectKdenliveProject, refreshKdenliveProject } from '../cap-editor-kdenlive.mjs';

test('Kdenlive/MLT bridge preserves MOTK identities, trims, follow rules, and never overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'motk-kdenlive-'));
  try {
    mkdirSync(join(root, 'media'));
    writeFileSync(join(root, 'media', 'shot-a.mp4'), 'version-a');
    writeFileSync(join(root, 'media', 'shot-b.mp4'), 'version-b');
    const spec = { projectId: 'project_a', sequenceId: 'editorial_main', fps: 25, width: 1920, height: 1080, clips: [
      { shotId: 'shot_a', take: 1, versionId: 'version_a', fileRef: 'media/shot-a.mp4', trimIn: 2, trimOut: 18, followLatest: true },
      { shotId: 'shot_b', take: 2, versionId: 'version_b', fileRef: 'media/shot-b.mp4', trimIn: 0, trimOut: 24, followLatest: false },
    ] };
    const first = buildKdenliveProject(spec, { productionRoot: root, output: 'editorial/editorial_main.kdenlive' });
    const second = buildKdenliveProject(spec, { productionRoot: root, output: 'editorial/editorial_main.kdenlive' });
    assert.equal(first.collision, false); assert.equal(second.collision, true); assert.notEqual(first.path, second.path);
    assert.equal(first.profileId, 'atsc_1080p_25'); assert.deepEqual(first.warnings, []);
    const roundTrip = inspectKdenliveProject(first.path);
    assert.equal(roundTrip.projectId, 'project_a'); assert.equal(roundTrip.sequenceId, 'editorial_main');
    assert.deepEqual(roundTrip.clips.map(({ shotId, versionId, trimIn, trimOut, followLatest }) => ({ shotId, versionId, trimIn, trimOut, followLatest })), [
      { shotId: 'shot_a', versionId: 'version_a', trimIn: 2, trimOut: 18, followLatest: true },
      { shotId: 'shot_b', versionId: 'version_b', trimIn: 0, trimOut: 24, followLatest: false },
    ]);
    writeFileSync(join(root, 'editorial', 'render.mp4'), 'editorial-render');
    const version = editorialVersionFromRender({ projectId: 'project_a', shotId: 'editorial_main', versionId: 'editorial_v1', fileRef: 'editorial/render.mp4', durationFrames: 40 }, { productionRoot: root });
    assert.equal(version.kind, 'editorial'); assert.match(version.checksum, /^sha256:[a-f0-9]{64}$/); assert.equal(version.durationFrames, 40);
    assert.throws(() => inspectKdenliveProject('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///x">]><mlt/>'), /not allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Kdenlive refresh follows only opted-in shots and ripples duration while preserving trims', () => {
  const root = mkdtempSync(join(tmpdir(), 'motk-kdenlive-refresh-'));
  try {
    mkdirSync(join(root, 'media'));
    for (const name of ['shot-a-v1.mp4', 'shot-a-v2.mp4', 'shot-b-v1.mp4', 'shot-b-v2.mp4']) writeFileSync(join(root, 'media', name), name);
    const initial = buildKdenliveProject({ projectId: 'project_refresh', sequenceId: 'sequence_refresh', fps: 25, width: 1920, height: 1080, clips: [
      { shotId: 'shot_a', take: 1, versionId: 'shot_a_v1', fileRef: 'media/shot-a-v1.mp4', durationFrames: 20, trimIn: 2, trimOut: 18, followLatest: true },
      { shotId: 'shot_b', take: 1, versionId: 'shot_b_v1', fileRef: 'media/shot-b-v1.mp4', durationFrames: 24, trimIn: 0, trimOut: 24, followLatest: false },
    ] }, { productionRoot: root, output: 'editorial/sequence_refresh.kdenlive' });
    const checksum = `sha256:${'a'.repeat(64)}`;
    const refreshed = refreshKdenliveProject(initial.path, [
      { projectId: 'project_refresh', shotId: 'shot_a', take: 2, versionId: 'shot_a_v2', kind: 'player-proxy', fileRef: 'media/shot-a-v2.mp4', durationFrames: 30, checksum, valid: true, createdAt: '2026-07-13T10:00:00Z' },
      { projectId: 'project_refresh', shotId: 'shot_b', take: 2, versionId: 'shot_b_v2', kind: 'player-proxy', fileRef: 'media/shot-b-v2.mp4', durationFrames: 40, checksum, valid: true, createdAt: '2026-07-13T10:00:00Z' },
    ], { productionRoot: root, output: 'editorial/sequence_refresh.latest.kdenlive', fps: 25, width: 1920, height: 1080 });
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.collision, false);
    assert.equal(refreshed.durationFrames, 50);
    assert.deepEqual(refreshed.changes.map(({ shotId, fromVersionId, toVersionId }) => ({ shotId, fromVersionId, toVersionId })), [{ shotId: 'shot_a', fromVersionId: 'shot_a_v1', toVersionId: 'shot_a_v2' }]);
    const inspected = inspectKdenliveProject(refreshed.path);
    assert.deepEqual(inspected.clips.map(({ shotId, versionId, trimIn, trimOut, sourceDurationFrames }) => ({ shotId, versionId, trimIn, trimOut, sourceDurationFrames })), [
      { shotId: 'shot_a', versionId: 'shot_a_v2', trimIn: 2, trimOut: 28, sourceDurationFrames: 30 },
      { shotId: 'shot_b', versionId: 'shot_b_v1', trimIn: 0, trimOut: 24, sourceDurationFrames: 24 },
    ]);
    const unchanged = refreshKdenliveProject(refreshed.path, [{ projectId: 'project_refresh', shotId: 'shot_a', take: 2, versionId: 'shot_a_v2', kind: 'player-proxy', fileRef: 'media/shot-a-v2.mp4', durationFrames: 30, checksum, valid: true, createdAt: '2026-07-13T10:00:00Z' }], { productionRoot: root, fps: 25, width: 1920, height: 1080 });
    assert.equal(unchanged.changed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Kdenlive standalone MLT opens and renders a generated MOTK project', { skip: !process.env.MOTK_KDENLIVE_BIN }, () => {
  const bin = process.env.MOTK_KDENLIVE_BIN;
  const executable = (name) => join(bin, process.platform === 'win32' ? `${name}.exe` : name);
  const ffmpeg = executable('ffmpeg');
  const ffprobe = executable('ffprobe');
  const melt = executable('melt');
  const kdenlive = executable('kdenlive');
  for (const command of [ffmpeg, ffprobe, melt, kdenlive]) assert.equal(existsSync(command), true, `${command} is missing`);

  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: bin, encoding: 'utf8', env: { ...process.env, OFX_PLUGIN_PATH: join(root, 'empty-ofx'), PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` } });
    assert.equal(result.status, 0, `${command} failed\n${result.stdout || ''}\n${result.stderr || ''}`);
    return result;
  };
  const root = mkdtempSync(join(tmpdir(), 'motk-kdenlive-runtime-'));
  try {
    mkdirSync(join(root, 'media'));
    mkdirSync(join(root, 'empty-ofx'));
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(root, 'media', 'shot-a.mp4')]);
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(root, 'media', 'shot-b.mp4')]);
    const project = buildKdenliveProject({ projectId: 'runtime_project', sequenceId: 'runtime_sequence', fps: 25, width: 1280, height: 720, clips: [
      { shotId: 'shot_a', take: 1, versionId: 'version_a', fileRef: 'media/shot-a.mp4', trimIn: 2, trimOut: 18, followLatest: true },
      { shotId: 'shot_b', take: 2, versionId: 'version_b', fileRef: 'media/shot-b.mp4', trimIn: 0, trimOut: 24, followLatest: false },
    ] }, { productionRoot: root, output: 'editorial/runtime_sequence.kdenlive' });
    const output = join(root, 'editorial', 'runtime-render.mp4');
    run(melt, [project.path, '-consumer', `avformat:${output}`, 'vcodec=libx264', 'pix_fmt=yuv420p', 'an=1']);
    assert.equal(existsSync(output), true);
    assert.ok(statSync(output).size > 1000, 'rendered output is unexpectedly small');
    const probe = run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', output]);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.width, 1280);
    assert.equal(stream.height, 720);
    assert.equal(Number(stream.nb_read_frames), 40);
    const kdenliveOutput = join(root, 'editorial', 'kdenlive-direct-render.mp4');
    run(kdenlive, ['--config', join(root, 'kdenliverc'), '--no-welcome', '--render', project.path, kdenliveOutput]);
    assert.equal(existsSync(kdenliveOutput), true);
    const kdenliveProbe = run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', kdenliveOutput]);
    const kdenliveStream = JSON.parse(kdenliveProbe.stdout).streams[0];
    assert.equal(kdenliveStream.width, 1280);
    assert.equal(kdenliveStream.height, 720);
    assert.equal(Number(kdenliveStream.nb_read_frames), 40);
    const roundTrip = inspectKdenliveProject(project.path);
    assert.deepEqual(roundTrip.clips.map(({ shotId, versionId }) => ({ shotId, versionId })), [
      { shotId: 'shot_a', versionId: 'version_a' },
      { shotId: 'shot_b', versionId: 'version_b' },
    ]);
  } finally {
    if (process.env.MOTK_KDENLIVE_KEEP) console.error(`Kdenlive runtime fixture kept at ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
});
