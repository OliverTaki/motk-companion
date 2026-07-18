# MOTK Companion contributor entry point

Read this file before changing Companion.

## Product boundary

Companion is the privileged local connector for camera SDK/CLI access,
filesystem-safe originals, media processing, automation, assembly, playout,
and the project-scoped control loop. It is not MOTK Core, MOTK Shoot, Media
Tools, or a cloud media relay.

When this repository is checked out inside the StopMotionStudios workspace,
also read the workspace's `docs/MOTK_ECOSYSTEM_SHARED_DEVELOPMENT_STATE.md`,
`docs/MOTK_COMPANION_SHARED_DEVELOPMENT_NOTE.md`, and the Companion sections of
`docs/MOTK_SHOOT_SHARED_DEVELOPMENT_NOTE.md`. Register active work and append
the shared ledger in the same logical changeset.

## Non-negotiable contracts

- Keep the public bus loopback-only, pairing authenticated, and hosted origins exact.
- Never overwrite originals. New camera/media files use create-new collision handling.
- Keep camera SDK binaries, serials, credentials, owner paths, and captured media out of Git, packages, screenshots, and logs.
- Hardware support is model-and-operation specific. Synthetic adapter tests prove software contracts, not a physical camera.
- Keep SIGMA helper/camera-agent behavior intentionally synchronized with MOTK Shoot when a change is shared.
- Preserve configuration, pairing state, jobs, and production files through update and normal uninstall.

## Required gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-software-regression.ps1 -IncludePackaging
```

Run physical-camera, remote-production, and soak acceptance only when explicitly
authorized and record them separately. Use invented fixtures for normal tests.

Before publishing a package, also run the privacy/identity scrub and public
release gate, update README/CHANGELOG/supported-environment documentation, and
record the exact release commit, tag, ZIP hash, deployment state, and remaining
unverified hardware/environment gates in the shared ledger.
