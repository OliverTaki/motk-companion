import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [controlCenter, installer, companion] = await Promise.all([
  readFile(new URL('packaging/windows/control-center.ps1', root), 'utf8'),
  readFile(new URL('packaging/windows/install.ps1', root), 'utf8'),
  readFile(new URL('companion.mjs', root), 'utf8'),
]);

assert.match(controlCenter, /function Restart-InstalledCompanion/);
const saveHandler = controlCenter.slice(controlCenter.indexOf('$saveButton.Add_Click'), controlCenter.indexOf('$timer ='));
assert.match(saveHandler, /Save-CompanionSettings/);
assert.match(saveHandler, /Restart-InstalledCompanion/);
assert.match(controlCenter, /Join-Path \$rootPath 'Camera Originals'/);
assert.match(installer, /Camera Originals/);
assert.match(installer, /Move-Item -LiteralPath \$legacyCapture -Destination \$visibleCapture/);
assert.match(companion, /\.\/production\/Camera Originals/);

console.log('MOTK Companion Control Center settings self-test: PASS');
