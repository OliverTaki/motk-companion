# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$dataPath = [System.IO.Path]::GetFullPath($DataDir)
$statePath = Join-Path $dataPath 'install-state.json'
if (-not $InstallDir -and (Test-Path -LiteralPath $statePath)) {
  $InstallDir = [string](Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json).installDir
}
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\MOTK Companion' }
& (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $InstallDir -DataDir $dataPath -NoShortcut:$NoShortcut
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
