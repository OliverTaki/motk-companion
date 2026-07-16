<!-- SPDX-License-Identifier: CC0-1.0 -->
# MOTK Media Processing Contract 1.0

This contract is the shared boundary between **MOTK Media Tools**, which owns the human-facing browser workflow, and **MOTK Companion**, which owns privileged local execution. The contract is CC0 so another implementation can interoperate without adopting either product's code or interface.

## Ownership

MOTK Media Tools chooses files or browser handles, reads marker lists, validates user input, previews the work, and can execute suitable jobs in browser memory. Production media is not uploaded to MOTK by this contract.

MOTK Companion resolves paths only below its configured production root, invokes allowlisted local tools such as FFmpeg, writes completed artifacts with create-new semantics, records resumable job state, calculates checksums, and reports progress. It never accepts an absolute path from a web client and never overwrites an existing artifact.

## Canonical job

Every request is a `motk.media.job` with `schemaVersion: "1.0"`. Time is canonical in seconds; the original timecode text may be retained as `sourceIn` and `sourceOut`, and `timing.fps` defines frame conversion. A browser job uses `browser-file` and `browser-download`. A Companion job uses relative `companion-file` and `companion-directory` references.

`video.cut.markers` is the first operation. Each marker has a stable id, display name, inclusive start expressed as `startSeconds`, and exclusive end expressed as `endSeconds`. `copy` is fast and keyframe-bound. `accurate` re-encodes for frame-accurate boundaries.

## Safety and lifecycle

- `output.collisionPolicy` is always `create-new`; a repeated name receives a numbered suffix.
- Companion rejects absolute paths, parent traversal, and writes below `raw` or `MOTK_ORIGINALS`.
- A stable `idempotencyKey` lets Companion resume completed marker outputs without repeating them.
- States are `queued`, `running`, `succeeded`, `failed`, or `cancelled`. Progress identifies the marker index and total.
- A result lists each artifact, relative path or browser download name, byte count, and SHA-256 when available.
- Browser and Companion implementations must normalize and validate the same job before processing.

The normative machine-readable forms are `docs/schema/media-job.schema.json` and `docs/schema/media-result.schema.json`.
