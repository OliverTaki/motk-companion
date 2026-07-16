// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { contractConstants, normalizeIdentity, normalizeVersion, validateEventEnvelope, validateProjectConfig } from '../lib/contracts.mjs';
import { mediaCapabilities, normalizeMediaJob } from '../lib/media-contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['identity', 'project-config', 'version', 'event', 'media-job', 'media-result']) {
  const schema = JSON.parse(readFileSync(join(here, '..', 'docs', 'schema', `${name}.schema.json`), 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' || !schema.$id?.startsWith('urn:motk:schema:')) {
    throw new Error(`${name} schema identity is invalid`);
  }
}

const identity = normalizeIdentity({ project_id: 'project_sample', shot_id: 'SC010_C020', take: '2' });
if (identity.projectId !== 'project_sample' || identity.shotId !== 'SC010_C020' || identity.take !== 2) throw new Error('identity aliases did not normalize');

let legacyRejected = false;
try { normalizeIdentity({ productionId: 'legacy_production', shotId: 'SC010_C020' }); } catch { legacyRejected = true; }
if (!legacyRejected) throw new Error('legacy production alias was accepted implicitly');
const legacy = normalizeIdentity({ productionId: 'legacy_production', shotId: 'SC010_C020' }, { allowLegacyProductionAlias: true });
if (legacy.projectId !== 'legacy_production') throw new Error('explicit legacy compatibility failed');

const checksum = `sha256:${'a'.repeat(64)}`;
const version = normalizeVersion({ ...identity, version_id: 'version_001', kind: 'proxy', fileRef: 'drive:proxy/version_001.mp4', duration_frames: 48, checksum, created_at: '2026-07-13T00:00:00Z' });
if (version.durationFrames !== 48 || version.valid !== true || version.createdAt !== '2026-07-13T00:00:00.000Z') throw new Error('Version normalization failed');

validateProjectConfig({ project_id: 'project_sample', spreadsheetRef: 'user-configured-sheet', mediaAuthority: 'local', storage: { root: 'project-root' } });
const event = validateEventEnvelope({ type: 'event', event: 'shoot.frame:captured', context: identity, data: { captureId: 'capture_1' } });
if (event.context.projectId !== 'project_sample') throw new Error('event context was not normalized');
const runtimeEvent = validateEventEnvelope({ type: 'event', event: 'motk.runtime:status', context: { projectId: 'project_sample' }, data: { status: 'online' } });
if (runtimeEvent.context.shotId !== undefined) throw new Error('project-level event required a shot unexpectedly');

if (!contractConstants.versionKinds.includes('player-proxy')) throw new Error('Version kind list is incomplete');
if (contractConstants.idPattern !== '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') throw new Error('ID pattern drifted');

const mediaJob = normalizeMediaJob({
  kind: 'motk.media.job', schemaVersion: '1.0', jobId: 'cut_demo_001', operation: 'video.cut.markers', createdAt: '2026-07-16T00:00:00Z',
  execution: { target: 'companion' }, source: { kind: 'companion-file', relativePath: 'incoming/reference.mov' },
  output: { kind: 'companion-directory', relativePath: 'deliveries/clips', collisionPolicy: 'create-new' },
  timing: { unit: 'seconds', fps: 24 }, parameters: { mode: 'accurate', markers: [{ id: 'm_001', name: 'Shot 10', startSeconds: 1, endSeconds: 2, sourceIn: '00:00:01:00', sourceOut: '00:00:02:00' }] },
}, { target: 'companion' });
if (mediaJob.parameters.markers[0].endSeconds !== 2 || mediaCapabilities().operations[0].operation !== 'video.cut.markers') throw new Error('media contract normalization failed');

for (const invalid of [
  () => normalizeIdentity({ projectId: '../escape', shotId: 'shot_1' }),
  () => normalizeVersion({ ...identity, versionId: 'version_1', kind: 'proxy', fileRef: 'file', durationFrames: 0, checksum, createdAt: '2026-07-13T00:00:00Z' }),
  () => validateEventEnvelope({ type: 'event', event: 'frame:captured', context: identity, data: {} }),
  () => normalizeMediaJob({ ...mediaJob, source: { kind: 'companion-file', relativePath: '../outside.mov' } }, { target: 'companion' }),
  () => normalizeMediaJob({ ...mediaJob, output: { ...mediaJob.output, collisionPolicy: 'overwrite' } }, { target: 'companion' }),
]) {
  let rejected = false;
  try { invalid(); } catch { rejected = true; }
  if (!rejected) throw new Error('invalid contract input was accepted');
}

console.log('PASS');
console.log('Canonical IDs, Version records, project configuration, event envelopes, and Media Job 1.0 were validated.');
