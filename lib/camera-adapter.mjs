// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import readline from 'node:readline';
import { copyNewFile, sandboxResolve } from './safe-fs.mjs';

const MOCK_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
const run = (command, args, timeout = 60000) => new Promise((done, reject) => execFile(command, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : done(String(stdout || ''))));
const safeSegment = (value, fallback) => {
  const clean = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 80);
  return !clean || clean === '.' || clean === '..' ? fallback : clean;
};

export class CameraAdapter {
  constructor(options) {
    this.vendor = options.vendor; this.productionRoot = resolve(options.productionRoot); this.mock = Boolean(options.mock);
    this.command = options.command || ''; this.settings = new Map([['iso', '100'], ['shutter', '1/24'], ['aperture', 'f/4']]); mkdirSync(this.productionRoot, { recursive: true });
  }
  paths(context) {
    if (!context?.shotId || !context?.take) throw new Error('capture context is required');
    const production = safeSegment(context.production || context.productionId, 'Sample Production');
    const shot = safeSegment(context.shotId, 'SHOT'); const take = `T${String(Math.max(1, Number(context.take) || 1)).padStart(2, '0')}`;
    const raw = sandboxResolve(this.productionRoot, production, shot, take, 'raw'); mkdirSync(raw, { recursive: true }); return { raw };
  }
  async liveview() {
    if (this.mock) return { jpeg: MOCK_JPEG.toString('base64'), capturedAt: new Date().toISOString() };
    if (!this.command) throw new Error(`${this.vendor} SDK/CLI command is not configured`);
    if (this.vendor === 'gphoto2') {
      const temp = mkdtempSync(join(this.productionRoot, '.camera-preview-')); const path = join(temp, 'preview.jpg');
      try { await run(this.command, ['--capture-preview', '--filename', path]); return { jpeg: readFileSync(path).toString('base64'), capturedAt: new Date().toISOString() }; }
      finally { rmSync(temp, { recursive: true, force: true }); }
    }
    const result = JSON.parse(await run(this.command, ['liveview'])); return { jpeg: result.jpeg, capturedAt: new Date().toISOString() };
  }
  async capture(context) {
    const { raw } = this.paths(context); const stagingRoot = sandboxResolve(this.productionRoot, '.camera-staging'); mkdirSync(stagingRoot, { recursive: true });
    const stage = mkdtempSync(join(stagingRoot, `${this.vendor}-`));
    try {
      if (this.mock) writeFileSync(join(stage, 'capture.jpg'), MOCK_JPEG);
      else if (this.vendor === 'gphoto2') await run(this.command, ['--capture-image-and-download', '--filename', join(stage, 'capture.%C'), '--force-overwrite']);
      else if (this.vendor === 'digicamcontrol') await run(this.command, ['/filename', join(stage, 'capture.jpg'), '/capture']);
      else {
        if (!this.command) throw new Error(`${this.vendor} SDK command is not configured`);
        await run(this.command, ['capture', '--output', stage]);
      }
      const staged = readdirSync(stage).map((name) => join(stage, name)).filter((path) => statSync(path).isFile());
      if (!staged.length) throw new Error('camera produced no files');
      const files = staged.map((source) => copyNewFile(this.productionRoot, source, join(raw, safeSegment(basename(source), 'capture.bin')), { allowOriginalCreate: true }).path);
      return { files };
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  getSettings() { return Object.fromEntries(this.settings); }
  setSettings(values) { for (const [key, value] of Object.entries(values || {})) { if (!this.settings.has(key)) throw new Error(`unsupported setting: ${key}`); this.settings.set(key, String(value)); } return this.getSettings(); }
  files(context) { const { raw } = this.paths(context); return readdirSync(raw).map((name) => join(raw, name)); }
  async handle(message) {
    if (message.cmd === 'camera.liveview') return { liveview: await this.liveview() };
    if (message.cmd === 'camera.capture') return this.capture(message.context);
    if (message.cmd === 'camera.settings.get') return { settings: this.getSettings() };
    if (message.cmd === 'camera.settings.set') return { settings: this.setSettings(message.settings) };
    if (message.cmd === 'camera.files') return { files: this.files(message.context) };
    throw new Error('unsupported camera command');
  }
}

export function runCameraAdapterCli(vendor) {
  const args = process.argv.slice(2); const arg = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
  const adapter = new CameraAdapter({ vendor, productionRoot: resolve(arg('production-root', './production')), mock: args.includes('--mock'), command: arg('command', vendor === 'gphoto2' ? 'gphoto2' : '') });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); const result = await adapter.handle(message); process.stdout.write(`${JSON.stringify({ type: 'camera.result', id: message.id, ok: true, ...result })}\n`); }
    catch (error) { process.stdout.write(`${JSON.stringify({ type: 'camera.result', id: message?.id, ok: false, error: error.message })}\n`); }
  });
}
