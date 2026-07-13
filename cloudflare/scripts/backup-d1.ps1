# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\backups')
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [IO.Path]::GetFullPath($OutputDir)
if (-not (Test-Path -LiteralPath $resolvedOutput)) { New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null }
$stamp = Get-Date -Format 'yyyyMMddTHHmmssZ'
$out = Join-Path $resolvedOutput "$DatabaseName-$stamp.sql"
npx wrangler d1 export $DatabaseName --config $Config --output $out
Write-Output $out
