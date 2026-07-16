# Changelog

## Unreleased

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
