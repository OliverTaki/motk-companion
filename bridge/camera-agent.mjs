/* MOTK Shoot camera/production agent — fires the real camera shutter, keeps
 * RAW/JPEG originals, and mirrors complete shot folders. Node 18+, zero deps.
 *
 *   node bridge/camera-agent.mjs [--port 8793] [--dir ./originals]
 *                                [--backend auto|sigma|gphoto2|digicam|dummy]
 *                                [--sigma-sdk-zip "C:\\path\\CameraControlSDK_for_Win.zip"]
 *                                [--sigma-serial SERIAL]
 *                                [--allow-origin https://trusted.example]
 *                                [--token-store ./config/pairing-token.json]
 *                                [--digicam "C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe"]
 *                                [--host 127.0.0.1] [--serve-app]
 *
 * Backends:
 *   gphoto2  (macOS/Linux)  — `gphoto2 --capture-image-and-download`; set the
 *            camera to RAW+JPEG to get both files. Shutter speed/ISO/aperture
 *            come from the camera body (or set them with gphoto2 beforehand).
 *   digicam  (Windows)      — digiCamControl's CameraControlCmd.exe /capture.
 *   sigma    (Windows)      — user's licensed SIGMA Camera Control SDK ZIP.
 *   dummy                   — writes fake files; for testing the pipeline.
 *
 * MOTK Shoot connects here from the Camera tab → Tether section.
 */
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreatePairingRecord, pairingTokenMatches, tokenFromUpgradeRequest } from './pairing-token.mjs';
import { copyNewFile, writeNewFile } from '../lib/safe-fs.mjs';

/* ---------- CLI ---------- */
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(arg('port', '8793'), 10);
const HOST = arg('host', '127.0.0.1');
const SERVE_APP = args.includes('--serve-app');
const ALLOW_ORIGIN = arg('allow-origin', '');
const DIR = resolve(arg('dir', './originals'));
const PRODUCTION_ROOT = resolve(arg('production-root', './productions'));
const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUIRE_TOKEN = true;
const TOKEN_STORE = resolve(arg('token-store', join(APP_ROOT, 'config', 'pairing-token.json')));
const PAIRING_CLAIMS = [
  'bridge.connect', 'observer.publish', 'observer.subscribe',
  'production.read', 'production.write', 'shoot.camera_configure', 'shoot.capture',
];
const pairingRecord = REQUIRE_TOKEN
  ? loadOrCreatePairingRecord(TOKEN_STORE, PAIRING_CLAIMS)
  : { token: '', claims: PAIRING_CLAIMS, created: false };
if (pairingRecord.created) console.log(`[pairing] token (shown once): ${pairingRecord.token}`);
const DIGICAM = arg('digicam', 'C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe');
const SIGMA_SDK_ZIP = arg('sigma-sdk-zip', '');
const SIGMA_SERIAL = arg('sigma-serial', '');
const SIGMA_HELPER = join(APP_ROOT, 'bridge', 'sigma-sdk-helper.ps1');
let BACKEND = arg('backend', 'auto');

mkdirSync(DIR, { recursive: true });
mkdirSync(PRODUCTION_ROOT, { recursive: true });

