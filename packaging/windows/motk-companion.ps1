# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
$installRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Config) { $Config = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'companion.json' }
$node = Join-Path $installRoot 'runtime\node.exe'
$entry = Join-Path $installRoot 'app\companion.mjs'
if (-not (Test-Path -LiteralPath $node)) { throw 'Bundled Node.js runtime is missing' }
if (-not (Test-Path -LiteralPath $entry)) { throw 'MOTK Companion entry point is missing' }
if (-not (Test-Path -LiteralPath $Config)) { throw "Companion configuration is missing: $Config" }
& $node $entry --config ([System.IO.Path]::GetFullPath($Config))
exit $LASTEXITCODE
