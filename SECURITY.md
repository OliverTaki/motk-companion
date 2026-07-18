# Security policy

MOTK Companion is a public beta. Do not publish suspected vulnerabilities or
credentials in an issue, discussion, screenshot, interaction log, or chat.
Provide the owner with the affected version, reproduction steps using invented
data, impact, and whether a secret may have been exposed.

Supported security fixes will target the newest release candidate. A report is
not considered resolved until a regression test covers the failure, the release
manifest and SBOM are rebuilt, and update/rollback acceptance passes.

Never attach production originals, pairing keys, OAuth tokens, service-account
keys, Cloudflare credentials, spreadsheet IDs, NAS credentials, or camera SDK
packages to a report. Rotate a credential immediately if exposure is suspected.

The local bus is loopback-only by default. Browser origins must be exact. Large
media travels directly between owner-selected local, NAS, or Drive storage and
never through Cloudflare as a media relay.
