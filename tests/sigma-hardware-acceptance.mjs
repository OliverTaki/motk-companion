import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = process.env.MOTK_SIGMA_TEST_URL || 'ws://127.0.0.1:8893';
const tokenStore = process.env.MOTK_SIGMA_TOKEN_STORE;
const captureDir = process.env.MOTK_SIGMA_CAPTURE_DIR;
if (!tokenStore || !captureDir) {
  throw new Error('Set MOTK_SIGMA_TOKEN_STORE and MOTK_SIGMA_CAPTURE_DIR for the connected-camera acceptance test.');
}

const tokenRecord = JSON.parse(await readFile(tokenStore, 'utf8'));
assert.ok(tokenRecord.token, 'pairing token is missing');
const url = new URL(endpoint);
url.searchParams.set('token', tokenRecord.token);

const socket = new WebSocket(url);
const pending = new Map();
let sequence = 0;
let hello;
let liveFrame;

const helloReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Companion hello timed out')), 15_000);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'tether.hello') {
      clearTimeout(timer);
      hello = message;
      resolve(message);
    }
  });
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'tether.result' && pending.has(message.id)) {
    const { resolve } = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
  if (message.type === 'tether.liveview.frame' && !liveFrame) liveFrame = message;
});

const request = (type, payload = {}, timeoutMs = 30_000) => {
  const id = `acceptance-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
    socket.send(JSON.stringify({ type, id, ...payload }));
  });
};

const requireOk = async (type, payload, timeoutMs) => {
  const result = await request(type, payload, timeoutMs);
  assert.equal(result.ok, true, `${type}: ${result.error || 'failed'}`);
  return result;
};

const waitForLiveFrame = async () => {
  const deadline = Date.now() + 30_000;
  while (!liveFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(liveFrame?.jpeg, 'SIGMA live view did not return a JPEG');
  const bytes = Buffer.from(liveFrame.jpeg, 'base64');
  assert.ok(bytes.length > 100_000, 'SIGMA live-view JPEG is unexpectedly small');
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  return bytes.length;
};

try {
  await helloReady;
  assert.equal(hello.backend, 'sigma');
  const listed = await requireOk('tether.config.list');
  const paths = new Set(listed.configs.map((config) => config.path));
  for (const path of [
    '/sigma/exposure/mode', '/sigma/exposure/shutter', '/sigma/exposure/aperture',
    '/sigma/exposure/iso', '/sigma/image/white-balance', '/sigma/image/color-mode',
    '/sigma/image/quality', '/sigma/storage/destination',
  ]) assert.ok(paths.has(path), `missing setting ${path}`);

  const selections = [
    ['/sigma/exposure/mode', 'M'],
    ['/sigma/exposure/shutter', '1/15'],
    ['/sigma/exposure/aperture', 'f/2.8'],
    ['/sigma/exposure/iso', 'Auto'],
    ['/sigma/image/white-balance', 'Auto'],
    ['/sigma/image/color-mode', 'Standard'],
    ['/sigma/image/quality', 'JPEG Fine'],
    ['/sigma/storage/destination', 'Computer'],
  ];
  for (const [path, value] of selections) {
    const set = await requireOk('tether.config.set', { path, value });
    assert.equal(set.config.current, value, `${path} did not retain ${value}`);
  }

  await requireOk('tether.liveview.start', { fps: 1 });
  const previewBytes = await waitForLiveFrame();
  await requireOk('tether.liveview.stop');

  const shot = await requireOk('tether.shoot', { captureId: `sigma-acceptance-${Date.now()}` }, 120_000);
  assert.ok(shot.files?.length, 'SIGMA capture returned no local original');
  for (const name of shot.files) {
    assert.equal(name, name.replace(/[\\/]/g, ''), 'agent returned an unsafe file name');
    const file = join(captureDir, name);
    const info = await stat(file);
    assert.ok(info.size > 1_000_000, `${name} is unexpectedly small`);
    const bytes = await readFile(file);
    if (/\.jpe?g$/i.test(name)) {
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.equal(bytes.at(-2), 0xff);
      assert.equal(bytes.at(-1), 0xd9);
    }
  }
  console.log(`SIGMA hardware acceptance: PASS (preview ${previewBytes} bytes; originals ${shot.files.join(', ')})`);
} finally {
  socket.close();
}
