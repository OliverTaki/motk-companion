# Supported environment — public beta

| Component | Current evidence | Public-beta status |
|---|---|---|
| Windows | Windows user-scope install/update/uninstall test | Software verified |
| Node.js | Official Node.js 24.18.0 Windows x64, pinned by SHA-256 | Bundled and verified |
| Kdenlive/MLT | Kdenlive 26.04.3 / MLT 7.40.0, 40-frame 1280x720 render | Software verified; installed separately |
| SIGMA fp | Physical preview, exposure settings, native still transfer, JPEG integrity, no-overwrite capture, and one-frame MOTK Shoot transaction on 2026-07-19 | Hardware verified for this recorded Windows workflow; other fp-family bodies/firmware remain model-specific |
| ELECOM UVC / Windows Hello | RGB capture and post-restart Hello coexistence evidence | Coexistence recorded; model certification pending |
| Canon, Nikon, Sony through digiCamControl | Capture adapter and common IPC/original-preservation contract verified with synthetic fixtures | Experimental; no camera model, live view, or remote-setting operation is hardware verified |
| gPhoto2-supported cameras | Capture, preview, configuration discovery/change, and common IPC/original-preservation contract implemented and synthetically verified | Experimental until the exact camera/OS operation passes physical acceptance |
| NAS | Sandbox, create-new copy, checksums, resume, and interruption behavior verified with local synthetic filesystems | 12-hour bench test intentionally deferred in favor of owner-observed real shooting; no NAS model is certified |
| Google / Cloudflare | Environment separation, OAuth refresh, Sheets adapter, Worker security/retry, and 20-project/800-event isolation verified locally | Public-beta control plane; remote production activation and production-data acceptance remain owner-environment gates |

Only exact models and operations with recorded physical evidence appear as
hardware verified. Other adapters remain experimental until tested on that model.

Software regression:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-software-regression.ps1 -IncludePackaging
```

This intentionally excludes physical camera actions, remote production writes,
and the long-duration soak test.
