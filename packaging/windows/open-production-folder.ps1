# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'))

$ErrorActionPreference = 'Stop'
$configPath = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'companion.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Companion configuration is missing: $configPath" }
$settings = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$root = [System.IO.Path]::GetFullPath([string]$settings.productionRoot)
New-Item -ItemType Directory -Force -Path $root | Out-Null
Start-Process explorer.exe -ArgumentList "`"$root`""

