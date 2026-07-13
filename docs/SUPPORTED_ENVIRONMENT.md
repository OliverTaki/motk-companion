# Supported environment — public beta

| Component | Current evidence | Public-beta status |
|---|---|---|
| Windows | Windows user-scope install/update/uninstall test | Software verified |
| Node.js | Official Node.js 24.18.0 Windows x64, pinned by SHA-256 | Bundled and verified |
| Kdenlive/MLT | Kdenlive 26.04.3 / MLT 7.40.0, 40-frame 1280x720 render | Software verified; installed separately |
| SIGMA fp family | Discovery and live view evidence; official sample still transfer | Native still transfer not yet certified |
| ELECOM UVC / Windows Hello | RGB capture and post-restart Hello coexistence evidence | Coexistence recorded; model certification pending |
| Canon, Nikon, Sony | Companion architecture and planned adapters | Not hardware verified; do not claim support |
| NAS | Local filesystem behavior only | Real NAS/service-account acceptance pending |
| Google / Cloudflare | Separate development/preproduction, remote D1 migration/restore, real Sheets write/readback | Public-beta control plane; production-data certification pending |

Only exact models and operations with recorded physical evidence appear as
hardware verified. Other adapters remain experimental until tested on that model.
