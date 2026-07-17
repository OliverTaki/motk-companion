import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [agent, helper] = await Promise.all([
  readFile(new URL('bridge/camera-agent.mjs', root), 'utf8'),
  readFile(new URL('bridge/sigma-sdk-helper.ps1', root), 'utf8'),
]);

for (const path of [
  '/sigma/exposure/mode', '/sigma/exposure/shutter', '/sigma/exposure/aperture',
  '/sigma/exposure/iso-auto', '/sigma/exposure/iso', '/sigma/image/white-balance',
  '/sigma/image/color-mode', '/sigma/image/quality', '/sigma/storage/destination',
]) assert.ok(agent.includes(path), `SIGMA control is missing: ${path}`);

assert.match(agent, /runSigma\('capture', \['-OutputDir', DIR, '-BaseName', base, \.\.\.sigmaOverrideArgs\(\)\]/);
assert.match(agent, /runSigma\('preview', \['-Output', target, \.\.\.sigmaOverrideArgs\(\)\]/);
assert.doesNotMatch(agent, /\[\[1, 'Camera card'\]/, 'MOTK captures must always create a computer original');
assert.match(helper, /sgm_SetCamDataGrp1/);
assert.match(helper, /whiteBalanceCode/);
assert.match(helper, /colorModeCode/);
assert.match(helper, /NormalizeCapturedFile\(target, stream\.ToArray\(\)\)/);
assert.match(helper, /if \(captureIssued && !captureCleared\) try \{ sgm_ClearImageDBSingle/);

console.log('MOTK Companion SIGMA SDK settings self-test: PASS');
