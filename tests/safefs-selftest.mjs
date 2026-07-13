// SPDX-License-Identifier: GPL-3.0-or-later
// Guards the sandbox boundary: `..` escapes, Windows cross-drive absolutes,
// and the raw/ read-only rule must all throw; in-root paths must resolve.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { sandboxResolve, assertWritablePath, writeNewFile } from '../lib/safe-fs.mjs';

const root = mkdtempSync(join(tmpdir(), 'safefs-'));
const failures = [];
const expectThrow = (label, fn) => { try { fn(); failures.push(label); } catch { /* expected */ } };
const expectOk = (label, fn) => { try { fn(); } catch (error) { failures.push(`${label}: ${error.message}`); } };

try {
  expectOk('in-root resolves', () => sandboxResolve(root, 'prod', 'SH010', 'T01'));
  expectThrow('dotdot escape', () => sandboxResolve(root, '..', 'evil'));
  expectThrow('nested dotdot escape', () => sandboxResolve(root, 'a', '..', '..', 'evil'));

  const rootDrive = parse(resolve(root)).root; // e.g. C:\ or /
  const otherAbsolute = rootDrive.toLowerCase().startsWith('c')
    ? 'D:\\evil\\path' : join(rootDrive, '..', 'evil');
  if (process.platform === 'win32') {
    expectThrow('cross-drive absolute', () => sandboxResolve(root, otherAbsolute));
  }
  expectThrow('absolute outside root', () => sandboxResolve(root, resolve(root, '..', 'sibling')));

  expectThrow('raw is read-only', () => assertWritablePath(root, join(root, 'prod', 'SH010', 'T01', 'raw', 'x.dng')));
  expectOk('raw allowed with flag', () => assertWritablePath(root, join(root, 'p', 'raw', 'kdr_1.dng'), { allowOriginalCreate: true }));

  const first = writeNewFile(root, join(root, 'p', 'out.txt'), 'a');
  const second = writeNewFile(root, join(root, 'p', 'out.txt'), 'b');
  if (second.path === first.path || !second.collision) failures.push('collision suffixing failed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.log('FAIL');
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log('PASS');
console.log('Sandbox rejected dotdot and cross-drive escapes, enforced raw read-only, and collision-suffixed duplicate writes.');
