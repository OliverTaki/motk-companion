// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const wrappers = new Map([
  ['sigma', 'cap-camera-sigma.mjs'],
  ['gphoto2', 'cap-camera-gphoto2.mjs'],
  ['digicamcontrol', 'cap-camera-digicamcontrol.mjs'],
]);
const context = { productionId: 'sample', production: 'Sample Production', shotId: 'SCENE_A_SHOT_001', take: 1 };

async function verifyAdapter(vendor, entryPoint) {
  const temp = mkdtempSync(join(tmpdir(), `motk-companion-camera-${vendor}-`));
  const child = spawn(process.execPath, [join(root, entryPoint), '--mock', '--production-root', temp], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (message) => new Promise((done, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(message.id)) reject(new Error(`${vendor} camera request timeout: ${message.id}\n${stderr}`));
    }, 5000);
    timer.unref();
    pending.set(message.id, (result) => { clearTimeout(timer); done(result); });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  try {
    const live = await request({ id: `${vendor}-live`, cmd: 'camera.liveview' });
    if (!live.ok || !Buffer.from(live.liveview.jpeg, 'base64').length) throw new Error(`${vendor} mock live view returned no JPEG`);
    const first = await request({ id: `${vendor}-capture-1`, cmd: 'camera.capture', context });
    if (!first.ok || first.files.length !== 1) throw new Error(first.error || `${vendor} first capture failed`);
    const digest = createHash('sha256').update(readFileSync(first.files[0])).digest('hex');
    const second = await request({ id: `${vendor}-capture-2`, cmd: 'camera.capture', context });
    if (!second.ok || second.files.length !== 1 || second.files[0] === first.files[0]) throw new Error(second.error || `${vendor} repeat capture did not choose a unique file`);
    if (createHash('sha256').update(readFileSync(first.files[0])).digest('hex') !== digest) throw new Error(`${vendor} repeat capture overwrote the first original`);
    if (!second.files[0].endsWith('capture.1.jpg')) throw new Error(`${vendor} unexpected collision name: ${second.files[0]}`);
    const set = await request({ id: `${vendor}-settings`, cmd: 'camera.settings.set', settings: { iso: '200' } });
    if (!set.ok || set.settings.iso !== '200') throw new Error(`${vendor} settings interface failed`);
    const rejected = await request({ id: `${vendor}-unsupported-setting`, cmd: 'camera.settings.set', settings: { invented: 'value' } });
    if (rejected.ok || !/unsupported setting/i.test(rejected.error || '')) throw new Error(`${vendor} accepted an unknown setting`);
    const files = await request({ id: `${vendor}-files`, cmd: 'camera.files', context });
    if (!files.ok || files.files.length !== 2) throw new Error(`${vendor} files interface did not return both originals`);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((done) => child.once('exit', done));
    rmSync(temp, { recursive: true, force: true });
  }
}

for (const [vendor, entryPoint] of wrappers) await verifyAdapter(vendor, entryPoint);
console.log('PASS');
console.log('SIGMA, gPhoto2, and digiCamControl adapter wrappers all passed the same correlated IPC, settings validation, live-view payload, create-new capture, collision, and original-preservation contract with synthetic fixtures.');
