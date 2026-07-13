// SPDX-License-Identifier: AGPL-3.0-or-later

const TABLES = Object.freeze({
  'motk.job:status': { sheet: 'Jobs', columns: ['job_id', 'recipe', 'status', 'progress', 'updated_at'] },
  'motk.runtime:status': { sheet: 'Runtimes', columns: ['runtime_id', 'status', 'version', 'last_seen_at'] },
  'motk.version:registered': { sheet: 'Versions', columns: ['version_id', 'shot_id', 'take', 'kind', 'file_ref', 'duration_frames', 'checksum', 'updated_at'] },
});

function spreadsheetId(reference) {
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('spreadsheet_ref_missing');
  const value = reference.trim();
  const match = value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  const id = match ? match[1] : value;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('spreadsheet_ref_invalid');
  return id;
}

function quotedSheet(name) { return `'${name.replaceAll("'", "''")}'`; }

function assertCompatibleHeaders(headers, table) {
  const normalized = headers.map((value) => String(value || '').trim());
  if (normalized.some((value) => /^fi_[A-Za-z0-9._-]+$/i.test(value))) {
    throw new Error(`core_contract_sheet_conflict:${table.sheet}`);
  }
  if (normalized.length && !table.columns.some((column) => normalized.includes(column))) {
    throw new Error(`companion_sheet_schema_conflict:${table.sheet}`);
  }
}

async function responseJson(response) {
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body?.error?.message || body?.error || `google_http_${response.status}`);
  return body;
}

export class GoogleSheetsAdapter {
  constructor(options = {}) {
    // Cloudflare's native fetch rejects method-style calls whose `this` value
    // is the adapter instance. Keep the implementation in a lexical binding
    // so native fetch and injected test doubles are plain-function calls.
    const fetchImpl = options.fetch || globalThis.fetch;
    this.fetch = (...args) => fetchImpl(...args);
    this.clientId = options.clientId || '';
    this.clientSecret = options.clientSecret || '';
    this.refreshToken = options.refreshToken || '';
    this.accessToken = options.accessToken || '';
    this.accessTokenExpiresAt = 0;
  }

  supports(eventName) { return Boolean(TABLES[eventName]); }

  async token() {
    if (this.accessToken && (!this.accessTokenExpiresAt || Date.now() < this.accessTokenExpiresAt - 30000)) return this.accessToken;
    if (!this.clientId || !this.clientSecret || !this.refreshToken) throw new Error('google_oauth_not_configured');
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: 'refresh_token' }),
    });
    const body = await responseJson(response);
    if (!body.access_token) throw new Error('google_access_token_missing');
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) * 1000);
    return this.accessToken;
  }

  async google(url, options = {}) {
    const response = await this.fetch(url, { ...options, headers: { authorization: `Bearer ${await this.token()}`, ...(options.headers || {}) } });
    return responseJson(response);
  }

  async ensureTable(id, table) {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
    const metadata = await this.google(`${base}?fields=sheets.properties.title`);
    const titles = (metadata.sheets || []).map((sheet) => sheet.properties?.title);
    if (!titles.includes(table.sheet)) {
      await this.google(`${base}:batchUpdate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: table.sheet } } }] }) });
    }
    const range = encodeURIComponent(`${quotedSheet(table.sheet)}!1:1`);
    const headerResult = await this.google(`${base}/values/${range}`);
    const headers = headerResult.values?.[0] || [];
    assertCompatibleHeaders(headers, table);
    const merged = [...headers];
    for (const column of table.columns) if (!merged.includes(column)) merged.push(column);
    if (merged.length !== headers.length || headers.length === 0) {
      await this.google(`${base}/values/${range}?valueInputOption=RAW`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range: `${quotedSheet(table.sheet)}!1:1`, majorDimension: 'ROWS', values: [merged] }) });
    }
    return merged;
  }

  async writeEvent(spreadsheetRef, event) {
    const table = TABLES[event.event];
    if (!table) return { skipped: true, reason: 'event_not_mapped' };
    const id = spreadsheetId(spreadsheetRef);
    const data = { ...(event.data || {}) };
    if (!data.updated_at) data.updated_at = event.occurredAt || new Date().toISOString();
    if (event.event === 'motk.runtime:status' && !data.last_seen_at) data.last_seen_at = data.updated_at;
    const headers = await this.ensureTable(id, table);
    const values = headers.map((header) => data[header] === undefined ? '' : data[header]);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
    const range = encodeURIComponent(`${quotedSheet(table.sheet)}!A:ZZ`);
    const result = await this.google(`${base}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values: [values] }) });
    return { skipped: false, sheet: table.sheet, updatedRange: result.updates?.updatedRange || '' };
  }
}

export function googleSheetsAdapterFromEnv(env) {
  if (env.GOOGLE_SHEETS_ADAPTER) return env.GOOGLE_SHEETS_ADAPTER;
  if (!env.GOOGLE_ACCESS_TOKEN && !(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN)) return null;
  return new GoogleSheetsAdapter({ accessToken: env.GOOGLE_ACCESS_TOKEN, clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN });
}

export const googleSheetTables = TABLES;
