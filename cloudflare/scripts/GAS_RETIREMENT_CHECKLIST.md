# GAS Retirement Checklist

Do not retire Google Apps Script during implementation. This checklist is the single owner-run activation step after production Cloudflare parity is accepted.

1. Owner activates the production Worker/D1 from `wrangler.production.example.jsonc` with real secrets outside Git.
2. Run remote production health and project authorization checks.
3. Run a production D1 backup with `scripts/backup-d1.ps1`.
4. Prove Sheets write-through/readback for `Jobs`, `Runtimes`, and `Versions`.
5. Prove rollback with a disposable Worker version and a disposable D1 restore target.
6. Switch one owner-selected project from GAS to Cloudflare.
7. Keep GAS endpoint configured but inactive for rollback until the owner signs off.
8. Remove GAS as the active runtime only after the separate acceptance pass records real production evidence.
