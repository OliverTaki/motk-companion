# Privacy

MOTK Companion contains no MOTK analytics or advertising telemetry. It listens
on loopback by default and sends only actions explicitly configured by the
owner, such as project-scoped control-plane events, Google writes, or uploads.

Pairing keys, OAuth tokens, job journals, logs, and configuration stay in the
local Companion data directory. Browser-entered hosted-app keys are tab-scoped.
Release packages contain no credentials or production data. Diagnostic output
reports versions, file presence, and local service availability without printing
secret values.

Camera-vendor software, Kdenlive effects, FFmpeg builds, browser services,
Google, Cloudflare, NAS products, and operating-system features have their own
privacy behavior and policies. They are not bundled except where a release
manifest explicitly says otherwise. Runtime tests isolate OpenFX discovery to
avoid loading unrelated installed effects.
