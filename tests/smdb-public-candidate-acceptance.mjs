// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = resolve(process.env.MOTK_ACCEPTANCE_APP_ROOT || '');
if (!process.env.MOTK_ACCEPTANCE_APP_ROOT || !existsSync(join(appRoot, 'cap-runner.mjs'))) throw new Error('MOTK_ACCEPTANCE_APP_ROOT must point to the installed public candidate app directory');
const load = (relative) => import(pathToFileURL(join(appRoot, relative)).href);
const { Runner } = await load('cap-runner.mjs');
const { JournalJobStore } = await load('lib/job-store.mjs');
const { buildAssembly } = await load('assembly.mjs');
const { PlayoutPlayer } = await load('cap-playout.mjs');

const temp = mkdtempSync(join(tmpdir(), 'motk-smdb-public-acceptance-'));
const productionRoot = join(temp, 'production');
const takeFolder = join(productionRoot, 'Disposable Production', 'SHOT_001', 'T01');
const framesFolder = join(takeFolder, 'frames');
mkdirSync(framesFolder, { recursive: true });
for (let index = 1; index <= 24; index += 1) {
  const pixels = Buffer.alloc(32 * 24 * 3, index * 6);
  writeFileSync(join(framesFolder, `frame_${String(index).padStart(5, '0')}.ppm`), Buffer.concat([Buffer.from('P6\n32 24\n255\n'), pixels]));
}

const uploadRoot = join(temp, 'upload-target');
const registrations = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    registrations.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/companion`;
const playoutEvents = [];
const player = new PlayoutPlayer({ productionRoot: uploadRoot, cacheRoot: join(temp, 'cache'), backend: { play: async () => {}, reload: async () => {} }, onEvent: (event) => playoutEvents.push(event) });
const recipe = {
  recipe: 'smdb-public-candidate', version: 1, on: { event: 'shoot.take:reported' }, steps: [
    { id: 'validate', uses: 'sequence.validate', with: { path: '{framesFolder}' } },
    { id: 'proxy', uses: 'encode.ffmpeg', needs: ['validate'], with: { preset: 'player-proxy-1080p25', pattern: 'frame_%05d.ppm', output: '{takeFolder}/proxy/player.mp4' } },
    { id: 'nas-copy', uses: 'file.copy', needs: ['proxy'], with: { from: '{proxy.output}', to: '{nasRoot}/{shotId}/T{take:02}' } },
    { id: 'upload', uses: 'upload.enqueue', needs: ['proxy'], with: { target: 'fs:PROXY', from: '{proxy.output}' } },
    { id: 'register', uses: 'motk.version.register', needs: ['nas-copy', 'upload'] },
    { id: 'assembly', uses: 'playout.assembly.invalidate', needs: ['register'] },
  ],
};
const context = { projectId: 'smdb_disposable', shotId: 'SHOT_001', take: 1, fps: 25, takeFolder, framesFolder, nasRoot: join(productionRoot, 'simulated-storage') };
let readyManifest;

try {
  const runner = new Runner({
    productionRoot,
    store: new JournalJobStore(join(temp, 'state', 'jobs.jsonl')),
    recipes: [recipe],
    motkEndpoint: endpoint,
    uploadTargets: { 'fs:PROXY': { type: 'fs', root: uploadRoot } },
    assemblyHandler: async ({ artifacts }) => {
      readyManifest = buildAssembly({ productionRoot: uploadRoot, shots: [{ shotId: context.shotId }], versions: [{ shotId: context.shotId, versionId: 'version_proxy_1', file: artifacts.upload.output, valid: true, updatedAt: new Date().toISOString() }] });
      await player.load(readyManifest);
      player.queueRevision({ ...readyManifest, revisionId: `${readyManifest.revisionId}_active` });
      return { revisionId: readyManifest.revisionId };
    },
  });
  const [result] = await runner.handleEvent('shoot.take:reported', context);
  if (result.status !== 'completed' || !readyManifest?.segments.length) throw new Error('public candidate did not reach assembly');
  if (registrations.length !== 1 || registrations[0].action !== 'version.register') throw new Error('public candidate did not register exactly one Version');
  await player.playOne();
  if (!playoutEvents.some((event) => event.event === 'playout.revision:activated')) throw new Error('public candidate did not activate at the next boundary');
  console.log(JSON.stringify({ ok: true, frames: 24, registrations: registrations.length, assemblySegments: readyManifest.segments.length, safeBoundaryActivation: true }));
} finally {
  await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
}
