# Changelog

## Unreleased

## 0.4.0-beta.5 - 2026-07-17

- Restarts only the Companion services after saving a changed camera backend or
  SDK path, so the Control Center no longer says SIGMA while a previous dummy
  bridge keeps running.
- Makes camera originals visible in `Camera Originals` below the chosen FILES
  root. Updating safely migrates the former hidden `.companion-capture` folder.
- Corrects the SIGMA SDK's misspelled capture-database export, initializes the
  fp's still/PC capture state explicitly, and exposes camera diagnostics without
  redistributing vendor binaries.
- Pairs with the MOTK Shoot capture transaction fix: a failed physical shutter
  no longer leaves a false frame or advances the frame counter.

## 0.4.0-beta.4 - 2026-07-16

- Replaces separate Start-menu actions and the text-heavy setup form with one
  visual Control Center: `SHOOT`, `FILES`, and two smaller secondary actions.
- Opens MOTK Shoot with one-click, fragment-only pairing. The web page consumes
  the local pairing key, removes it from browser history, stores it only for the
  current tab, and connects automatically.
- Moves storage, camera selection, SIGMA SDK selection, manual pairing, and Media
  Tools behind the main surface instead of presenting them during every launch.
- Reduces the extracted download to one user action plus `_internal`, and reduces
  the installed application front to `MOTK Companion.exe` plus `_internal`.
- Keeps update rollback, tamper rejection, configuration, pairing keys, job
  journals, and production media compatible with the former flat beta layout.

## 0.4.0-beta.3 — 2026-07-16

- Windows install and update now detect and stop only the installed Companion
  processes before replacing application files; updates restart Companion when
  it was already running.
- Replaced the direct move of a live installation with a copied rollback plus
  same-parent directory swap. A failed swap restores the untouched old install
  instead of leaving a partially moved application.
- Incomplete installs are preserved separately as partial-recovery evidence and
  are never advertised as a valid rollback target.
- Uninstall now stops a running Companion before removing application files.
- Added an automated running-update regression covering stop, replacement,
  restart, settings/key/job preservation, and uninstall.

## 0.4.0-beta.2 — 2026-07-16

- Added a double-click Windows installer, a first-run setup window, and Start
  menu entries for starting Companion, changing setup, copying the pairing key,
  and opening the exact local media folder.
- New Windows installs trust the official MOTK public-site origin by default;
  the setup window makes the selected local media boundary explicit.
- Companion now forwards the configured SIGMA SDK ZIP, optional camera serial,
  and digiCamControl command to the protected local camera agent.
- Added a plain-language `README FIRST.txt`; users no longer need to type an
  execution-policy command or invoke unsigned `.ps1` files directly.

## 0.4.0-beta.1 — 2026-07-16

- Added the CC0 MOTK Media Job and Media Result 1.0 contracts shared with
  browser-based MOTK Media Tools.
- Added Universal VideoCutter Companion execution for marker-based MP4 clips.
- Companion media jobs accept relative paths below the configured root only,
  protect originals boundaries, never overwrite, report progress, calculate
  SHA-256 checksums, and resume already completed marker outputs.
- Runner now exposes `media.capabilities` and `media.job.run`; the same job can
  also run through `cap-media-cut.mjs`.

This is a public beta. Use invented or backed-up media for initial evaluation.
Browser Media Tools remains the recommended surface for ordinary-size jobs;
Companion handles large or production-root media locally.

- Production now runs five server-known recipes (post-capture, proxy, ProRes,
  upload, Version publish) with a required completed dry-run preview before
  execution, verified independently by the Worker.
- The Worker derives required `production.*` capabilities from its own recipe
  map; execution re-checks the full production context against the preview.
- Added project members with `admin`, `production`, `shoot`, and `core` roles;
  Admin manages recipes, operating mode, members, keys, backup/restore, and
  audit with least-privilege token scopes.
- Project backups exclude all tokens and secrets; restore lands in recovery
  mode until an Admin returns the project to normal.
- Added control-plane migration `0002_project_operations.sql`, owner-run D1
  backup/restore and Worker rollback scripts, and a GAS retirement checklist.
- Added the pre-publish identity/scrub guard to packaging.

These changes are published for public testing ahead of the separate
regression/acceptance pass; no acceptance item is certified by this update.

## 0.3.0-beta.1 — 2026-07-13

- Added the authenticated loopback Companion supervisor and hosted Shoot pairing.
- Added project-scoped Cloudflare command/control integration with durable retry.
- Added resumable automation, encoding, upload, assembly, and playout capabilities.
- Added current-format Kdenlive/MLT editorial project generation and registration.
- Added reproducible Windows public-beta packages with manifest, SBOM, safe update,
  rollback retention, diagnostics, and explicit data-preserving uninstall behavior.

This is a public beta. Physical camera, NAS service-context, long-duration
display, and real-production certification remain intentionally limited to
the exact hardware and workflows listed in the supported-environment guide.
