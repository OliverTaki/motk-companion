# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [switch]$RemoveData,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$dataPath = [System.IO.Path]::GetFullPath($DataDir)
$statePath = Join-Path $dataPath 'install-state.json'
if (-not $InstallDir -and (Test-Path -LiteralPath $statePath)) { $InstallDir = [string](Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json).installDir }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\MOTK Companion' }
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$stopScript = Join-Path $installPath 'scripts\stop-companion.ps1'

function Remove-SafeTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  if (-not $full -or $full -eq $root -or $full.Length -lt ($root.Length + 4)) { throw "Unsafe recursive path: $full" }
  Remove-Item -LiteralPath $full -Recurse -Force
}

if (-not $NoShortcut) {
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MOTK'
  foreach ($name in @('MOTK Companion.lnk', 'MOTK Companion - Setup.lnk', 'MOTK Companion - Copy Pairing Key.lnk', 'MOTK Companion - Open Local Media.lnk')) {
    $shortcut = Join-Path $startMenu $name
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
  }
}

if (Test-Path -LiteralPath $stopScript -PathType Leaf) { & $stopScript -InstallDir $installPath | Out-Null }
Remove-SafeTree $installPath
if ($RemoveData) { Remove-SafeTree $dataPath }
else {
  [ordered]@{ uninstalledAt = [DateTimeOffset]::UtcNow.ToString('o'); retainedData = $dataPath; priorInstall = $installPath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataPath 'uninstall-state.json') -Encoding utf8
}
[ordered]@{ ok = $true; removedInstall = $installPath; dataRemoved = [bool]$RemoveData; retainedData = if ($RemoveData) { $null } else { $dataPath } } | ConvertTo-Json
