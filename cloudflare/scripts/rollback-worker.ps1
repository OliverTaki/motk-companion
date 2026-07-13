# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$VersionId,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $Apply) {
  Write-Output "DRY RUN: would roll Worker configured by $Config back to version $VersionId. Re-run with -Apply after owner approval."
  exit 0
}
npx wrangler rollback --config $Config --version-id $VersionId
