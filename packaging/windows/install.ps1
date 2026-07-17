# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MOTK Companion'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [switch]$NoShortcut,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path $PSScriptRoot).Path
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$dataPath = [System.IO.Path]::GetFullPath($DataDir)
$release = Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'RELEASE.json') | ConvertFrom-Json

function Assert-SafeTreePath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  if (-not $full -or $full -eq $root -or $full.Length -lt ($root.Length + 4)) { throw "Unsafe recursive path: $full" }
  return $full
}

function Remove-SafeTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $safe = Assert-SafeTreePath $Path
  Remove-Item -LiteralPath $safe -Recurse -Force
}

function Test-PackageManifest {
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'manifest.json') | ConvertFrom-Json
  foreach ($file in $manifest.files) {
    $path = Join-Path $packageRoot ([string]$file.path).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Package file is missing: $($file.path)" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$file.sha256).ToLowerInvariant()) { throw "Package checksum mismatch: $($file.path)" }
  }
}

Test-PackageManifest
Assert-SafeTreePath $installPath | Out-Null
Assert-SafeTreePath $dataPath | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $installPath -Parent),$dataPath | Out-Null

$stage = "$installPath.stage-$PID"
Remove-SafeTree $stage
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$stageInternal = Join-Path $stage '_internal'
New-Item -ItemType Directory -Force -Path $stageInternal | Out-Null
Get-ChildItem -LiteralPath $packageRoot -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stageInternal -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $packageRoot 'MOTK Companion.exe') -Destination (Join-Path $stage 'MOTK Companion.exe')

$backup = $null
$backupArchive = $null
$previous = "$installPath.previous-$PID"
$stopScript = Join-Path $packageRoot 'scripts\stop-companion.ps1'
$stopResult = [ordered]@{ wasRunning = $false }
if (Test-Path -LiteralPath $installPath) {
  if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) { throw 'The package is missing its safe Companion stop helper.' }
  $stopResult = (& $stopScript -InstallDir $installPath | Out-String) | ConvertFrom-Json
}
Remove-SafeTree $previous
try {
  if (Test-Path -LiteralPath $installPath) {
    $backupRoot = Join-Path $dataPath 'updates'
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $completeExisting = ((Test-Path -LiteralPath (Join-Path $installPath '_internal\RELEASE.json') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $installPath '_internal\runtime\node.exe') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $installPath '_internal\app\companion.mjs') -PathType Leaf)) -or
      ((Test-Path -LiteralPath (Join-Path $installPath 'RELEASE.json') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $installPath 'runtime\node.exe') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $installPath 'app\companion.mjs') -PathType Leaf))
    $backupArchive = Join-Path $backupRoot "$(if ($completeExisting) { 'install' } else { 'partial-recovery' })-$stamp"
    Copy-Item -LiteralPath $installPath -Destination $backupArchive -Recurse -Force
    if ($completeExisting) { $backup = $backupArchive }
    Rename-Item -LiteralPath $installPath -NewName (Split-Path $previous -Leaf)
  }
  Rename-Item -LiteralPath $stage -NewName (Split-Path $installPath -Leaf)
} catch {
  Remove-SafeTree $stage
  if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $installPath)) { Rename-Item -LiteralPath $previous -NewName (Split-Path $installPath -Leaf) }
  throw
}
Remove-SafeTree $previous

$configPath = Join-Path $dataPath 'companion.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  $config = [ordered]@{
    host = '127.0.0.1'
    allowOrigin = 'https://motk-public-site.pages.dev'
    busPort = 8793
    statusPort = 8794
    productionRoot = (Join-Path $dataPath 'production')
    captureInbox = (Join-Path $dataPath 'production\Camera Originals')
    tokenStore = (Join-Path $dataPath 'config\pairing-token.json')
    jobStore = (Join-Path $dataPath 'state\jobs.jsonl')
    logsDir = (Join-Path $dataPath 'logs')
    ffmpeg = 'ffmpeg'
    ffprobe = 'ffprobe'
    recipesDir = (Join-Path $installPath '_internal\app\recipes')
    cliCommands = [ordered]@{}
    cameraBackend = 'dummy'
    sigmaSdkZip = ''
    sigmaSerial = ''
    digicamCommand = 'C:\Program Files (x86)\digiCamControl\CameraControlCmd.exe'
    projectId = ''
    runtimeId = ''
    capabilities = [ordered]@{ bridge = $true; control = $true }
    uploadTargets = [ordered]@{}
    motkEndpoint = ''
    motkToken = ''
    controlPlaneEndpoint = ''
    controlPlaneToken = ''
    controlPlanePollMs = 2000
  }
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
}

