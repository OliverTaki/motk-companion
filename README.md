<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# MOTK Companion

MOTK Companion is the local connector for MOTK production tools. It hosts the
authenticated local bus and will provide small, independently runnable camera,
filesystem, encoding, upload, automation, assembly, and playout capabilities.

This is the public beta source for MOTK Companion. The beta is free software
and is intended for evaluation and real-production feedback with backups.
Physical camera, NAS service-context, and long-duration display certification
remain model- and workflow-specific.

## Current capabilities

## Windows quick start

Extract the Windows ZIP and double-click **INSTALL MOTK COMPANION.cmd**. Choose
storage and camera once, then use the visual Control Center: **SHOOT** opens and
pairs MOTK Shoot automatically, while **FILES** opens the exact local production
folder. Physical-camera files are written to the visible **Camera Originals**
subfolder. Settings and manual pairing for another device are behind the gear
control. Saving a changed camera or SDK restarts only Companion's local services,
so the new backend is active immediately. No PowerShell command needs to be typed.

The Companion supervisor starts the absorbed bridge, monitors its lifecycle,
and serves JSON diagnostics at `/status`. A 32-byte first-run pairing token is
required by default.
The token is required by default in the Companion. A client presents it in the
WebSocket URL as `?token=...` or as an `Authorization: Bearer ...` header.

Run the milestone checks with Node 22 or later:

```text
node tests/token-selftest.mjs
node tests/supervisor-selftest.mjs
```

Start the configured supervisor with `node companion.mjs`. Relative paths in
`companion.json` resolve beside that configuration file.

For a hosted MOTK Shoot page, set `allowOrigin` to that page's exact HTTPS
origin (for example `https://shoot.example`). Companion still listens on
loopback only. The browser asks the user for Local network access, then camera
and media traffic goes directly to Companion rather than through the hosting
service.

When `projectId`, `runtimeId`, `controlPlaneEndpoint`, and
`controlPlaneToken` are configured, the supervisor also starts the Control
Loop. It claims project-scoped Production commands, executes them through the
same idempotent Runner used by local recipes, acknowledges the result, and
recovers an expired claim after a runtime interruption.

Install-local values such as `nasRoot` can be supplied through
`productionContextDefaults`. Production commands may override those defaults;
keep local paths and credentials out of published configuration.

The bridge remains independently runnable:

```text
node bridge/production-agent.mjs --backend dummy --production-root ./example-production
```

Use invented data only. Never point development tests at real production
originals.

## Kdenlive editorial bridge

`cap-editor-kdenlive.mjs` creates a new Kdenlive 1.1 / MLT project from a
MOTK sequence specification and can inspect or refresh it without losing the
project, shot, take, version, source-duration, trim, or follow-latest fields.
A refresh follows only opted-in shots, preserves head and tail trims, and
ripples the sequence when the latest Version duration changes. It always
creates a new project revision and never overwrites an existing project.
Rendered editorials can be registered as a checksummed `editorial` Version
through `registerEditorialVersion`.

```text
node cap-editor-kdenlive.mjs --mode create --spec sequence.json --production-root D:\MOTK_PROJECT --output editorial\main.kdenlive
node cap-editor-kdenlive.mjs --mode inspect --project D:\MOTK_PROJECT\editorial\main.kdenlive
node cap-editor-kdenlive.mjs --mode refresh --project D:\MOTK_PROJECT\editorial\main.kdenlive --versions versions.json --production-root D:\MOTK_PROJECT --output editorial\main-latest.kdenlive
```

The generated project uses Kdenlive's current multi-sequence structure. The
built-in mappings cover 1280x720, 1920x1080, 3840x2160, and 4096x2160 at
23.976, 24, 25, 29.97, 30, 50, 59.94, and 60 fps. Other profiles remain valid
MLT projects and return a warning because Kdenlive may ask the operator to
choose a matching profile.

The normal self-test validates the contract without requiring an editor. To
also generate real media and render the project through both MLT and Kdenlive,
point `MOTK_KDENLIVE_BIN` at a Kdenlive standalone `bin` directory:

```text
set MOTK_KDENLIVE_BIN=C:\path\to\kdenlive-standalone\bin
node --test tests\kdenlive-selftest.mjs
```

The runtime test isolates OpenFX discovery, uses temporary invented media,
checks the rendered frame count and resolution, and removes its fixture.

## Playout soak and control-plane load acceptance

`tests/playout-soak.mjs` is a constant-memory software soak that measures
boundaries, safe revision activation, watchdog recovery, skipped shots, and
RSS growth. It defaults to 60 seconds; set `MOTK_SOAK_SECONDS=43200` for a
12-hour software run. Physical display, dropped-frame, audio, camera, and
NAS-loss acceptance is recorded during an owner-approved real shooting
workflow. Deferred physical checks are not reported as verified software
passes.

The Cloudflare suite includes a 20-project / 800-event local isolation load.
`cloudflare/tests/remote-load-acceptance.mjs` repeats the same contract against
an explicitly configured disposable remote development Worker. It never
prints credentials; its test projects should be removed after the run.

## Windows public beta

The user-scope Windows package bundles the checksum-pinned official Node.js
runtime while keeping mutable configuration, pairing records, job journals,
logs, caches, and production data outside the application directory. Build and
verify it with:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-release.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\packaging-selftest.ps1
```

The builder uses a fixed source timestamp, a strict source allowlist, an SPDX
SBOM, SHA-256 file manifest, Node's upstream license, and a public-candidate
secret/privacy gate. Identical inputs produce an identical ZIP hash. The
packaging test performs an isolated install and launch, rejects tampering,
updates without changing configuration/pairing/jobs, retains data on normal
uninstall, and removes it only when explicitly requested.

See `docs/INSTALL_WINDOWS.md` and `docs/SUPPORTED_ENVIRONMENT.md`. Verify the
published ZIP checksum before installation and keep production originals
backed up independently.

## MOTK Media Tools processing contract

MOTK Media Tools and Companion share the CC0 Media Job 1.0 contract in
`docs/MEDIA_PROCESSING_CONTRACT.md`. Universal VideoCutter is the first module:
small and medium jobs can run privately in browser memory, while the same
normalized marker job can be executed against relative paths below the
configured Companion production root with resumable, checksummed,
create-new-only output.

Use `media.capabilities` and `media.job.run` with `cap-runner.mjs`, or invoke
`cap-media-cut.mjs --job media-job.json --config companion.json` directly.
Absolute paths, parent traversal, originals writes, and overwrite policies are
rejected.

## Filesystem and preset rules

Any path segment named `raw` is treated as an originals boundary and is
read-only to general capabilities. Camera adapters alone may create new files
there, and even they cannot replace one. A production folder that is itself
named `RAW` is therefore intentionally rejected.

Preset authors may use ffmpeg `-y` only because the encode capability always
targets a new random `.encode-*` temporary file and installs the completed
result through create-only copying. Stale encode temporaries older than one day
are swept on the next encode; `raw/` trees are never traversed by that sweep.

## License

Code is GPL-3.0-or-later. Protocols and schemas added later will be CC0. Docs
are CC BY-SA 4.0.
