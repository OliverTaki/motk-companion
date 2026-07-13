// SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, copyFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export function sandboxResolve(root, ...segments) {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  // isAbsolute(rel) catches Windows cross-drive targets (relative('C:\a','D:\b') → 'D:\b').
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(target) === resolve(base, '..')) {
    throw new Error('path escapes configured root');
  }
  return target;
}

export function assertWritablePath(root, target, options = {}) {
  const path = sandboxResolve(root, relative(resolve(root), resolve(target)));
  const parts = relative(resolve(root), path).split(/[\\/]+/).filter(Boolean);
  if (!options.allowOriginalCreate && parts.some((part) => ['raw', 'motk_originals'].includes(part.toLowerCase()))) {
    throw new Error('originals under raw or MOTK_ORIGINALS are read-only');
  }
  return path;
}

function numberedPath(path, number) {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}.${number}${extension}`;
}

export function writeNewFile(root, requestedPath, data, options = {}) {
  const base = assertWritablePath(root, requestedPath, options);
  mkdirSync(dirname(base), { recursive: true });
  const limit = Number(options.maxCollisions || 10000);
  for (let i = 0; i <= limit; i += 1) {
    const target = i === 0 ? base : numberedPath(base, i);
    let handle;
    try {
      handle = openSync(target, 'wx', options.mode ?? 0o600);
      writeFileSync(handle, data);
      closeSync(handle);
      return { path: target, collision: i > 0, suffix: i };
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`collision limit exceeded for ${base}`);
}

export function copyNewFile(root, source, requestedPath, options = {}) {
  const base = assertWritablePath(root, requestedPath, options);
  mkdirSync(dirname(base), { recursive: true });
  for (let i = 0; i <= 10000; i += 1) {
    const target = i === 0 ? base : numberedPath(base, i);
    try {
      copyFileSync(source, target, 1);
      return { path: target, collision: i > 0, suffix: i };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`collision limit exceeded for ${base}`);
}
