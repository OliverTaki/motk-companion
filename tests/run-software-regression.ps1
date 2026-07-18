# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([switch]$IncludePackaging)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeTests = @(
  'tests/token-selftest.mjs',
  'tests/supervisor-selftest.mjs',
  'tests/safefs-selftest.mjs',
  'tests/runner-selftest.mjs',
  'tests/playout-selftest.mjs',
  'tests/media-cut-selftest.mjs',
  'tests/kdenlive-selftest.mjs',
  'tests/end-to-end-selftest.mjs',
  'tests/encode-selftest.mjs',
  'tests/control-plane-client-selftest.mjs',
  'tests/control-loop-selftest.mjs',
  'tests/control-center-settings-selftest.mjs',
  'tests/contracts-selftest.mjs',
  'tests/camera-adapter-selftest.mjs',
  'tests/assembly-selftest.mjs',
  'tests/uploader-selftest.mjs',
  'tests/sigma-sdk-settings-selftest.mjs',
  'cloudflare/tests/environment-separation-selftest.mjs',
  'cloudflare/tests/google-sheets-selftest.mjs',
  'cloudflare/tests/multi-project-load-selftest.mjs',
  'cloudflare/tests/worker-selftest.mjs'
)

Push-Location $repo
try {
  foreach ($test in $nodeTests) {
    Write-Host "[Companion regression] $test"
    & node $test
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $test" }
  }
  if ($IncludePackaging) {
    Write-Host '[Companion regression] tests/packaging-selftest.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'tests\packaging-selftest.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Regression failed: tests/packaging-selftest.ps1' }
  }
  Write-Host "PASS: $($nodeTests.Count) software tests$(if ($IncludePackaging) { ' plus packaging' } else { '' })."
  Write-Host 'Excluded by design: physical-camera acceptance, remote production acceptance, and long-duration soak.'
} finally {
  Pop-Location
}
