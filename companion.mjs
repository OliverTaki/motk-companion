// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreatePairingRecord, pairingTokenMatches, tokenFromUpgradeRequest } from './bridge/pairing-token.mjs';
import { JournalJobStore } from './lib/job-store.mjs';

export const VERSION = '0.4.0-beta.6';
const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const configPath = resolve(valueFor('config', join(appRoot, 'companion.json')));
const configDir = dirname(configPath);
if (!existsSync(configPath)) throw new Error(`configuration not found: ${configPath}`);
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const localPath = (value, fallback) => {
  const selected = String(value || fallback);
  return resolve(isAbsolute(selected) ? selected : join(configDir, selected));
};
const host = String(config.host || '127.0.0.1');
const busPort = Number(config.busPort || 8793);
const statusPort = Number(config.statusPort || 8794);
const internalBridgePort = Number(config.internalBridgePort || (busPort + (statusPort === busPort + 2 ? 3 : 2)));
const productionRoot = localPath(config.productionRoot, './production');
const tokenStore = localPath(config.tokenStore, './config/pairing-token.json');
const originals = localPath(config.captureInbox, './production/Camera Originals');
const jobStorePath = localPath(config.jobStore, './state/jobs.jsonl');
const capabilities = new Map();
let stopping = false;
const claims = ['bridge.connect', 'observer.publish', 'observer.subscribe', 'production.read', 'production.write', 'shoot.camera_configure', 'shoot.capture'];
const pairingRecord = loadOrCreatePairingRecord(tokenStore, claims);
if (pairingRecord.created) console.log(`[pairing] token (shown once): ${pairingRecord.token}`);

function startCapability(name, command, commandArgs) {
  const state = { name, status: 'starting', pid: null, startedAt: new Date().toISOString(), lastError: '' };
  capabilities.set(name, state);
  const child = spawn(command, commandArgs, { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  state.pid = child.pid;
  state.child = child;
  const observe = (chunk, error = false) => {
    const line = String(chunk);
    if (line.includes('[agent] listening') || line.includes('[control] ready')) state.status = 'up';
    if (error) state.lastError = line.trim().slice(-1000);
    (error ? process.stderr : process.stdout).write(`[${name}] ${line}`);
  };
  child.stdout.on('data', (chunk) => observe(chunk));
  child.stderr.on('data', (chunk) => observe(chunk, true));
  child.on('exit', (code, signal) => {
    state.status = stopping ? 'stopped' : 'failed';
    state.exit = { code, signal };
  });
  return child;
}

if (config.capabilities?.bridge !== false) {
  const bridgeArgs = [
    join(appRoot, 'bridge', 'production-agent.mjs'), '--backend', String(config.cameraBackend || 'dummy'),
    '--host', '127.0.0.1', '--port', String(internalBridgePort), '--dir', originals,
    '--production-root', productionRoot, '--token-store', tokenStore,
  ];
  if (config.allowOrigin) bridgeArgs.push('--allow-origin', String(config.allowOrigin));
  if (config.sigmaSdkZip) bridgeArgs.push('--sigma-sdk-zip', localPath(config.sigmaSdkZip, ''));
  if (config.sigmaSerial) bridgeArgs.push('--sigma-serial', String(config.sigmaSerial));
  if (config.digicamCommand) bridgeArgs.push('--digicam', localPath(config.digicamCommand, ''));
  startCapability('bridge', process.execPath, bridgeArgs);
}

if (config.capabilities?.control !== false && config.controlPlaneEndpoint && config.controlPlaneToken && config.projectId) {
  startCapability('control', process.execPath, [join(appRoot, 'cap-control.mjs'), '--config', configPath]);
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
const allowedOrigin = config.allowOrigin ? new URL(config.allowOrigin).origin : '';
const originAllowed = (request) => {
  const value = String(request.headers.origin || '');
  if (!value) return true;
  try { const origin = new URL(value); return (origin.protocol === 'http:' || origin.protocol === 'https:') && (loopbackHosts.has(origin.hostname) || origin.origin === allowedOrigin); }
  catch { return false; }
};
const rejectUpgrade = (socket, status, label) => {
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy();
};
const busServer = createServer((_request, response) => {
  response.writeHead(426, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: 'WebSocket upgrade required' }));
});
busServer.on('upgrade', (request, clientSocket, clientHead) => {
  if (!originAllowed(request)) return rejectUpgrade(clientSocket, 403, 'Forbidden');
  if (!pairingTokenMatches(tokenFromUpgradeRequest(request), pairingRecord.token)) return rejectUpgrade(clientSocket, 401, 'Unauthorized');
  const headers = { ...request.headers, host: `127.0.0.1:${internalBridgePort}` };
  delete headers.authorization;
  const proxyRequest = httpRequest({ host: '127.0.0.1', port: internalBridgePort, path: `/?token=${encodeURIComponent(pairingRecord.token)}`, method: 'GET', headers });
  proxyRequest.once('upgrade', (response, upstreamSocket, upstreamHead) => {
    const responseHeaders = Object.entries(response.headers).flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]);
    clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (clientHead.length) upstreamSocket.write(clientHead);
    clientSocket.pipe(upstreamSocket); upstreamSocket.pipe(clientSocket);
    const closeBoth = () => { clientSocket.destroy(); upstreamSocket.destroy(); };
    clientSocket.on('error', closeBoth); upstreamSocket.on('error', closeBoth);
  });
  proxyRequest.once('response', () => rejectUpgrade(clientSocket, 502, 'Bad Gateway'));
  proxyRequest.once('error', () => rejectUpgrade(clientSocket, 502, 'Bad Gateway'));
  proxyRequest.end();
});
busServer.listen(busPort, host, () => console.log(`[supervisor] bus ws://${host}:${busPort}`));

const statusServer = createServer((request, response) => {
  if (request.method !== 'GET' || new URL(request.url || '/', 'http://companion.local').pathname !== '/status') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  const caps = [...capabilities.values()].map(({ child, ...state }) => state);
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({
    ok: true, version: VERSION, capabilities: caps,
    jobs: new JournalJobStore(jobStorePath).summary(),
  }));
});
statusServer.listen(statusPort, host, () => {
  console.log(`[supervisor] status http://${host}:${statusPort}/status`);
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const state of capabilities.values()) state.child?.kill('SIGTERM');
  await Promise.all([...capabilities.values()].map((state) => new Promise((done) => {
    if (!state.child || state.child.exitCode !== null) return done();
    state.child.once('exit', done);
    setTimeout(() => { state.child?.kill('SIGKILL'); done(); }, 3000).unref();
  })));
  await new Promise((done) => statusServer.close(done));
  await new Promise((done) => busServer.close(done));
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