# Updating the former flat beta layout changes only this installed-code pointer.
$installedConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$expectedRecipes = Join-Path $installPath '_internal\app\recipes'
$configChanged = $false
if ([string]$installedConfig.recipesDir -ne $expectedRecipes) {
  $installedConfig.recipesDir = $expectedRecipes
  $configChanged = $true
}
$legacyCapture = [System.IO.Path]::GetFullPath([string]$installedConfig.captureInbox).TrimEnd('\')
if ([System.IO.Path]::GetFileName($legacyCapture) -eq '.companion-capture') {
  $visibleCapture = Join-Path ([System.IO.Path]::GetFullPath([string]$installedConfig.productionRoot).TrimEnd('\')) 'Camera Originals'
  if (Test-Path -LiteralPath $legacyCapture -PathType Container) {
    if (Test-Path -LiteralPath $visibleCapture) {
      $visibleCapture = Join-Path ([System.IO.Path]::GetDirectoryName($visibleCapture)) "Camera Originals (migrated $([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')))"
    }
    Move-Item -LiteralPath $legacyCapture -Destination $visibleCapture
  } else {
    New-Item -ItemType Directory -Force -Path $visibleCapture | Out-Null
  }
  $installedConfig.captureInbox = $visibleCapture
  $configChanged = $true
}
if ($configChanged) {
  $installedConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
}

$state = [ordered]@{ version = [string]$release.version; installDir = $installPath; dataDir = $dataPath; installedAt = [DateTimeOffset]::UtcNow.ToString('o'); previousInstall = $backup }
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $dataPath 'install-state.json') -Encoding utf8

if (-not $NoShortcut) {
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MOTK'
  New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  foreach ($oldName in @('MOTK Companion - Setup.lnk', 'MOTK Companion - Copy Pairing Key.lnk', 'MOTK Companion - Open Local Media.lnk')) {
    $oldShortcut = Join-Path $startMenu $oldName
    if (Test-Path -LiteralPath $oldShortcut) { Remove-Item -LiteralPath $oldShortcut -Force }
  }
  $shortcut = $shell.CreateShortcut((Join-Path $startMenu 'MOTK Companion.lnk'))
  $shortcut.TargetPath = Join-Path $installPath 'MOTK Companion.exe'
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $installPath
  $shortcut.Save()

  # Register the motk-companion:// URL scheme so web pages (MOTK site, Shoot)
  # can start the Control Center with one click. Per-user, no admin required.
  $exePath = Join-Path $installPath 'MOTK Companion.exe'
  $protoRoot = 'HKCU:\Software\Classes\motk-companion'
  New-Item -Path $protoRoot -Force | Out-Null
  Set-ItemProperty -Path $protoRoot -Name '(Default)' -Value 'URL:MOTK Companion'
  Set-ItemProperty -Path $protoRoot -Name 'URL Protocol' -Value ''
  New-Item -Path (Join-Path $protoRoot 'shell\open\command') -Force | Out-Null
  Set-ItemProperty -Path (Join-Path $protoRoot 'shell\open\command') -Name '(Default)' -Value ('"' + $exePath + '" "%1"')
}

$oldBackups = Get-ChildItem -LiteralPath (Join-Path $dataPath 'updates') -Directory -Filter 'install-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 2
foreach ($old in $oldBackups) { Remove-SafeTree $old.FullName }
$oldPartialBackups = Get-ChildItem -LiteralPath (Join-Path $dataPath 'updates') -Directory -Filter 'partial-recovery-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 1
foreach ($old in $oldPartialBackups) { Remove-SafeTree $old.FullName }

if ($stopResult.wasRunning -and -not $NoRestart) {
  $launcher = Join-Path $installPath '_internal\scripts\motk-companion.ps1'
  Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -DataDir `"$dataPath`"" -WorkingDirectory $installPath -WindowStyle Hidden
}

[ordered]@{ ok = $true; version = [string]$release.version; installDir = $installPath; dataDir = $dataPath; previousInstall = $backup; restarted = [bool]($stopResult.wasRunning -and -not $NoRestart) } | ConvertTo-Json -Depth 4