const safeSegment = (value, fallback) => {
  const clean = String(value || '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 80);
  return !clean || clean === '.' || clean === '..' ? fallback : clean;
};
const productionPaths = (context) => {
  if (!context || !context.shotId || !context.take) throw new Error('production context is required');
  const production = safeSegment(context.production, safeSegment(context.productionId, 'Production'));
  const shotId = safeSegment(context.shotId, 'SHOT');
  const takeNumber = Math.max(1, Math.min(9999, parseInt(context.take, 10) || 1));
  const productionDir = join(PRODUCTION_ROOT, production);
  const shot = join(productionDir, shotId);
  const take = join(shot, 'T' + String(takeNumber).padStart(2, '0'));
  const paths = {
    production: productionDir, shot, take,
    frames: join(take, 'frames'), raw: join(take, 'raw'), audio: join(take, 'audio'),
    previz: join(shot, 'previz'), plates: join(shot, 'plates'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
};
const writeSafe = (path, data) => writeNewFile(PRODUCTION_ROOT, path, data);
const EDITORIAL_FILES = new Set([
  'editorial.edl', 'editorial.fcpxml', 'editorial_aaf_lite.json',
  'editorial.json', 'conform_active_edit.ffconcat', 'conform_recipe.txt',
]);
const decodeBase64 = (value, maxBytes) => {
  const buffer = Buffer.from(String(value || ''), 'base64');
  if (!buffer.length) throw new Error('file payload is empty');
  if (buffer.length > maxBytes) throw new Error('file payload is too large');
  return buffer;
};
const mirrorRawFiles = (files, context) => {
  if (!context || !files?.length) return [];
  const paths = productionPaths(context);
  const copied = [];
  for (const source of files) {
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    const target = join(paths.raw, safeSegment(basename(source), 'original.bin'));
    const written = copyNewFile(PRODUCTION_ROOT, source, target, { allowOriginalCreate: true });
    copied.push(written.path);
  }
  return copied;
};

const run = (cmd, cmdArgs, timeout = 40000) => new Promise((res) => {
  execFile(cmd, cmdArgs, { timeout, windowsHide: true }, (err, stdout, stderr) => {
    res({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});
const runBuffer = (cmd, cmdArgs, timeout = 40000) => new Promise((res) => {
  execFile(cmd, cmdArgs, { timeout, windowsHide: true, encoding: null, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => res({
      err,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
      stderr: Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr || ''),
    }));
});
const sigmaArgs = (command, extra = []) => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', SIGMA_HELPER, '-Command', command, '-SdkZip', SIGMA_SDK_ZIP,
  ...(SIGMA_SERIAL ? ['-Serial', SIGMA_SERIAL] : []), ...extra,
];
const runSigma = async (command, extra = [], timeout = 60000) => {
  if (process.platform !== 'win32') throw new Error('the SIGMA SDK backend requires Windows');
  if (!SIGMA_SDK_ZIP || !existsSync(SIGMA_SDK_ZIP)) throw new Error('pass the licensed SDK ZIP with --sigma-sdk-zip');
  const r = await run('powershell.exe', sigmaArgs(command, extra), timeout);
  let result;
  try { result = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch { result = {}; }
  if (r.err || !result.ok) throw new Error(result.error || r.stderr.trim() || r.err?.message || `SIGMA ${command} failed`);
  return result;
};
let cameraQueue = Promise.resolve();
const withCamera = (fn) => {
  const next = cameraQueue.then(fn, fn);
  cameraQueue = next.catch(() => {});
  return next;
};

const CONFIG_LEAVES = [
  'shutterspeed', 'iso', 'f-number', 'aperture', 'whitebalance',
  'imageformat', 'imagequality', 'focusmode', 'manualfocusdrive',
];
const dummyConfig = new Map([
  ['/main/capturesettings/shutterspeed', { label: 'Shutter speed', type: 'RADIO', current: '1/24', choices: ['1/12', '1/24', '1/48'] }],
  ['/main/imgsettings/iso', { label: 'ISO', type: 'RADIO', current: '100', choices: ['100', '200', '400', '800'] }],
  ['/main/capturesettings/f-number', { label: 'Aperture', type: 'RADIO', current: 'f/4', choices: ['f/2.8', 'f/4', 'f/5.6', 'f/8'] }],
  ['/main/imgsettings/whitebalance', { label: 'White balance', type: 'RADIO', current: 'Daylight', choices: ['Auto', 'Daylight', 'Tungsten'] }],
  ['/main/imgsettings/imageformat', { label: 'Image format', type: 'RADIO', current: 'RAW + JPEG', choices: ['JPEG', 'RAW', 'RAW + JPEG'] }],
  ['/main/actions/manualfocusdrive', { label: 'Focus drive', type: 'RADIO', current: 'None', choices: ['Near 3', 'Near 2', 'Near 1', 'None', 'Far 1', 'Far 2', 'Far 3'] }],
]);
let allowedConfigPaths = new Set(dummyConfig.keys());

const sigmaChoice = (entries) => entries.map(([code, label]) => ({ code, label }));
const sigmaConfigs = new Map([
  ['/sigma/exposure/mode', { label: 'Exposure mode', probe: 'exposureMode', arg: '-ExposureMode', choices: sigmaChoice([[1, 'P'], [2, 'A'], [3, 'S'], [4, 'M']]) }],
  ['/sigma/exposure/shutter', { label: 'Shutter speed', probe: 'shutterCode', arg: '-ShutterCode', choices: sigmaChoice([
    [16, '30 s'], [19, '25 s'], [21, '20 s'], [24, '15 s'], [27, '13 s'], [29, '10 s'], [32, '8 s'], [35, '6 s'], [37, '5 s'], [40, '4 s'], [43, '3.2 s'], [45, '2.5 s'], [48, '2 s'], [51, '1.6 s'], [53, '1.3 s'], [56, '1 s'], [59, '0.8 s'], [61, '0.6 s'], [64, '0.5 s'], [67, '0.4 s'], [69, '0.3 s'], [72, '1/4'], [75, '1/5'], [77, '1/6'], [80, '1/8'], [83, '1/10'], [85, '1/13'], [88, '1/15'], [91, '1/20'], [93, '1/25'], [96, '1/30'], [99, '1/40'], [101, '1/50'], [104, '1/60'], [107, '1/80'], [109, '1/100'], [112, '1/125'], [115, '1/160'], [117, '1/200'], [120, '1/250'], [123, '1/320'], [125, '1/400'], [128, '1/500'], [131, '1/640'], [133, '1/800'], [136, '1/1000'], [139, '1/1250'], [141, '1/1600'], [144, '1/2000'], [147, '1/2500'], [149, '1/3200'], [152, '1/4000'], [155, '1/5000'], [157, '1/6000'], [160, '1/8000'],
  ]) }],
  ['/sigma/exposure/aperture', { label: 'Aperture', probe: 'apertureCode', arg: '-ApertureCode', choices: sigmaChoice([
    [8, 'f/1.0'], [11, 'f/1.1'], [13, 'f/1.2'], [16, 'f/1.4'], [19, 'f/1.6'], [21, 'f/1.8'], [24, 'f/2.0'], [27, 'f/2.2'], [29, 'f/2.5'], [32, 'f/2.8'], [35, 'f/3.2'], [37, 'f/3.5'], [40, 'f/4.0'], [43, 'f/4.5'], [45, 'f/5.0'], [48, 'f/5.6'], [51, 'f/6.3'], [53, 'f/7.1'], [56, 'f/8.0'], [59, 'f/9.0'], [61, 'f/10'], [64, 'f/11'], [67, 'f/13'], [69, 'f/14'], [72, 'f/16'], [75, 'f/18'], [77, 'f/20'], [80, 'f/22'],
  ]) }],
  ['/sigma/exposure/iso-auto', { label: 'ISO control', probe: 'isoAuto', arg: '-ISOAuto', choices: sigmaChoice([[1, 'Auto'], [0, 'Manual']]) }],
  ['/sigma/exposure/iso', { label: 'ISO', probe: 'isoCode', arg: '-ISOCode', choices: sigmaChoice([['auto', 'Auto'], [31, '100'], [35, '125'], [37, '160'], [40, '200'], [43, '250'], [45, '320'], [48, '400'], [51, '500'], [53, '640'], [56, '800'], [59, '1000'], [61, '1250'], [64, '1600'], [67, '2000'], [69, '2500'], [72, '3200'], [75, '4000'], [77, '5000'], [80, '6400']]) }],
  ['/sigma/image/white-balance', { label: 'White balance', probe: 'whiteBalanceCode', arg: '-WhiteBalanceCode', choices: sigmaChoice([[1, 'Auto'], [2, 'Daylight'], [3, 'Shade'], [4, 'Cloudy'], [5, 'Incandescent'], [6, 'Fluorescent'], [7, 'Flash'], [8, 'Custom 1'], [10, 'Custom 2'], [12, 'Custom 3'], [14, 'Color temperature'], [15, 'Auto · light source priority']]) }],
  ['/sigma/image/color-mode', { label: 'Color mode', probe: 'colorModeCode', arg: '-ColorModeCode', choices: sigmaChoice([[0, 'Normal'], [1, 'Sepia'], [2, 'Monochrome'], [3, 'Standard'], [4, 'Vivid'], [5, 'Neutral'], [6, 'Portrait'], [7, 'Landscape'], [8, 'FOV Classic Blue'], [9, 'Sunset Red'], [10, 'Forest Green'], [11, 'Cinema'], [12, 'FOV Classic Yellow'], [13, 'Teal and Orange'], [14, 'Off'], [15, 'Powder Blue'], [16, 'Duotone'], [17, 'Warm Gold']]) }],
  ['/sigma/image/quality', { label: 'Image quality', probe: 'imageQuality', arg: '-ImageQuality', choices: sigmaChoice([[2, 'JPEG Fine'], [4, 'JPEG Normal'], [8, 'JPEG Basic'], [16, 'DNG'], [18, 'DNG + JPEG Fine']]) }],
  ['/sigma/storage/destination', { label: 'Save to', probe: 'destination', arg: '-Destination', choices: sigmaChoice([[2, 'Computer'], [3, 'Camera card + computer']]) }],
]);

const sigmaConfigFromProbe = (path, definition, probe) => {
  if (path === '/sigma/exposure/iso' && Number(probe?.isoAuto) === 1) {
    return { path, label: definition.label, type: 'RADIO', current: 'Auto', choices: definition.choices.map((choice) => choice.label), readonly: false };
  }
  const code = Number(probe?.[definition.probe]);
  const selected = definition.choices.find((choice) => choice.code === code);
  return { path, label: definition.label, type: 'RADIO', current: selected?.label || `Code ${code}`, choices: definition.choices.map((choice) => choice.label), readonly: false };
};
const sigmaConfigCode = (definition, value) => {
  const selected = definition.choices.find((choice) => choice.label === String(value) || String(choice.code) === String(value));
  if (!selected) throw new Error(`invalid ${definition.label.toLowerCase()}: ${value}`);
  return selected.code;
};
const sigmaOverrides = new Map();
let sigmaProbeCache = null;
let lastConfigError = null;
const sigmaConfigView = (path, definition, probe) => {
  const base = sigmaConfigFromProbe(path, definition, probe);
  if (!sigmaOverrides.has(path)) return base;
  const selected = definition.choices.find((choice) => choice.code === sigmaOverrides.get(path));
  return { ...base, current: selected?.label || base.current };
};
const sigmaOverrideArgs = () => {
  const output = [];
  for (const [path, code] of sigmaOverrides) {
    const definition = sigmaConfigs.get(path);
    if (definition) output.push(definition.arg, String(code));
  }
  return output;
};

function parseConfig(text, path) {
  const out = { path, label: path.split('/').pop(), type: 'TEXT', current: '', choices: [], readonly: false };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'label') out.label = value;
    else if (key === 'type') out.type = value.toUpperCase();
    else if (key === 'current') out.current = value;
    else if (key === 'readonly') out.readonly = value === '1';
    else if (key === 'choice') out.choices.push(value.replace(/^\d+\s+/, ''));
    else if (key === 'bottom' || key === 'top' || key === 'step') out[key] = Number(value);
  }
  return out;
}

async function getConfigDirect(path) {
  if (!allowedConfigPaths.has(path)) throw new Error('unknown camera config: ' + path);
  if (BACKEND === 'dummy') return { path, ...dummyConfig.get(path) };
  if (BACKEND === 'sigma') {
    const definition = sigmaConfigs.get(path);
    if (!sigmaProbeCache) sigmaProbeCache = await runSigma('probe');
    return sigmaConfigView(path, definition, sigmaProbeCache);
  }
  if (BACKEND !== 'gphoto2') throw new Error(`camera settings are not available for the ${BACKEND} backend`);
  const r = await run('gphoto2', ['--get-config', path], 10000);
  if (r.err) throw new Error(r.stderr.trim() || r.err.message);
  return parseConfig(r.stdout, path);
}
const getConfig = (path) => withCamera(() => getConfigDirect(path));

async function listConfigsDirect() {
  if (BACKEND === 'dummy') return [...dummyConfig].map(([path, config]) => ({ path, ...config }));
  if (BACKEND === 'sigma') {
    allowedConfigPaths = new Set(sigmaConfigs.keys());
    sigmaProbeCache = await runSigma('probe');
    return [...sigmaConfigs]
      .filter(([path]) => path !== '/sigma/exposure/iso-auto')
      .map(([path, definition]) => sigmaConfigView(path, definition, sigmaProbeCache));
  }
  if (BACKEND !== 'gphoto2') return [];
  const r = await run('gphoto2', ['--list-config'], 10000);
  if (r.err) throw new Error(r.stderr.trim() || r.err.message);
  const paths = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('/'));
  const selected = [];
  for (const leaf of CONFIG_LEAVES) {
    const match = paths.find((path) => path.split('/').pop().toLowerCase() === leaf);
    if (match && !selected.includes(match)) selected.push(match);
  }
  allowedConfigPaths = new Set(selected);
  const configs = [];
  for (const path of selected) configs.push(await getConfigDirect(path));
  return configs;
}
const listConfigs = () => withCamera(listConfigsDirect);

async function setConfigDirect(path, value) {
  if (!allowedConfigPaths.has(path)) throw new Error('unknown camera config: ' + path);
  if (BACKEND === 'dummy') {
    const config = dummyConfig.get(path);
    if (config.choices.length && !config.choices.includes(String(value))) throw new Error('invalid config value');
    config.current = String(value);
    return getConfigDirect(path);
  }
  if (BACKEND === 'sigma') {
    const definition = sigmaConfigs.get(path);
    if (path === '/sigma/exposure/iso' && String(value).toLowerCase() === 'auto') {
      // Auto lives inside the ISO choice list; there is no separate mode toggle.
      sigmaOverrides.delete('/sigma/exposure/iso');
      sigmaOverrides.set('/sigma/exposure/iso-auto', 1);
      return sigmaConfigView(path, definition, sigmaProbeCache || {});
    }
    const code = sigmaConfigCode(definition, value);
    sigmaOverrides.set(path, code);
    if (path === '/sigma/exposure/iso') sigmaOverrides.set('/sigma/exposure/iso-auto', 0);
    return sigmaConfigView(path, definition, sigmaProbeCache || {});
  }
  if (BACKEND !== 'gphoto2') throw new Error(`camera settings are not available for the ${BACKEND} backend`);
  const r = await run('gphoto2', ['--set-config', `${path}=${value}`], 10000);
  if (r.err) throw new Error(r.stderr.trim() || r.err.message);
  return getConfigDirect(path);
}
const setConfig = (path, value) => withCamera(() => setConfigDirect(path, value));

/* ---------- backend detection ---------- */
if (BACKEND === 'auto') {
  if (process.platform === 'win32' && SIGMA_SDK_ZIP) {
    await runSigma('probe');
    BACKEND = 'sigma';
  } else {
    const g = await run(process.platform === 'win32' ? 'gphoto2.exe' : 'gphoto2', ['--version'], 4000);
    if (!g.err) BACKEND = 'gphoto2';
  else if (process.platform === 'win32' && existsSync(DIGICAM)) BACKEND = 'digicam';
  else {
    BACKEND = 'dummy';
    console.warn('[agent] no gphoto2 / digiCamControl found — running DUMMY backend (test files only)');
  }
  }
} else if (BACKEND === 'sigma') {
  // The camera is optional at startup: Companion must come up (and stay
  // connectable for pairing/UI) with the body off or unplugged. Probe results
  // are cached lazily; per-request camera calls report their own errors.
  try {
    sigmaProbeCache = await runSigma('probe');
  } catch (error) {
    console.warn('[agent] SIGMA camera not detected at startup (' + error.message + '); continuing without it. Connect/power the camera and it will be probed on demand.');
    sigmaProbeCache = null;
  }
  allowedConfigPaths = new Set(sigmaConfigs.keys());
}
console.log(`[agent] backend=${BACKEND}  dir=${DIR}  productionRoot=${PRODUCTION_ROOT}`);

/* ---------- capture backends ---------- */
let seq = 0;
const stamp = () => {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(++seq, 4)}`;
};

async function shootDirect() {
  const base = 'kdr_' + stamp();
  if (BACKEND === 'sigma') {
    const result = await runSigma('capture', ['-OutputDir', DIR, '-BaseName', base, ...sigmaOverrideArgs()], 90000);
    return result.files.map((file) => resolve(file));
  }
  if (BACKEND === 'gphoto2') {
    const r = await run('gphoto2', [
      '--capture-image-and-download',
      '--filename', join(DIR, base + '.%C'),
      '--force-overwrite',
    ]);
    const files = [...r.stdout.matchAll(/Saving file as (.+)/gi)].map((m) => m[1].trim());
    if (r.err && files.length === 0) throw new Error(r.stderr.trim() || r.err.message);
    return files;
  }
  if (BACKEND === 'digicam') {
    const before = new Set(readdirSync(DIR));
    const r = await run(DIGICAM, ['/filename', join(DIR, base + '.jpg'), '/capture']);
    if (r.err) throw new Error(r.stderr.trim() || r.err.message);
    await new Promise((res) => setTimeout(res, 800)); // let RAW finish writing
    return readdirSync(DIR).filter((f) => !before.has(f)).map((f) => join(DIR, f));
  }
  // dummy: 1×1 JPEG + fake RAW, proves the whole pipeline
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
    'base64');
  const j = join(DIR, base + '.jpg');
  const raw = join(DIR, base + '.raw');
  writeFileSync(j, jpeg);
  writeFileSync(raw, Buffer.from('MOTK Shoot DUMMY RAW ' + base));
  return [j, raw];
}
const shoot = () => withCamera(shootDirect);

async function shootPasses(passes, context) {
  if (!Array.isArray(passes) || !passes.length || passes.length > 16) {
    throw new Error('passes must contain between 1 and 16 entries');
  }
  return withCamera(async () => {
    if (BACKEND === 'gphoto2') await listConfigsDirect();
    const clean = passes.map((pass, i) => {
      const name = String(pass?.name || `Pass ${i + 1}`).trim().slice(0, 64) || `Pass ${i + 1}`;
      const overrides = {};
      for (const [path, value] of Object.entries(pass?.overrides || {})) {
        if (!allowedConfigPaths.has(path)) throw new Error('unknown camera config: ' + path);
        overrides[path] = String(value);
      }
      return { name, overrides };
    });
    const touched = [...new Set(clean.flatMap((pass) => Object.keys(pass.overrides)))];
    const original = new Map();
    for (const path of touched) original.set(path, (await getConfigDirect(path)).current);
    const completed = [];
    let failure = null;
    try {
      for (const pass of clean) {
        for (const [path, value] of Object.entries(pass.overrides)) await setConfigDirect(path, value);
        const files = await shootDirect();
        mirrorRawFiles(files, context);
        completed.push({
          name: pass.name,
          overrides: pass.overrides,
          files: files.map((f) => f.replace(/\\/g, '/').split('/').pop()),
          jpeg: jpegPayload(files),
        });
      }
    } catch (e) {
      failure = e;
    } finally {
      const restoreErrors = [];
      for (const [path, value] of original) {
        try { await setConfigDirect(path, value); } catch (e) { restoreErrors.push(`${path}: ${e.message}`); }
      }
      if (restoreErrors.length) {
        const message = 'camera setting restoration failed: ' + restoreErrors.join('; ');
        failure = failure ? new Error(`${failure.message}; ${message}`) : new Error(message);
      }
    }
    if (failure) {
      failure.completed = completed;
      throw failure;
    }
    return completed;
  });
}

const DUMMY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64');

async function previewFrame() {
  if (BACKEND === 'dummy') return DUMMY_JPEG;
  if (BACKEND === 'sigma') {
    const target = join(DIR, `.motk-preview-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
    try {
      try {
        await withCamera(() => runSigma('preview', ['-Output', target, ...sigmaOverrideArgs()], 30000));
      } catch (error) {
        if (!sigmaOverrides.size) throw error;
        // The camera rejected a session setting. Never let one bad value kill
        // live view: revert to the camera's own state and keep streaming.
        lastConfigError = { message: String(error.message || error), reverted: [...sigmaOverrides.keys()] };
        console.warn('[agent] camera rejected session settings (' + lastConfigError.message + '); reverting overrides and continuing live view.');
        sigmaOverrides.clear();
        await withCamera(() => runSigma('preview', ['-Output', target], 30000));
      }
      const jpeg = readFileSync(target);
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('SIGMA preview was not a JPEG');
      return jpeg;
    } finally { if (existsSync(target)) unlinkSync(target); }
  }
  if (BACKEND !== 'gphoto2') throw new Error(`live view is not available for the ${BACKEND} backend`);
  const r = await withCamera(() => runBuffer('gphoto2', ['--capture-preview', '--stdout'], 15000));
  if (r.err || !r.stdout.length) throw new Error(r.stderr.trim() || r.err?.message || 'camera returned no preview frame');
  return r.stdout;
}

function jpegPayload(files) {
  const j = files.find((f) => /\.jpe?g$/i.test(f));
  if (!j || !existsSync(j)) return null;
  try {
    if (statSync(j).size > 30 * 1024 * 1024) return null;
    return readFileSync(j).toString('base64');
  } catch { return null; }
}

/* ---------- WebSocket server (minimal RFC6455) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const observerSubscribers = new Set();
let observerLatest = null;
const staticTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
const normalizedAllowedOrigin = (() => {
  if (!ALLOW_ORIGIN) return '';
  try { return new URL(ALLOW_ORIGIN).origin; } catch { throw new Error('--allow-origin must be one http(s) origin'); }
})();
const websocketOriginAllowed = (req) => {
  const value = String(req.headers.origin || '');
  if (!value) return true; // command-line/native WebSocket clients do not send Origin
  let origin;
  try { origin = new URL(value); } catch { return false; }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
  if (loopbackHosts.has(origin.hostname)) return true;
  if (normalizedAllowedOrigin && origin.origin === normalizedAllowedOrigin) return true;
  if (SERVE_APP) {
    try {
      const served = new URL(`http://${req.headers.host || ''}`);
      if (origin.hostname === served.hostname && origin.port === served.port) return true;
    } catch { /* reject malformed Host below */ }
  }
  return false;
};
const server = createServer((req, res) => {
  if (SERVE_APP && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://agent.local').pathname);
      const relative = pathname.replace(/^\/+/, '') || 'index.html';
      const publicPath = relative === 'index.html' || relative === 'monitor.html' || relative === 'manifest.json' || relative === 'sw.js' || relative.startsWith('js/') || relative.startsWith('css/');
      const target = resolve(APP_ROOT, relative);
      if (!publicPath || !target.startsWith(APP_ROOT + sep) || !existsSync(target) || !statSync(target).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found\n'); return;
      }
      const type = staticTypes.get(extname(target).toLowerCase());
      if (!type) { res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Unsupported file type\n'); return; }
      const body = readFileSync(target);
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Bad request\n'); return;
    }
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`MOTK Shoot camera agent (${BACKEND}). Connect via WebSocket.\n`);
});

