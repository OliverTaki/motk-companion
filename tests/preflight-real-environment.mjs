#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-3.0-or-later */
import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { platform, release, totalmem, freemem } from 'node:os';

const args = process.argv.slice(2);
const valueArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const configPath = resolve(valueArg('config', 'companion.json'));
const timeoutMs = Number(valueArg('timeout-ms', '800'));
const checks = [];

function add(name, status, detail = '') {
  checks.push({ name, status, detail });
}

function runVersion(command, versionArgs = ['--version']) {
  const r = spawnSync(command, versionArgs, {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  });
  if (r.error) return { ok: false, detail: r.error.message };
  const first = String(r.stdout || r.stderr || '').split(/\r?\n/).find(Boolean) || '';
  return { ok: r.status === 0, detail: first || `exit ${r.status}` };
}

function canAccess(path, mode) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function freeBytes(path) {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function portFree(host, port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => resolvePort(true));
  });
}

let config = {};
let configDir = dirname(configPath);
try {
  config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  add('config file', 'PASS', configPath);
} catch (e) {
  add('config file', 'FAIL', `${configPath}: ${e.message}`);
}

add('operating system', platform() === 'win32' ? 'PASS' : 'WARN', `${platform()} ${release()}`);

const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js >= 22', nodeMajor >= 22 ? 'PASS' : 'FAIL', process.versions.node);

for (const command of ['git']) {
  const r = runVersion(command, ['--version']);
  add(command, r.ok ? 'PASS' : 'FAIL', r.detail);
}

const ffmpeg = config.ffmpeg || 'ffmpeg';
const ffprobe = config.ffprobe || 'ffprobe';
for (const [name, command] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
  const r = runVersion(command, ['-version']);
  add(name, r.ok ? 'PASS' : 'FAIL', r.detail);
}

for (const [name, command, versionArgs] of [
  ['mpv/libmpv candidate', config.player?.path || 'mpv', ['--version']],
  ['MLT melt candidate', 'melt', ['--version']],
]) {
  const r = runVersion(command, versionArgs);
  add(name, r.ok ? 'PASS' : 'WARN', r.ok ? r.detail : `${command} not detected`);
}

for (const [field, mode] of [
  ['productionRoot', constants.R_OK | constants.W_OK],
  ['captureInbox', constants.R_OK | constants.W_OK],
  ['recipesDir', constants.R_OK],
  ['logsDir', constants.R_OK | constants.W_OK],
]) {
  const configured = config[field];
  if (!configured) {
    add(field, 'WARN', 'not configured');
    continue;
  }
  const path = resolve(configDir, configured);
  const exists = existsSync(path);
  const ok = exists && canAccess(path, mode);
  add(field, ok ? 'PASS' : 'WARN', ok ? path : exists ? `access check failed: ${path}` : `path missing: ${path}`);
  if (exists) {
    const bytes = freeBytes(path);
    if (bytes !== null) add(`${field} free space`, 'INFO', `${Math.round(bytes / 1024 / 1024 / 1024)} GiB`);
  }
}

for (const [field, configured] of [
  ['tokenStore parent', config.tokenStore],
  ['jobStore parent', config.jobStore],
]) {
  if (!configured) {
    add(field, 'WARN', 'not configured');
    continue;
  }
  const parent = dirname(resolve(configDir, configured));
  add(field, existsSync(parent) && canAccess(parent, constants.R_OK | constants.W_OK) ? 'PASS' : 'WARN', parent);
}

const targets = config.uploadTargets && typeof config.uploadTargets === 'object' ? config.uploadTargets : {};
for (const [name, target] of Object.entries(targets)) {
  if (target.type === 'fs') {
    const root = String(target.root || '');
    const exists = root && existsSync(root);
    const ok = exists && canAccess(root, constants.R_OK | constants.W_OK);
    add(`upload target ${name}`, ok ? 'PASS' : 'WARN', ok ? root : exists ? `access check failed: ${root}` : `path missing: ${root}`);
    continue;
  }
  if (target.type === 'drive') {
    const hasPlaceholder = /PLACEHOLDER/i.test(JSON.stringify(target));
    add(`upload target ${name}`, hasPlaceholder ? 'WARN' : 'INFO', hasPlaceholder ? 'Drive target still has placeholders' : 'Drive target configured; credentials not opened');
    continue;
  }
  add(`upload target ${name}`, 'WARN', `unknown target type: ${target.type || '(missing)'}`);
}

if (config.motkEndpoint) {
  add('MOTK endpoint', /PLACEHOLDER/i.test(config.motkEndpoint) ? 'WARN' : 'INFO', /PLACEHOLDER/i.test(config.motkEndpoint) ? 'placeholder endpoint' : 'configured; not contacted');
} else {
  add('MOTK endpoint', 'WARN', 'not configured');
}

if (config.motkToken) {
  add('MOTK token', /PLACEHOLDER/i.test(config.motkToken) ? 'WARN' : 'INFO', /PLACEHOLDER/i.test(config.motkToken) ? 'placeholder token' : 'configured; value not printed');
} else {
  add('MOTK token', 'WARN', 'not configured');
}

const sdkPath = config.camera?.sigma?.sdkPath;
if (sdkPath && !/path\\to|PLACEHOLDER/i.test(sdkPath)) {
  add('SIGMA SDK/helper path', existsSync(sdkPath) ? 'PASS' : 'WARN', existsSync(sdkPath) ? 'configured path exists' : 'configured path missing');
} else {
  add('SIGMA SDK/helper path', 'WARN', 'not configured for physical hardware');
}

add('memory total', 'INFO', `${Math.round(totalmem() / 1024 / 1024 / 1024)} GiB`);
add('memory free now', 'INFO', `${Math.round(freemem() / 1024 / 1024 / 1024)} GiB`);

const host = config.host || '127.0.0.1';
for (const [name, port] of [['bus port', Number(config.busPort || 8793)], ['status port', Number(config.statusPort || 8794)]]) {
  const free = await portFree(host, port);
  add(name, free ? 'PASS' : 'WARN', `${host}:${port} ${free ? 'appears free' : 'already accepts connections'}`);
}

const maxName = Math.max(...checks.map((c) => c.name.length), 4);
for (const check of checks) {
  console.log(`${check.status.padEnd(5)} ${check.name.padEnd(maxName)} ${check.detail}`);
}

const failures = checks.filter((c) => c.status === 'FAIL');
if (failures.length) process.exit(1);
