// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../cap-runner.mjs';
import { JournalJobStore } from '../lib/job-store.mjs';

const temp = mkdtempSync(join(tmpdir(), 'motk-companion-runner-'));
const takeFolder = join(temp, 'Sample Production', 'SCENE_A_SHOT_001', 'T01');
const framesFolder = join(takeFolder, 'frames');
mkdirSync(framesFolder, { recursive: true });
for (let index = 1; index <= 24; index += 1) {
  const width = 48; const height = 32; const pixels = Buffer.alloc(width * height * 3, index * 7);
  writeFileSync(join(framesFolder, `frame_${String(index).padStart(5, '0')}.ppm`), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
}
const recipe = {
  recipe: 'post-capture-basic', version: 1, on: { event: 'shoot.take:reported' },
  steps: [
    { id: 'validate', uses: 'sequence.validate', with: { path: '{framesFolder}' } },
    { id: 'proxy', uses: 'encode.ffmpeg', needs: ['validate'], with: { preset: 'player-proxy-1080p25', pattern: 'frame_%05d.ppm', output: '{takeFolder}/proxy/player.mp4' } },
    { id: 'nas-copy', uses: 'file.copy', needs: ['proxy'], with: { from: '{proxy.output}', to: '{nasRoot}/{shotId}/T{take:02}' } },
    { id: 'upload', uses: 'upload.enqueue', needs: ['proxy'], with: { target: 'fs:PROXY', from: '{proxy.output}' } },
    { id: 'register', uses: 'motk.version.register', needs: ['nas-copy', 'upload'] },
    { id: 'assembly', uses: 'playout.assembly.invalidate', needs: ['register'] },
  ],
};
const context = { projectId: 'project_sample', shotId: 'SCENE_A_SHOT_001', take: 1, fps: 25, takeFolder, framesFolder, nasRoot: join(temp, 'NAS') };
const storePath = join(temp, 'state', 'jobs.jsonl');
const listTree = (directory) => {
  const out = [];
  const walk = (path) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) walk(child); else out.push(`${child}:${statSync(child).size}`); } };
  walk(directory); return out.sort();
};

try {
  let interrupted = false;
  const first = new Runner({
    productionRoot: temp, store: new JournalJobStore(storePath), recipes: [recipe], stubExternal: true,
    afterStep: (step) => { if (step.id === 'proxy') throw new Error('simulated process termination'); },
  });
  try { await first.handleEvent('shoot.take:reported', context); } catch (error) { interrupted = error.message === 'simulated process termination'; }
  if (!interrupted) throw new Error('runner was not interrupted after encode');
  const proxyPath = join(takeFolder, 'proxy', 'player.mp4');
  const encodedMtime = statSync(proxyPath).mtimeMs;
  if (readdirSync(temp).includes('NAS')) throw new Error('copy ran before interruption');

  const restarted = new Runner({ productionRoot: temp, store: new JournalJobStore(storePath), recipes: [recipe], stubExternal: true });
  const resumed = await restarted.resumeAll();
  if (resumed[0]?.status !== 'completed') throw new Error('restarted runner did not complete');
  if (statSync(proxyPath).mtimeMs !== encodedMtime) throw new Error('resume re-encoded the completed proxy step');
  const copied = join(temp, 'NAS', context.shotId, 'T01', 'player.mp4');
  if (statSync(copied).size !== statSync(proxyPath).size) throw new Error('NAS copy is missing or differs');

  const beforeDryRun = listTree(temp);
  const report = await restarted.run(recipe, context, { dryRun: true });
  const afterDryRun = listTree(temp);
  if (JSON.stringify(beforeDryRun) !== JSON.stringify(afterDryRun)) throw new Error('dry-run changed files');
  if (!report.dryRun || !report.files.length || !report.collisions.length) throw new Error('dry-run report lacks file/collision information');
  const invalidRecipe = { recipe: 'missing-copy-source', version: 1, on: { event: 'manual' }, steps: [{ id: 'copy', uses: 'file.copy', retries: 0, with: { to: 'output' } }] };
  let clearCopyError = false;
  try { await restarted.run(invalidRecipe, context); } catch (error) { clearCopyError = error.message.includes("requires 'from'"); }
  if (!clearCopyError) throw new Error('file.copy did not return a clear missing-source error');
  let invalidIdentityRejected = false;
  try { await restarted.run(recipe, { ...context, projectId: '../outside' }, { dryRun: true }); } catch (error) { invalidIdentityRejected = error.message === 'projectId is invalid'; }
  if (!invalidIdentityRejected) throw new Error('runner did not enforce the canonical identity contract');
  console.log('PASS');
  console.log('Triggered post-capture-basic, resumed after interruption without re-encoding, completed proxy-to-copy flow with M4 stubs, produced a side-effect-free dry-run report, and enforced canonical identities.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
