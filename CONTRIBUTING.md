# Contributing

MOTK Companion accepts contributions through its public source repository.
Contributions must be original work the
author is entitled to license under GPL-3.0-or-later for code, CC0 for protocol
and schema material, or CC BY-SA 4.0 for documentation.

Use invented fixtures. Do not include client work, production media, private
source, camera SDK binaries, credentials, machine-specific paths, or personal
identifiers. Captured originals are immutable and tests must never overwrite
them. New filesystem behavior requires sandbox, traversal, collision, and
interruption coverage.

Before review, run `tests/run-software-regression.ps1`. Changes to packaging
must additionally use `-IncludePackaging` and pass the public release gate. Hardware support may
be described as supported only after physical evidence is recorded for the
specific model and operation.
