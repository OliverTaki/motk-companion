// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleSheetsAdapter } from '../src/google-sheets.mjs';

test('Google adapter preserves existing headers and appends a compatible Version row', async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('?fields=sheets.properties.title')) return Response.json({ sheets: [{ properties: { title: 'Versions' } }] });
    if (url.includes('/values/') && !url.includes(':append') && (!init.method || init.method === 'GET')) return Response.json({ values: [['custom_column', 'version_id', 'shot_id']] });
    if (init.method === 'PUT') return Response.json({ updatedRange: 'Versions!A1:I1' });
    if (url.includes(':append')) return Response.json({ updates: { updatedRange: 'Versions!A2:I2' } });
    throw new Error(`unexpected request: ${url}`);
  };
  const adapter = new GoogleSheetsAdapter({ accessToken: 'test-access-token', fetch });
  const result = await adapter.writeEvent('https://docs.google.com/spreadsheets/d/abcdefghij123456/edit', {
    event: 'motk.version:registered',
    occurredAt: '2026-07-13T01:02:03Z',
    data: { version_id: 'v001', shot_id: 's001', take: 2, kind: 'proxy', file_ref: 'drive:item', duration_frames: 24, checksum: 'sha256:test' },
  });
  assert.equal(result.sheet, 'Versions');
  const append = calls.find((call) => call.url.includes(':append'));
  const row = JSON.parse(append.init.body).values[0];
  assert.equal(row[0], '');
  assert.equal(row[1], 'v001');
  assert.equal(row[2], 's001');
  assert.ok(row.includes('2026-07-13T01:02:03Z'));
  const headerWrite = calls.find((call) => call.init.method === 'PUT');
  assert.ok(headerWrite);
  assert.deepEqual(JSON.parse(headerWrite.init.body).values[0].slice(0, 3), ['custom_column', 'version_id', 'shot_id']);
});

test('Google adapter refreshes OAuth without exposing credentials in the Sheets request', async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fresh-token', expires_in: 3600 });
    if (url.includes('?fields=sheets.properties.title')) return Response.json({ sheets: [{ properties: { title: 'Jobs' } }] });
    if (url.includes('/values/') && !url.includes(':append')) return Response.json({ values: [['job_id', 'recipe', 'status', 'progress', 'updated_at']] });
    if (url.includes(':append')) return Response.json({ updates: { updatedRange: 'Jobs!A2:E2' } });
    throw new Error(`unexpected request: ${url}`);
  };
  const adapter = new GoogleSheetsAdapter({ clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token', fetch });
  await adapter.writeEvent('abcdefghij123456', { event: 'motk.job:status', occurredAt: '2026-07-13T00:00:00Z', data: { job_id: 'j1', status: 'done' } });
  const tokenCall = calls[0];
  assert.match(String(tokenCall.init.body), /grant_type=refresh_token/);
  const sheetsCall = calls.find((call) => call.url.includes('sheets.googleapis.com'));
  assert.equal(sheetsCall.init.headers.authorization, 'Bearer fresh-token');
  assert.doesNotMatch(sheetsCall.url, /client-secret|refresh-token/);
});

test('Google adapter invokes fetch without rebinding its this value', async () => {
  let observedThis = 'not-called';
  const adapter = new GoogleSheetsAdapter({
    accessToken: 'test-access-token',
    fetch: function () {
      observedThis = this;
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  await adapter.google('https://sheets.googleapis.com/v4/spreadsheets/test');
  assert.equal(observedThis, undefined);
});
