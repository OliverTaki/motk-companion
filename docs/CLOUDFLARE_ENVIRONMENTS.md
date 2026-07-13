# Cloudflare environment separation

MOTK uses separate Cloudflare resources for development, preproduction, public beta, and production. A successful deployment is never promoted in place.

## Required separation

Each environment has a unique Worker name, D1 database name and id, admin credential, project credentials, and disposable Google Spreadsheet. Public beta uses no real production project until separately approved. Secrets are entered with `wrangler secret`; they do not belong in Wrangler files, source control, logs, screenshots, or release archives.

The checked-in `cloudflare/wrangler.jsonc` is development-only. `cloudflare/wrangler.production.example.jsonc` is a non-secret production template. Copy the template to an ignored operator file, replace the D1 placeholder, set the approved production route, and enter fresh secrets only after the owner authorizes the final production boundary.

## Promotion and rollback

1. Export the current D1 database before every migration.
2. Restore that export into a new recovery database and compare table counts before changing the active binding.
3. Apply and verify the migration in preproduction using a disposable Spreadsheet.
4. Build and test the exact public candidate without reading development credentials.
5. After owner approval, repeat the backup, restore proof, migration, smoke test, and Google write/readback in production.
6. If acceptance fails, point the Worker binding back to the verified recovery database and redeploy the previously checksummed Worker release.

Google Sheets remains the project-data authority. D1 holds rebuildable control-plane state. Media stays in the project-selected local, NAS, or Drive storage and never transits Cloudflare.

## Gate

Run the Cloudflare test command before deployment. The environment-separation test rejects reused Worker names, reused D1 resources, production workers.dev publication, and secret-like configuration fields.
