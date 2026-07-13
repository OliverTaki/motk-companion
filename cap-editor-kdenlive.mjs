// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIdentity, normalizeVersion } from './lib/contracts.mjs';
import { postControlEvent } from './lib/motk-client.mjs';
import { sandboxResolve, writeNewFile } from './lib/safe-fs.mjs';

const escapeXml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unescapeXml = (value) => String(value ?? '').replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const property = (name, value) => `    <property name="${escapeXml(name)}">${escapeXml(value)}</property>`;

function stableUuid(...parts) {
  const bytes = Buffer.from(createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fpsFraction(fps) {
  const value = Number(fps || 25);
  if (Math.abs(value - 23.976) < 0.01) return [24000, 1001];
  if (Math.abs(value - 29.97) < 0.01) return [30000, 1001];
  if (Math.abs(value - 59.94) < 0.01) return [60000, 1001];
  if (!Number.isFinite(value) || value <= 0) throw new Error('fps is invalid');
  return Number.isInteger(value) ? [value, 1] : [Math.round(value * 1000), 1000];
}

function frameTimecode(frames, fps) {
  const wholeFps = Math.max(1, Math.round(fps));
  const hours = Math.floor(frames / (wholeFps * 3600));
  const minutes = Math.floor(frames / (wholeFps * 60)) % 60;
  const seconds = Math.floor(frames / wholeFps) % 60;
  const remainder = frames % wholeFps;
  return [hours, minutes, seconds, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function kdenliveProfileId(width, height, fps) {
  const suffixes = [[23.976, '2398'], [24, '24'], [25, '25'], [29.97, '2997'], [30, '30'], [50, '50'], [59.94, '5994'], [60, '60']];
  const suffix = suffixes.find(([candidate]) => Math.abs(candidate - fps) < 0.01)?.[1];
  if (!suffix) return '';
  if (width === 1280 && height === 720) return `atsc_720p_${suffix}`;
  if (width === 1920 && height === 1080) return `atsc_1080p_${suffix}`;
  if (width === 3840 && height === 2160) return `uhd_2160p_${suffix}`;
  if (width === 4096 && height === 2160) return `dci_2160p_${suffix}`;
  return '';
}

function validateSpec(spec, productionRoot) {
  const identity = normalizeIdentity({ projectId: spec.projectId, shotId: spec.clips?.[0]?.shotId || 'sequence' });
  if (!Array.isArray(spec.clips) || !spec.clips.length) throw new Error('clips are required');
  const clips = spec.clips.map((clip, index) => {
    const clipIdentity = normalizeIdentity({ projectId: identity.projectId, shotId: clip.shotId, take: clip.take });
    if (typeof clip.versionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clip.versionId)) throw new Error(`clip ${index} versionId is invalid`);
    const trimIn = Number(clip.trimIn ?? 0); const trimOut = Number(clip.trimOut ?? clip.durationFrames);
    if (!Number.isInteger(trimIn) || !Number.isInteger(trimOut) || trimIn < 0 || trimOut <= trimIn) throw new Error(`clip ${index} trim is invalid`);
    const sourceDurationFrames = Number(clip.sourceDurationFrames ?? clip.durationFrames ?? trimOut);
    if (!Number.isInteger(sourceDurationFrames) || sourceDurationFrames < trimOut) throw new Error(`clip ${index} source duration is invalid`);
    if (typeof clip.fileRef !== 'string' || !clip.fileRef) throw new Error(`clip ${index} fileRef is invalid`);
    const file = sandboxResolve(productionRoot, isAbsolute(clip.fileRef) ? clip.fileRef : clip.fileRef);
    return { ...clipIdentity, versionId: clip.versionId, file, trimIn, trimOut, sourceDurationFrames, followLatest: clip.followLatest !== false };
  });
  return { projectId: identity.projectId, sequenceId: String(spec.sequenceId || 'editorial_sequence'), fps: Number(spec.fps || 25), width: Number(spec.width || 1920), height: Number(spec.height || 1080), clips };
}

export function buildKdenliveProject(spec, options) {
  const productionRoot = resolve(options.productionRoot);
  const value = validateSpec(spec, productionRoot);
  const [fpsNum, fpsDen] = fpsFraction(value.fps);
  const producers = value.clips.map((clip, index) => {
    const id = `producer${index}`;
    return [`  <producer id="${id}" in="${clip.trimIn}" out="${clip.trimOut - 1}">`, property('length', clip.sourceDurationFrames), property('eof', 'pause'), property('resource', clip.file), property('mlt_service', 'avformat'), property('motk:project_id', value.projectId), property('motk:shot_id', clip.shotId), property('motk:version_id', clip.versionId), property('motk:take', clip.take || ''), property('motk:source_duration_frames', clip.sourceDurationFrames), property('motk:follow_latest', clip.followLatest ? '1' : '0'), '  </producer>'].join('\n');
  });
  const entries = value.clips.map((clip, index) => `    <entry producer="producer${index}" in="0" out="${clip.trimOut - clip.trimIn - 1}"/>`);
  const binEntries = value.clips.map((clip, index) => `    <entry producer="producer${index}" in="${clip.trimIn}" out="${clip.trimOut - 1}"/>`);
  const durationFrames = value.clips.reduce((total, clip) => total + clip.trimOut - clip.trimIn, 0);
  const uuidValue = stableUuid(value.projectId, value.sequenceId);
  const sequenceUuid = `{${uuidValue}}`;
  const documentId = BigInt(`0x${createHash('sha256').update(value.projectId).digest('hex').slice(0, 13)}`).toString();
  const sequenceHash = createHash('sha256').update(`${value.projectId}\0${value.sequenceId}`).digest('hex').slice(0, 32);
  const profileId = kdenliveProfileId(value.width, value.height, value.fps);
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<mlt LC_NUMERIC="C" version="7.40.0" root="${escapeXml(productionRoot)}" producer="main_bin">`,
    `  <profile description="MOTK ${value.width}x${value.height} ${value.fps} fps" width="${value.width}" height="${value.height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${value.width}" display_aspect_den="${value.height}" frame_rate_num="${fpsNum}" frame_rate_den="${fpsDen}" colorspace="709"/>`,
    ...producers,
    `  <producer id="black_track" in="0" out="${durationFrames - 1}">`, property('length', '2147483647'), property('eof', 'continue'), property('resource', 'black'), property('mlt_service', 'color'), property('mlt_image_format', 'rgba'), '  </producer>',
    '  <playlist id="playlist0">', ...entries, '  </playlist>',
    '  <playlist id="playlist1"/>',
    `  <tractor id="tractor0" in="0" out="${durationFrames - 1}">`, property('kdenlive:track_name', 'Video 1'), property('kdenlive:trackheight', '67'), property('kdenlive:timeline_active', '1'), property('kdenlive:collapsed', '0'), '    <track hide="audio" producer="playlist0"/>', '    <track hide="audio" producer="playlist1"/>', '  </tractor>',
    `  <tractor id="${sequenceUuid}" in="0" out="${durationFrames - 1}">`, property('kdenlive:uuid', sequenceUuid), property('kdenlive:clipname', value.sequenceId), property('kdenlive:sequenceproperties.hasAudio', '0'), property('kdenlive:sequenceproperties.hasVideo', '1'), property('kdenlive:sequenceproperties.activeTrack', '0'), property('kdenlive:sequenceproperties.tracksCount', '1'), property('kdenlive:sequenceproperties.documentuuid', sequenceUuid), property('kdenlive:duration', frameTimecode(durationFrames, value.fps)), property('kdenlive:maxduration', durationFrames), property('kdenlive:producer_type', '17'), property('kdenlive:id', '1'), property('kdenlive:clip_type', '0'), property('kdenlive:file_hash', sequenceHash), property('kdenlive:folderid', '1'), property('kdenlive:sequenceproperties.groups', '[]'), property('motk:project_id', value.projectId), property('motk:sequence_id', value.sequenceId), '    <track producer="black_track"/>', '    <track producer="tractor0"/>', '    <transition id="transition0">', property('a_track', '0'), property('b_track', '1'), property('mlt_service', 'qtblend'), property('internal_added', '237'), property('always_active', '1'), '    </transition>', '  </tractor>',
    '  <playlist id="main_bin">', property('kdenlive:folder.-1.1', 'Sequences'), property('kdenlive:sequenceFolder', '1'), property('kdenlive:docproperties.audioChannels', '2'), property('kdenlive:docproperties.compositing', '1'), property('kdenlive:docproperties.documentid', documentId), property('kdenlive:docproperties.enableTimelineZone', '0'), property('kdenlive:docproperties.enableproxy', '0'), property('kdenlive:docproperties.generateproxy', '0'), property('kdenlive:docproperties.kdenliveversion', '26.04.3'), property('kdenlive:docproperties.profile', profileId), property('kdenlive:docproperties.uuid', sequenceUuid), property('kdenlive:docproperties.version', '1.1'), property('kdenlive:docproperties.opensequences', sequenceUuid), property('kdenlive:docproperties.activetimeline', sequenceUuid), property('xml_retain', '1'), property('motk:project_id', value.projectId), property('motk:sequence_id', value.sequenceId), ...binEntries, `    <entry producer="${sequenceUuid}" in="0" out="0"/>`, '  </playlist>',
    `  <tractor id="tractor1" in="0" out="${durationFrames - 1}">`, property('kdenlive:projectTractor', '1'), `    <track producer="${sequenceUuid}" in="0" out="${durationFrames - 1}"/>`, '  </tractor>',
    '</mlt>', '',
  ].join('\n');
  const output = sandboxResolve(productionRoot, options.output || `${value.sequenceId}.kdenlive`);
  const written = writeNewFile(productionRoot, output, xml);
  const warnings = profileId ? [] : [`Kdenlive has no bundled profile mapping for ${value.width}x${value.height} at ${value.fps} fps; MLT uses the embedded profile, but Kdenlive may request a profile choice.`];
  return { ...written, projectId: value.projectId, sequenceId: value.sequenceId, clips: value.clips.length, durationFrames, profileId: profileId || null, warnings, xml };
}

function propertiesOf(body) {
  const properties = {};
  for (const match of body.matchAll(/<property\s+name="([^"]+)">([\s\S]*?)<\/property>/g)) properties[unescapeXml(match[1])] = unescapeXml(match[2]);
  return properties;
}

export function inspectKdenliveProject(input) {
  const xml = existsSync(String(input)) ? readFileSync(String(input), 'utf8') : String(input);
  if (xml.length > 10 * 1024 * 1024) throw new Error('MLT project is too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('external XML declarations are not allowed');
  const projectProperties = propertiesOf(xml.match(/<playlist\s+id="main_bin">([\s\S]*?)<\/playlist>/)?.[1] || '');
  const producers = new Map();
  for (const match of xml.matchAll(/<producer\s+id="([^"]+)"[^>]*\sin="(\d+)"\sout="(\d+)"[^>]*>([\s\S]*?)<\/producer>/g)) {
    const props = propertiesOf(match[4]);
    if (!props['motk:project_id'] || !props['motk:shot_id'] || !props['motk:version_id']) continue;
    const trimOut = Number(match[3]) + 1;
    const sourceDurationFrames = Number(props['motk:source_duration_frames'] || props.length || trimOut);
    producers.set(match[1], { projectId: props['motk:project_id'], shotId: props['motk:shot_id'], versionId: props['motk:version_id'], take: props['motk:take'] ? Number(props['motk:take']) : undefined, fileRef: props.resource, trimIn: Number(match[2]), trimOut, sourceDurationFrames, followLatest: props['motk:follow_latest'] !== '0' });
  }
  const clips = [];
  const playlist = xml.match(/<playlist\s+id="playlist0">([\s\S]*?)<\/playlist>/)?.[1] || xml.match(/<playlist\s+id="motk_timeline">([\s\S]*?)<\/playlist>/)?.[1] || xml.match(/<playlist\s+id="main_bin">([\s\S]*?)<\/playlist>/)?.[1] || '';
  for (const match of playlist.matchAll(/<entry\s+producer="([^"]+)"[^>]*\sin="(\d+)"\sout="(\d+)"\s*\/>/g)) {
    if (!producers.has(match[1])) continue;
    const clip = producers.get(match[1]);
    const timelineDuration = Number(match[3]) - Number(match[2]) + 1;
    if (timelineDuration !== clip.trimOut - clip.trimIn) throw new Error(`MLT timeline duration does not match source trim for ${match[1]}`);
    clips.push(clip);
  }
  if (!projectProperties['motk:project_id'] || !clips.length) throw new Error('MLT project has no MOTK sequence contract');
  return { projectId: projectProperties['motk:project_id'], sequenceId: projectProperties['motk:sequence_id'] || 'editorial_sequence', clips };
}

export function refreshKdenliveProject(project, versions, options) {
  if (!Array.isArray(versions)) throw new Error('versions are required');
  const current = inspectKdenliveProject(project);
  const productionRoot = resolve(options.productionRoot);
  const normalized = versions.map((version) => normalizeVersion(version)).filter((version) => version.valid && version.projectId === current.projectId);
  const latestByShot = new Map();
  for (const version of normalized) {
    const previous = latestByShot.get(version.shotId);
    if (!previous || version.createdAt > previous.createdAt || (version.createdAt === previous.createdAt && version.versionId > previous.versionId)) latestByShot.set(version.shotId, version);
  }
  const changes = [];
  const clips = current.clips.map((clip) => {
    const latest = clip.followLatest ? latestByShot.get(clip.shotId) : null;
    if (!latest || latest.versionId === clip.versionId) return clip;
    const tailTrim = Math.max(0, clip.sourceDurationFrames - clip.trimOut);
    const trimOut = latest.durationFrames - tailTrim;
    if (trimOut <= clip.trimIn) throw new Error(`latest Version is too short for preserved trims on ${clip.shotId}`);
    changes.push({ shotId: clip.shotId, fromVersionId: clip.versionId, toVersionId: latest.versionId, fromDurationFrames: clip.sourceDurationFrames, toDurationFrames: latest.durationFrames });
    return { ...clip, versionId: latest.versionId, take: latest.take, fileRef: latest.fileRef, trimOut, sourceDurationFrames: latest.durationFrames };
  });
  if (!changes.length) return { changed: false, projectId: current.projectId, sequenceId: current.sequenceId, changes: [] };
  const output = options.output || `editorial/${current.sequenceId}.refresh.kdenlive`;
  const built = buildKdenliveProject({ projectId: current.projectId, sequenceId: current.sequenceId, fps: options.fps, width: options.width, height: options.height, clips }, { productionRoot, output });
  return { ...built, changed: true, changes };
}

export function editorialVersionFromRender(input, options) {
  const productionRoot = resolve(options.productionRoot);
  const path = sandboxResolve(productionRoot, input.fileRef);
  if (!existsSync(path)) throw new Error('editorial render does not exist');
  const checksum = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  return normalizeVersion({ ...input, kind: 'editorial', fileRef: path, checksum, valid: true, createdAt: input.createdAt || new Date().toISOString() });
}

export async function registerEditorialVersion(endpoint, token, version, options = {}) {
  const data = { version_id: version.versionId, shot_id: version.shotId, take: version.take || '', kind: version.kind, file_ref: version.fileRef, duration_frames: version.durationFrames, checksum: version.checksum, updated_at: version.createdAt };
  return postControlEvent(endpoint, 'motk.version:registered', { projectId: version.projectId, shotId: version.shotId, take: version.take }, data, { token, fetch: options.fetch });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const arg = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : ''; };
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Create:  node cap-editor-kdenlive.mjs --mode create --spec SPEC.json --production-root DIR [--output editorial/name.kdenlive]');
    console.log('Inspect: node cap-editor-kdenlive.mjs --mode inspect --project PROJECT.kdenlive');
    console.log('Refresh: node cap-editor-kdenlive.mjs --mode refresh --project PROJECT.kdenlive --versions VERSIONS.json --production-root DIR [--output editorial/name.kdenlive]');
    process.exit(0);
  }
  const mode = arg('mode');
  if (mode === 'create') console.log(JSON.stringify(buildKdenliveProject(JSON.parse(readFileSync(resolve(arg('spec')), 'utf8').replace(/^\uFEFF/, '')), { productionRoot: resolve(arg('production-root')), output: arg('output') })));
  else if (mode === 'inspect') console.log(JSON.stringify(inspectKdenliveProject(resolve(arg('project'))), null, 2));
  else if (mode === 'refresh') console.log(JSON.stringify(refreshKdenliveProject(resolve(arg('project')), JSON.parse(readFileSync(resolve(arg('versions')), 'utf8').replace(/^\uFEFF/, '')), { productionRoot: resolve(arg('production-root')), output: arg('output') }), null, 2));
  else throw new Error('use --mode create, inspect, or refresh');
}
