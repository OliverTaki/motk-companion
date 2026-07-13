# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion')
)

$ErrorActionPreference = 'Stop'
$installRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = Join-Path $installRoot 'runtime\node.exe'
$config = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'companion.json'
$release = Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json
$checks = @()
$checks += [ordered]@{ name = 'release'; ok = $true; detail = [string]$release.version }
$checks += [ordered]@{ name = 'node'; ok = (Test-Path -LiteralPath $node); detail = if (Test-Path -LiteralPath $node) { (& $node --version) } else { 'missing' } }
$checks += [ordered]@{ name = 'config'; ok = (Test-Path -LiteralPath $config); detail = $config }
$statusHost = '127.0.0.1'
$statusPort = 8794
if (Test-Path -LiteralPath $config) {
  $settings = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
  if ($settings.host) { $statusHost = [string]$settings.host }
  if ($settings.statusPort) { $statusPort = [int]$settings.statusPort }
}
$statusUrl = "http://${statusHost}:$statusPort/status"
try {
  $response = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 $statusUrl
  $checks += [ordered]@{ name = 'status'; ok = [bool]$response.ok; detail = $statusUrl }
} catch {
  $checks += [ordered]@{ name = 'status'; ok = $false; detail = 'not running or status port unavailable' }
}
[ordered]@{ ok = -not ($checks | Where-Object { -not $_.ok -and $_.name -ne 'status' }); checks = $checks } | ConvertTo-Json -Depth 6
