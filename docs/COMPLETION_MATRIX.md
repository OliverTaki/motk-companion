# Companion completion matrix

This is the engineering truth table for deciding whether Companion work is
complete. `Software verified` and `hardware verified` are intentionally
different states.

| Capability | Implementation | Automated evidence | Physical/external evidence | Current state |
|---|---|---|---|---|
| Pairing, exact origin, loopback bus | Complete | token + supervisor + packaging | Hosted Shoot pairing recorded | Software verified |
| Windows install/update/rollback/uninstall | Complete | deterministic package, running-update, tamper, retain/remove tests | Installed beta.9 launch recorded | Software verified |
| Safe filesystem/original preservation | Complete | traversal, raw boundary, collision, resume, end-to-end tests | SIGMA still original recorded | Software and SIGMA workflow verified |
| SIGMA fp preview/settings/still | Complete for recorded adapter surface | SDK settings regression | Physical fp preview, setting, still, JPEG, Shoot transaction | Hardware verified for recorded fp workflow |
| gPhoto2 camera path | Capture/preview/config implemented | common adapter contract; bridge paths covered by supervisor architecture | No exact model/OS acceptance | Experimental hardware |
| digiCamControl camera path | Still capture implemented; live view and settings are not exposed by the current Companion path | common adapter contract | No exact Canon/Nikon/Sony acceptance | Incomplete for full camera control; capture-only experimental |
| Media Job / Universal VideoCutter execution | Complete | media-cut + runner + contracts | No large real-production endurance claim | Software verified |
| Encoding/upload/assembly | Complete | encode + uploader + assembly + end-to-end | Owner storage/provider specific | Software verified |
| Kdenlive project bridge | Complete | contract/refresh tests | Standalone render runs only when external Kdenlive is supplied | Software verified; external render conditional |
| Playout | Complete | boundary/revision/cache/corruption tests | Physical display and 12-hour production observation not recorded | Software verified |
| Cloudflare control plane/Sheets adapter | Complete for public-beta contract | security, retry, OAuth refresh, Sheets shape, 20-project/800-event isolation | Production activation remains owner-environment acceptance | Software verified |

## One-command gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-software-regression.ps1 -IncludePackaging
```

The gate excludes physical-camera acceptance, remote production acceptance, and
long-duration soak. Never translate those exclusions into a PASS.
