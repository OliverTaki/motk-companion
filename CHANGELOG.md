# Changelog

## Unreleased

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
