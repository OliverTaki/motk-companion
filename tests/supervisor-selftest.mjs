// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'motk-companion-supervisor-'));
const busPort = 34000 + Math.floor(Math.random() * 1000);
const statusPort = busPort + 1000;
const productionRoot = join(temp, 'production');
const tokenStore = join(temp, 'config', 'pairing-token.json');
const configPath = join(temp, 'companion.json');
writeFileSync(configPath, JSON.stringify({
  host: '127.0.0.1', allowOrigin: 'https://shoot.example.test', busPort, statusPort, productionRoot,
  captureInbox: join(productionRoot, '.capture'), tokenStore,
  cameraBackend: 'dummy', capabilities: { bridge: true }, uploadTargets: {},
}, null, 2));

const supervisor = spawn(process.execPath, [join(root, 'companion.mjs'), '--config', configPath], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
supervisor.stdout.on('data', (chunk) => { output += chunk; });
supervisor.stderr.on('data', (chunk) => { output += chunk; });

const waitUntil = async (predicate, label, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (supervisor.exitCode !== null) throw new Error(`supervisor exited during ${label}\n${output}`);
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`timeout during ${label}\n${output}`);
};

const httpJson = (port, path) => new Promise((resolveRequest) => {
  http.get({ host: '127.0.0.1', port, path }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolveRequest(response.statusCode === 200 ? JSON.parse(body) : null));
  }).on('error', () => resolveRequest(null));
});

function clientFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function readFrames(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    let length = state.buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    if (length === 127) { if (state.buffer.length < 10) return; length = Number(state.buffer.readBigUInt64BE(2)); offset = 10; }
    if (state.buffer.length < offset + length) return;
    const value = JSON.parse(state.buffer.subarray(offset, offset + length).toString('utf8'));
    state.buffer = state.buffer.subarray(offset + length);
    state.messages.push(value);
  }
}

const connect = (token) => new Promise((resolveSocket, reject) => {
  const request = http.request({
    host: '127.0.0.1', port: busPort, path: `/?token=${encodeURIComponent(token)}`,
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://shoot.example.test',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
  });
  request.once('upgrade', (_response, socket, head) => {
    const state = { socket, buffer: Buffer.alloc(0), messages: [] };
    if (head.length) readFrames(state, head);
    socket.on('data', (chunk) => readFrames(state, chunk));
    resolveSocket(state);
  });
  request.once('error', reject);
  request.end();
});

async function exchange(peer, message) {
  peer.socket.write(clientFrame(message));
  return waitUntil(() => peer.messages.find((item) => item.id === message.id), message.id);
}

try {
  const status = await waitUntil(async () => {
    const value = await httpJson(statusPort, '/status');
    return value?.capabilities?.find((cap) => cap.name === 'bridge' && cap.status === 'up') ? value : null;
  }, 'supervisor startup');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(status.version || ''))) throw new Error('status version missing or invalid');
  const token = JSON.parse(readFileSync(tokenStore, 'utf8')).token;
  const peer = await connect(token);
  await waitUntil(() => peer.messages.find((item) => item.type === 'tether.hello'), 'bridge hello');
  const context = { productionId: 'sample', production: 'Sample Production', shotId: 'SCENE_A_SHOT_001', take: 1, projectId: 'project_sample' };
  for (let frame = 1; frame <= 3; frame += 1) {
    const result = await exchange(peer, { type: 'folder.mirrorFrame', id: `frame-${frame}`, context, frame, captureId: `capture-${frame}`, data: Buffer.from(`frame ${frame}`).toString('base64') });
    if (!result.ok) throw new Error(result.error);
  }
  const meta = await exchange(peer, { type: 'folder.writeMeta', id: 'meta', context, shot: { shot_id: context.shotId }, takeMeta: { frames: 3 } });
  if (!meta.ok) throw new Error(meta.error);
  const duplicate = await exchange(peer, { type: 'folder.mirrorFrame', id: 'duplicate', context, frame: 1, captureId: 'capture-1', data: Buffer.from('replacement').toString('base64') });
  if (!duplicate.ok || !duplicate.collision) throw new Error('duplicate mirror did not report a collision-safe write');
  const framesDir = join(productionRoot, 'Sample Production', context.shotId, 'T01', 'frames');
  const names = readdirSync(framesDir).sort();
  if (names.length !== 4 || !names.includes('frame_00001.1.jpg')) throw new Error(`unexpected mirrored files: ${names.join(', ')}`);
  if (readFileSync(join(framesDir, 'frame_00001.jpg'), 'utf8') !== 'frame 1') throw new Error('original mirrored frame was overwritten');
  const take = JSON.parse(readFileSync(join(productionRoot, 'Sample Production', context.shotId, 'T01', 'take.json'), 'utf8'));
  if (take.frames !== 3) throw new Error('take.json was not written');
  peer.socket.destroy();
  console.log('PASS');
  console.log('Supervisor started the authenticated bridge, reported status, mirrored 3 frames, wrote take.json, and collision-suffixed a duplicate without overwrite.');
} finally {
  supervisor.kill('SIGTERM');
  await new Promise((done) => supervisor.once('exit', done));
  rmSync(temp, { recursive: true, force: true });
}