server.on('upgrade', (req, socket) => {
  if (!websocketOriginAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (REQUIRE_TOKEN && !pairingTokenMatches(tokenFromUpgradeRequest(req), pairingRecord.token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  console.log('[agent] client connected');
  const sendJson = (obj) => { if (!socket.destroyed) socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), 1)); };
  const remote = String(socket.remoteAddress || '');
  const localController = remote === '127.0.0.1' || remote === '::1' || remote.endsWith(':127.0.0.1');
  sendJson({
    type: 'tether.hello', backend: BACKEND, dir: DIR, productionRoot: PRODUCTION_ROOT,
    auth: { required: REQUIRE_TOKEN, claims: pairingRecord.claims },
  });
  const liveView = { active: false, fps: 10, seq: 0, timer: null };
  const stopLiveView = () => {
    liveView.active = false;
    if (liveView.timer) clearTimeout(liveView.timer);
    liveView.timer = null;
  };
  const pumpLiveView = async () => {
    if (!liveView.active || socket.destroyed) return;
    const started = Date.now();
    try {
      const jpeg = await previewFrame();
      if (liveView.active && !socket.destroyed) {
        const frame = {
          type: 'tether.liveview.frame',
          seq: ++liveView.seq,
          capturedAt: new Date().toISOString(),
          jpeg: jpeg.toString('base64'),
        };
        if (lastConfigError) { frame.configWarning = lastConfigError.message; lastConfigError = null; }
        sendJson(frame);
      }
    } catch (e) {
      if (liveView.active) {
        sendJson({ type: 'tether.liveview.error', error: e.message });
        stopLiveView();
      }
      return;
    }
    if (liveView.active) {
      const delay = Math.max(0, Math.round(1000 / liveView.fps) - (Date.now() - started));
      liveView.timer = setTimeout(pumpLiveView, delay);
    }
  };

  let buf = Buffer.alloc(0);
  socket.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = decodeFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);
      if (frame.opcode === 8) { socket.end(); return; }
      if (frame.opcode === 9) { socket.write(encodeFrame(frame.payload, 10)); continue; }
      if (frame.opcode !== 1) continue;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (msg.type === 'observer.subscribe') {
        observerSubscribers.add(sendJson);
        if (observerLatest) sendJson(observerLatest);
      } else if (!localController) {
        sendJson({ type: 'tether.result', id: msg.id, ok: false, error: 'LAN observer connections are read-only' });
      } else if (msg.type === 'observer.publish') {
        try {
          const jpeg = String(msg.jpeg || '');
          const bytes = Buffer.from(jpeg, 'base64');
          if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('observer preview is empty or too large');
          const state = msg.state && typeof msg.state === 'object' ? msg.state : {};
          if (Buffer.byteLength(JSON.stringify(state)) > 64 * 1024) throw new Error('observer state is too large');
          observerLatest = { type: 'observer.update', jpeg, state, publishedAt: new Date().toISOString() };
          for (const send of observerSubscribers) send(observerLatest);
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'tether.shoot') {
        console.log('[agent] shoot', msg.id);
        try {
          const files = await shoot();
          mirrorRawFiles(files, msg.context);
          console.log('[agent] saved:', files.join(', ') || '(none)');
          sendJson({
            type: 'tether.result', id: msg.id, ok: true,
            files: files.map((f) => f.replace(/\\/g, '/').split('/').pop()),
            jpeg: jpegPayload(files),
          });
        } catch (e) {
          console.error('[agent] shoot failed:', e.message);
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message });
        }
      } else if (msg.type === 'tether.shoot.passes') {
        console.log('[agent] pass capture', msg.id);
        try {
          const passes = await shootPasses(msg.passes, msg.context);
          console.log('[agent] completed passes:', passes.map((p) => p.name).join(', '));
          sendJson({ type: 'tether.result', id: msg.id, ok: true, passes });
        } catch (e) {
          console.error('[agent] pass capture failed:', e.message);
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message, passes: e.completed || [] });
        }
      } else if (msg.type === 'tether.config.list') {
        try {
          sendJson({ type: 'tether.result', id: msg.id, ok: true, configs: await listConfigs() });
        } catch (e) {
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message });
        }
      } else if (msg.type === 'tether.config.get') {
        try {
          sendJson({ type: 'tether.result', id: msg.id, ok: true, config: await getConfig(String(msg.path || '')) });
        } catch (e) {
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message });
        }
      } else if (msg.type === 'tether.config.set') {
        try {
          sendJson({ type: 'tether.result', id: msg.id, ok: true, config: await setConfig(String(msg.path || ''), String(msg.value ?? '')) });
        } catch (e) {
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message });
        }
      } else if (msg.type === 'tether.liveview.start') {
        if (BACKEND !== 'gphoto2' && BACKEND !== 'sigma' && BACKEND !== 'dummy') {
          sendJson({ type: 'tether.result', id: msg.id, ok: false, error: `live view is not available for the ${BACKEND} backend` });
          continue;
        }
        stopLiveView();
        liveView.fps = Math.max(1, Math.min(15, Number(msg.fps) || 10));
        liveView.seq = 0;
        liveView.active = true;
        sendJson({ type: 'tether.result', id: msg.id, ok: true, fps: liveView.fps });
        pumpLiveView();
      } else if (msg.type === 'tether.liveview.stop') {
        stopLiveView();
        sendJson({ type: 'tether.result', id: msg.id, ok: true });
      } else if (msg.type === 'folder.mirrorFrame') {
        try {
          const paths = productionPaths(msg.context);
          const frame = Math.max(1, Math.min(999999, parseInt(msg.frame, 10) || 1));
          const data = decodeBase64(msg.data, 100 * 1024 * 1024);
          const target = join(paths.frames, `frame_${String(frame).padStart(5, '0')}.jpg`);
          const written = writeSafe(target, data);
          sendJson({ type: 'tether.result', id: msg.id, ok: true, path: written.path, collision: written.collision });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'folder.writeMeta') {
        try {
          const paths = productionPaths(msg.context);
          const shot = writeSafe(join(paths.shot, 'shot.json'), JSON.stringify(msg.shot || {}, null, 2));
          const take = writeSafe(join(paths.take, 'take.json'), JSON.stringify(msg.takeMeta || {}, null, 2));
          sendJson({ type: 'tether.result', id: msg.id, ok: true, shotPath: shot.path, takePath: take.path });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'folder.backup') {
        try {
          const paths = productionPaths(msg.context);
          const target = join(paths.take, 'backup.zip');
          const written = writeSafe(target, decodeBase64(msg.data, 512 * 1024 * 1024));
          sendJson({ type: 'tether.result', id: msg.id, ok: true, path: written.path, collision: written.collision });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'folder.audio') {
        try {
          const paths = productionPaths(msg.context);
          const sourceName = safeSegment(basename(String(msg.name || 'track.bin')), 'track.bin');
          const target = join(paths.audio, sourceName);
          const written = writeSafe(target, decodeBase64(msg.data, 512 * 1024 * 1024));
          sendJson({ type: 'tether.result', id: msg.id, ok: true, path: written.path, collision: written.collision });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'folder.report') {
        try {
          const paths = productionPaths(msg.context);
          const csv = String(msg.csv || '');
          if (Buffer.byteLength(csv) > 10 * 1024 * 1024) throw new Error('report is too large');
          const productionReport = writeSafe(join(paths.production, 'production_report.csv'), csv);
          writeSafe(join(paths.shot, 'production_report.csv'), csv);
          sendJson({ type: 'tether.result', id: msg.id, ok: true, path: productionReport.path });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'folder.editorial') {
        try {
          const paths = productionPaths(msg.context);
          const files = msg.files && typeof msg.files === 'object' ? msg.files : {};
          const names = Object.keys(files);
          if (!names.length) throw new Error('editorial package is empty');
          if (names.some((name) => !EDITORIAL_FILES.has(name))) throw new Error('unknown editorial file name');
          if (names.length !== EDITORIAL_FILES.size) throw new Error('editorial package must contain all six files');
          let total = 0;
          for (const name of names) {
            const body = String(files[name] ?? '');
            const bytes = Buffer.byteLength(body);
            if (!bytes) throw new Error(`${name} is empty`);
            if (bytes > 10 * 1024 * 1024) throw new Error(`${name} is too large`);
            total += bytes;
            if (total > 30 * 1024 * 1024) throw new Error('editorial package is too large');
            writeSafe(join(paths.take, name), body);
          }
          sendJson({ type: 'tether.result', id: msg.id, ok: true, path: paths.take, files: names });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      } else if (msg.type === 'sheet.fetch') {
        try {
          const url = new URL(String(msg.url || ''));
          const allowed = url.protocol === 'https:' && (url.hostname === 'docs.google.com' || url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'script.google.com');
          if (!allowed) throw new Error('agent sheet fallback only allows Google HTTPS hosts');
          const response = await fetch(url, { redirect: 'follow' });
          const finalUrl = new URL(response.url);
          const finalAllowed = finalUrl.protocol === 'https:' && (finalUrl.hostname === 'docs.google.com' || finalUrl.hostname.endsWith('.googleusercontent.com') || finalUrl.hostname === 'script.google.com');
          if (!finalAllowed) throw new Error('sheet redirect left the allowed Google hosts');
          if (!response.ok) throw new Error(`sheet HTTP ${response.status}`);
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length > 5 * 1024 * 1024) throw new Error('sheet response is too large');
          sendJson({ type: 'tether.result', id: msg.id, ok: true, text: data.toString('utf8') });
        } catch (e) { sendJson({ type: 'tether.result', id: msg.id, ok: false, error: e.message }); }
      }
    }
  });
  socket.on('close', () => { observerSubscribers.delete(sendJson); stopLiveView(); console.log('[agent] client left'); });
  socket.on('error', () => { observerSubscribers.delete(sendJson); stopLiveView(); });
});

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  }
  return { opcode, payload, consumed: off + maskLen + len };
}

function encodeFrame(payload, opcode = 1) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

server.listen(PORT, HOST, () => {
  console.log(`[agent] listening on ws://${HOST}:${PORT}`);
  if (SERVE_APP) console.log(`[agent] observer: http://${HOST === '0.0.0.0' ? '<this-computer-ip>' : HOST}:${PORT}/?observer=1`);
});
