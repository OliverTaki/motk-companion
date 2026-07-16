# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MOTK Companion'))

$ErrorActionPreference = 'Stop'
$installPath = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$runtimePaths = @(
  [System.IO.Path]::GetFullPath((Join-Path $installPath '_internal\runtime\node.exe')),
  [System.IO.Path]::GetFullPath((Join-Path $installPath 'runtime\node.exe'))
)
$launcherPaths = @(
  [System.IO.Path]::GetFullPath((Join-Path $installPath '_internal\scripts\motk-companion.ps1')),
  [System.IO.Path]::GetFullPath((Join-Path $installPath 'scripts\motk-companion.ps1')),
  [System.IO.Path]::GetFullPath((Join-Path $installPath '_internal\scripts\control-center.ps1')),
  [System.IO.Path]::GetFullPath((Join-Path $installPath 'scripts\control-center.ps1'))
)
$controlCenterPath = [System.IO.Path]::GetFullPath((Join-Path $installPath 'MOTK Companion.exe'))

function Get-OwnedProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $executable = if ($_.ExecutablePath) { [System.IO.Path]::GetFullPath([string]$_.ExecutablePath) } else { '' }
    $commandLine = [string]$_.CommandLine
    $executable.Equals($controlCenterPath, [StringComparison]::OrdinalIgnoreCase) -or
      @($runtimePaths | Where-Object { $executable.Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 -or
      ($_.Name -ieq 'powershell.exe' -and @($launcherPaths | Where-Object { $commandLine.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0)
  })
}

$owned = @(Get-OwnedProcesses)
if ($owned.Count) {
  Write-Host 'MOTK Companion is running. Stopping it safely for this operation...'
  $nodeProcesses = @($owned | Where-Object Name -ieq 'node.exe' | Sort-Object ProcessId -Descending)
  foreach ($process in $nodeProcesses) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
  $controlCenters = @($owned | Where-Object Name -ieq 'MOTK Companion.exe')
  foreach ($process in $controlCenters) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
  $wrappers = @($owned | Where-Object Name -ieq 'powershell.exe')
  foreach ($process in $wrappers) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
  for ($attempt = 0; $attempt -lt 50 -and @(Get-OwnedProcesses).Count; $attempt++) { Start-Sleep -Milliseconds 100 }
}

$remaining = @(Get-OwnedProcesses)
if ($remaining.Count) { throw 'MOTK Companion could not be stopped. Close its window and try again.' }
[ordered]@{ ok = $true; wasRunning = [bool]$owned.Count; stopped = $owned.Count } | ConvertTo-Json
