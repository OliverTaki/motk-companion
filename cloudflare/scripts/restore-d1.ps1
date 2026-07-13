# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [Parameter(Mandatory = $true)][string]$SqlBackup,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SqlBackup -PathType Leaf)) { throw "backup file not found: $SqlBackup" }
if (-not $Apply) {
  Write-Output "DRY RUN: would restore $SqlBackup into $DatabaseName using $Config. Re-run with -Apply after owner approval."
  exit 0
}
npx wrangler d1 execute $DatabaseName --config $Config --file $SqlBackup
