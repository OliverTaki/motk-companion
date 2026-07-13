// SPDX-License-Identifier: GPL-3.0-or-later

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_KINDS = new Set(['camera-original', 'capture-jpeg', 'preview', 'proxy', 'prores', 'editorial', 'player-proxy']);

function requiredString(value, name, pattern = ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalId(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, name);
}

export function normalizeIdentity(input = {}, { allowLegacyProductionAlias = false, requireShot = true } = {}) {
  const projectId = input.projectId ?? input.project_id ?? (allowLegacyProductionAlias ? input.productionId : undefined);
  const shotId = input.shotId ?? input.shot_id;
  const takeValue = input.take;
  const identity = {
    projectId: requiredString(projectId, 'projectId'),
  };
  if (requireShot) identity.shotId = requiredString(shotId, 'shotId');
  else if (shotId !== undefined && shotId !== null && shotId !== '') identity.shotId = requiredString(shotId, 'shotId');

  const assetId = optionalId(input.assetId ?? input.asset_id, 'assetId');
  const taskId = optionalId(input.taskId ?? input.task_id, 'taskId');
  const memberId = optionalId(input.memberId ?? input.member_id, 'memberId');
  const fieldId = optionalId(input.fieldId ?? input.field_id, 'fieldId');
  if (assetId) identity.assetId = assetId;
  if (taskId) identity.taskId = taskId;
  if (memberId) identity.memberId = memberId;
  if (fieldId) identity.fieldId = fieldId;

  if (takeValue !== undefined && takeValue !== null && takeValue !== '') {
    const take = Number(takeValue);
    if (!Number.isInteger(take) || take < 1) throw new Error('take is invalid');
    identity.take = take;
  }
  return identity;
}

export function normalizeVersion(input = {}) {
  const identity = normalizeIdentity(input);
  const durationFrames = Number(input.durationFrames ?? input.duration_frames);
  const createdAt = input.createdAt ?? input.created_at;
  const kind = input.kind;

  if (!VERSION_KINDS.has(kind)) throw new Error('kind is invalid');
  if (!Number.isInteger(durationFrames) || durationFrames < 1) throw new Error('durationFrames is invalid');
  if (typeof input.fileRef !== 'string' || !input.fileRef.trim()) throw new Error('fileRef is invalid');
  if (typeof input.checksum !== 'string' || !CHECKSUM_PATTERN.test(input.checksum)) throw new Error('checksum is invalid');
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt is invalid');

  return {
    ...identity,
    versionId: requiredString(input.versionId ?? input.version_id, 'versionId'),
    kind,
    fileRef: input.fileRef,
    durationFrames,
    checksum: input.checksum,
    valid: input.valid !== false,
    createdAt: new Date(createdAt).toISOString(),
  };
}

export function validateProjectConfig(input = {}) {
  const projectId = requiredString(input.projectId ?? input.project_id, 'projectId');
  if (!['drive', 'nas', 'local'].includes(input.mediaAuthority)) throw new Error('mediaAuthority is invalid');
  if (typeof input.spreadsheetRef !== 'string' || !input.spreadsheetRef.trim()) throw new Error('spreadsheetRef is invalid');
  if (!input.storage || typeof input.storage !== 'object' || Array.isArray(input.storage)) throw new Error('storage is invalid');
  if (typeof input.storage.root !== 'string' || !input.storage.root.trim()) throw new Error('storage.root is invalid');
  return { ...input, projectId };
}

export function validateEventEnvelope(input = {}) {
  if (input.type !== 'event') throw new Error('event type is invalid');
  if (typeof input.event !== 'string' || !/^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/.test(input.event)) {
    throw new Error('event name is invalid');
  }
  const context = normalizeIdentity(input.context || {}, { requireShot: false });
  if (input.data !== undefined && (input.data === null || typeof input.data !== 'object' || Array.isArray(input.data))) {
    throw new Error('event data is invalid');
  }
  return { type: 'event', event: input.event, context, data: input.data || {}, occurredAt: input.occurredAt || new Date().toISOString() };
}

export const contractConstants = Object.freeze({
  idPattern: ID_PATTERN.source,
  checksumPattern: CHECKSUM_PATTERN.source,
  versionKinds: Object.freeze([...VERSION_KINDS]),
});
