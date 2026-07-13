// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'motk-companion-camera-'));
const child = spawn(process.execPath, [join(root, 'cap-camera-sigma.mjs'), '--mock', '--production-root', temp], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
const request = (message) => new Promise((done, reject) => {
  pending.set(message.id, done); child.stdin.write(`${JSON.stringify(message)}\n`);
  setTimeout(() => { if (pending.delete(message.id)) reject(new Error(`camera request timeout: ${message.id}\n${stderr}`)); }, 5000).unref();
});
const context = { productionId: 'sample', production: 'Sample Production', shotId: 'SCENE_A_SHOT_001', take: 1 };

try {
  const live = await request({ id: 'live', cmd: 'camera.liveview' });
  if (!live.ok || !Buffer.from(live.liveview.jpeg, 'base64').length) throw new Error('mock live view returned no JPEG');
  const first = await request({ id: 'capture-1', cmd: 'camera.capture', context });
  if (!first.ok || first.files.length !== 1) throw new Error(first.error || 'first capture failed');
  const digest = createHash('sha256').update(readFileSync(first.files[0])).digest('hex');
  const second = await request({ id: 'capture-2', cmd: 'camera.capture', context });
  if (!second.ok || second.files.length !== 1 || second.files[0] === first.files[0]) throw new Error(second.error || 'repeat capture did not choose a unique file');
  if (createHash('sha256').update(readFileSync(first.files[0])).digest('hex') !== digest) throw new Error('repeat capture overwrote the first original');
  if (!second.files[0].endsWith('capture.1.jpg')) throw new Error(`unexpected collision name: ${second.files[0]}`);
  const set = await request({ id: 'settings', cmd: 'camera.settings.set', settings: { iso: '200' } });
  if (!set.ok || set.settings.iso !== '200') throw new Error('settings interface failed');
  const files = await request({ id: 'files', cmd: 'camera.files', context });
  if (!files.ok || files.files.length !== 2) throw new Error('files interface did not return both originals');
  console.log('PASS');
  console.log('Mock SIGMA adapter returned live view, applied settings, captured twice into raw with unique names, preserved the first original, and listed both files over correlated IPC.');
} finally {
  child.stdin.end(); child.kill('SIGTERM');
  await new Promise((done) => child.once('exit', done));
  rmSync(temp, { recursive: true, force: true });
}
