// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'motk-companion-token-'));
const tokenStore = join(temp, 'config', 'pairing-token.json');
const originals = join(temp, 'originals');
const productions = join(temp, 'productions');
const port = 32000 + Math.floor(Math.random() * 2000);
const agent = spawn(process.execPath, [
  join(here, 'bridge', 'production-agent.mjs'),
  '--backend', 'dummy', '--host', '127.0.0.1', '--port', String(port),
  '--dir', originals, '--production-root', productions, '--token-store', tokenStore,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let output = '';
agent.stdout.on('data', (chunk) => { output += chunk; });
agent.stderr.on('data', (chunk) => { output += chunk; });

const waitForReady = () => new Promise((resolveReady, reject) => {
  const deadline = Date.now() + 10000;
  const poll = () => {
    if (output.includes('[agent] listening')) return resolveReady();
    if (agent.exitCode !== null) return reject(new Error(`agent exited early (${agent.exitCode})\n${output}`));
    if (Date.now() > deadline) return reject(new Error(`agent did not start\n${output}`));
    setTimeout(poll, 25);
  };
  poll();
});

const decodeServerFrame = (buffer) => {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  if (buffer.length < offset + length) return null;
  return JSON.parse(buffer.subarray(offset, offset + length).toString('utf8'));
};

const upgrade = (token = '') => new Promise((resolveUpgrade, reject) => {
  const path = token ? `/?token=${encodeURIComponent(token)}` : '/';
  const request = http.request({
    host: '127.0.0.1', port, path,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'http://127.0.0.1:8321',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
    },
  });
  request.once('response', (response) => resolveUpgrade({ status: response.statusCode }));
  request.once('upgrade', (response, socket, head) => {
    let data = Buffer.from(head || []);
    const finish = () => {
      const hello = decodeServerFrame(data);
      if (!hello) return false;
      socket.destroy();
      resolveUpgrade({ status: response.statusCode, hello });
      return true;
    };
    if (finish()) return;
    socket.on('data', (chunk) => { data = Buffer.concat([data, chunk]); finish(); });
    socket.once('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('timed out waiting for authenticated hello')); }, 3000).unref();
  });
  request.once('error', reject);
  request.end();
});

try {
  await waitForReady();
  const refused = await upgrade();
  if (refused.status !== 401) throw new Error(`missing token returned ${refused.status}, expected 401`);

  const record = JSON.parse(readFileSync(tokenStore, 'utf8'));
  if (!/^[A-Za-z0-9_-]{43}$/.test(record.token || '')) throw new Error('stored token is not 32-byte base64url');
  if (!record.claims?.includes('shoot.capture')) throw new Error('stored token record has no shoot.capture claim');

  const accepted = await upgrade(record.token);
  if (accepted.status !== 101) throw new Error(`valid token returned ${accepted.status}, expected 101`);
  if (!accepted.hello?.auth?.required) throw new Error('authenticated hello did not mark auth required');
  if (!accepted.hello.auth.claims.includes('production.write')) throw new Error('server did not expose token claims to the session');

  console.log('PASS');
  console.log('Missing tokens were rejected; the stored 32-byte token was accepted with readable capability claims.');
} finally {
  agent.kill();
  await new Promise((resolveExit) => agent.once('exit', resolveExit));
  rmSync(temp, { recursive: true, force: true });
}

