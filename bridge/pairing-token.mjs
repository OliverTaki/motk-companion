// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const normalizeClaims = (claims) => [...new Set((claims || [])
  .map((claim) => String(claim || '').trim())
  .filter(Boolean))].sort();

export function loadOrCreatePairingRecord(tokenStore, claims) {
  mkdirSync(dirname(tokenStore), { recursive: true });
  let record;
  try {
    record = JSON.parse(readFileSync(tokenStore, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`invalid pairing token store: ${error.message}`);
  }

  if (record) {
    if (record.version !== 1 || !TOKEN_PATTERN.test(String(record.token || ''))) {
      throw new Error('pairing token store has an unsupported or invalid record');
    }
    record.claims = normalizeClaims(record.claims);
    record.created = false;
    return record;
  }

  record = {
    version: 1,
    token: randomBytes(32).toString('base64url'),
    claims: normalizeClaims(claims),
    createdAt: new Date().toISOString(),
  };
  const handle = openSync(tokenStore, 'wx', 0o600);
  try {
    writeFileSync(handle, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } finally {
    closeSync(handle);
  }
  try { chmodSync(tokenStore, 0o600); } catch { /* Windows ACLs are inherited. */ }
  record.created = true;
  return record;
}

export function tokenFromUpgradeRequest(req) {
  let queryToken = '';
  try { queryToken = new URL(req.url || '/', 'http://companion.local').searchParams.get('token') || ''; } catch { /* reject below */ }
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return queryToken || bearer;
}

export function pairingTokenMatches(candidate, expected) {
  const left = Buffer.from(String(candidate || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
