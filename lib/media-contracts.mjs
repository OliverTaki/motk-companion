// SPDX-License-Identifier: CC0-1.0

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const OPERATIONS = new Set(['video.cut.markers']);
const TARGETS = new Set(['auto', 'browser', 'companion']);
const SOURCE_KINDS = new Set(['browser-file', 'companion-file']);
const OUTPUT_KINDS = new Set(['browser-download', 'companion-directory']);

const requiredText = (value, name, pattern = null) => {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) throw new Error(`${name} is invalid`);
  return value.trim();
};

export function assertRelativeMediaPath(value, name) {
  const path = requiredText(value, name).replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`${name} must be a relative path inside the configured Companion root`);
  }
  return path;
}

const normalizeMarker = (input, index) => {
  const startSeconds = Number(input?.startSeconds);
  const endSeconds = Number(input?.endSeconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error(`markers[${index}].startSeconds is invalid`);
  if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error(`markers[${index}].endSeconds is invalid`);
  return {
    id: requiredText(input.id || `marker_${String(index + 1).padStart(3, '0')}`, `markers[${index}].id`, ID),
    name: requiredText(input.name || `clip_${String(index + 1).padStart(3, '0')}`, `markers[${index}].name`).slice(0, 160),
    startSeconds,
    endSeconds,
    ...(input.sourceIn ? { sourceIn: String(input.sourceIn) } : {}),
    ...(input.sourceOut ? { sourceOut: String(input.sourceOut) } : {}),
  };
};

export function normalizeMediaJob(input = {}, options = {}) {
  if (input.kind !== 'motk.media.job' || input.schemaVersion !== '1.0') throw new Error('media job contract version is invalid');
  if (!OPERATIONS.has(input.operation)) throw new Error('operation is unsupported');
  const target = input.execution?.target || 'auto';
  if (!TARGETS.has(target)) throw new Error('execution.target is invalid');
  const sourceKind = input.source?.kind;
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error('source.kind is invalid');
  const outputKind = input.output?.kind;
  if (!OUTPUT_KINDS.has(outputKind)) throw new Error('output.kind is invalid');
  if (input.output?.collisionPolicy !== 'create-new') throw new Error('output.collisionPolicy must be create-new');
  const fps = Number(input.timing?.fps);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error('timing.fps is invalid');
  const markers = input.parameters?.markers;
  if (!Array.isArray(markers) || markers.length < 1 || markers.length > 5000) throw new Error('parameters.markers is invalid');
  const mode = input.parameters?.mode || 'accurate';
  if (!['copy', 'accurate'].includes(mode)) throw new Error('parameters.mode is invalid');
  const source = sourceKind === 'companion-file'
    ? { kind: sourceKind, relativePath: assertRelativeMediaPath(input.source.relativePath, 'source.relativePath'), name: input.source.name || input.source.relativePath.split(/[\\/]/).pop() }
    : { kind: sourceKind, name: requiredText(input.source.name, 'source.name'), ...(Number.isFinite(Number(input.source.size)) ? { size: Number(input.source.size) } : {}) };
  const output = outputKind === 'companion-directory'
    ? { kind: outputKind, relativePath: assertRelativeMediaPath(input.output.relativePath, 'output.relativePath'), container: 'mp4', collisionPolicy: 'create-new' }
    : { kind: outputKind, archive: input.output.archive === 'individual' ? 'individual' : 'zip', container: 'mp4', collisionPolicy: 'create-new' };
  if (options.target === 'companion' && (source.kind !== 'companion-file' || output.kind !== 'companion-directory')) {
    throw new Error('Companion execution requires companion-file and companion-directory references');
  }
  return {
    kind: 'motk.media.job', schemaVersion: '1.0',
    jobId: requiredText(input.jobId, 'jobId', ID),
    operation: input.operation,
    createdAt: new Date(input.createdAt || Date.now()).toISOString(),
    execution: { target },
    source,
    output,
    timing: { unit: 'seconds', fps },
    parameters: { mode, markers: markers.map(normalizeMarker) },
    ...(input.context && typeof input.context === 'object' ? { context: { ...input.context } } : {}),
    ...(typeof input.idempotencyKey === 'string' && input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}

export function mediaCapabilities() {
  return {
    kind: 'motk.media.capabilities', schemaVersion: '1.0',
    operations: [{ operation: 'video.cut.markers', modes: ['copy', 'accurate'], sourceKinds: ['companion-file'], outputKinds: ['companion-directory'], collisionPolicy: 'create-new' }],
  };
}

export const mediaContractConstants = Object.freeze({
  operations: Object.freeze([...OPERATIONS]),
  targets: Object.freeze([...TARGETS]),
  maxMarkers: 5000,
});
