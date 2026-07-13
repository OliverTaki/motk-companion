# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CandidateZip)

$ErrorActionPreference = 'Stop'
$candidatePath = (Resolve-Path -LiteralPath $CandidateZip).Path
$root = Join-Path ([IO.Path]::GetTempPath()) "motk-smdb-candidate-$([guid]::NewGuid().ToString('N'))"
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-True([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Remove-AcceptanceTree([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $full = [IO.Path]::GetFullPath($path)
  $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $full -Leaf).StartsWith('motk-smdb-candidate-')) { throw 'refusing cleanup outside SMDB acceptance root' }
  Remove-Item -LiteralPath $full -Recurse -Force
}
function Free-Port {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start(); try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  $expanded = Join-Path $root 'expanded'
  Expand-Archive -LiteralPath $candidatePath -DestinationPath $expanded
  $packageRoot = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1 -ExpandProperty FullName
  Assert-True ([bool]$packageRoot) 'candidate ZIP has no package directory'
  foreach ($relative in @('manifest.json', 'RELEASE.json', 'docs\INSTALL_WINDOWS.md', 'docs\SUPPORTED_ENVIRONMENT.md', 'install.ps1', 'uninstall.ps1')) { Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot $relative) -PathType Leaf) "public candidate is missing $relative" }

  $install = Join-Path $root 'installed\MOTK Companion'
  $data = Join-Path $root 'data\Companion'
  & (Join-Path $packageRoot 'install.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  $configPath = Join-Path $data 'companion.json'
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $config.statusPort = Free-Port
  do { $config.busPort = Free-Port } until ($config.busPort -ne $config.statusPort)
  $config.capabilities.bridge = $false
  $config.capabilities.control = $false
  $config | Add-Member -NotePropertyName smdbAcceptanceMarker -NotePropertyValue 'preserve-on-reinstall' -Force
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8

  $process = Start-Process -FilePath (Join-Path $install 'runtime\node.exe') -ArgumentList @("`"$(Join-Path $install 'app\companion.mjs')`"", '--config', "`"$configPath`"") -WindowStyle Hidden -PassThru
  try {
    $status = $null
    for ($attempt = 0; $attempt -lt 50 -and -not $status; $attempt++) { try { $status = Invoke-RestMethod -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$($config.statusPort)/status" } catch { Start-Sleep -Milliseconds 100 } }
    Assert-True ([bool]$status.ok) 'installed candidate did not report healthy status'
    $diagnostic = (& (Join-Path $install 'scripts\diagnose.ps1') -DataDir $data | Out-String) | ConvertFrom-Json
    Assert-True ([bool]$diagnostic.ok) 'installed candidate diagnostics failed'
  } finally { if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force } }

  $env:MOTK_ACCEPTANCE_APP_ROOT = Join-Path $install 'app'
  try {
    $pipeline = (& (Join-Path $install 'runtime\node.exe') (Join-Path $PSScriptRoot 'smdb-public-candidate-acceptance.mjs') | Out-String) | ConvertFrom-Json
    Assert-True ([bool]$pipeline.ok) 'installed public pipeline acceptance failed'
  } finally { [Environment]::SetEnvironmentVariable('MOTK_ACCEPTANCE_APP_ROOT', $null, 'Process') }

  $installedReadme = Join-Path $install 'app\README.md'
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot 'app\README.md')).Hash
  [IO.File]::AppendAllText($installedReadme, "`nDISPOSABLE CORRUPTION PROBE`n")
  Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedReadme).Hash -ne $expectedHash) 'corruption probe did not change the installed file'
  & (Join-Path $packageRoot 'install.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedReadme).Hash -eq $expectedHash) 'reinstall did not recover the installed application'
  $reloadedConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  Assert-True ($reloadedConfig.smdbAcceptanceMarker -eq 'preserve-on-reinstall') 'reinstall changed retained operator data'
  $installState = Get-Content -Raw -LiteralPath (Join-Path $data 'install-state.json') | ConvertFrom-Json
  Assert-True (Test-Path -LiteralPath $installState.previousInstall -PathType Container) 'reinstall did not retain rollback state'

  & (Join-Path $install 'uninstall.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $install)) 'default uninstall retained application files'
  Assert-True (Test-Path -LiteralPath $configPath) 'default uninstall removed operator data'
  & (Join-Path $packageRoot 'install.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  & (Join-Path $install 'uninstall.ps1') -InstallDir $install -DataDir $data -RemoveData -NoShortcut | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $data)) 'explicit cleanup retained operator data'

  [ordered]@{ ok = $true; candidateSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidatePath).Hash.ToLowerInvariant(); diagnostics = $true; frames = $pipeline.frames; versionRegistrations = $pipeline.registrations; assemblySegments = $pipeline.assemblySegments; safeBoundaryActivation = $pipeline.safeBoundaryActivation; reinstallRecovery = $true; rollbackRetained = $true; defaultUninstallRetainedData = $true; explicitCleanup = $true } | ConvertTo-Json -Depth 4
} finally { Remove-AcceptanceTree $root }
