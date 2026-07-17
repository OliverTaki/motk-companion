# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$Version = '0.4.0-beta.5',
  [string]$OutputRoot = '',
  [string]$RuntimeCache = '',
  [long]$SourceDateEpoch = 0,
  [switch]$SkipArchive,
  [switch]$PublicRelease
)

$ErrorActionPreference = 'Stop'
if (-not $OutputRoot) { $OutputRoot = Join-Path $PSScriptRoot 'dist' }
if (-not $RuntimeCache) { $RuntimeCache = Join-Path $PSScriptRoot '.cache' }
$componentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') | ConvertFrom-Json
if ($SourceDateEpoch -le 0) { $SourceDateEpoch = [long]$lock.sourceDateEpoch }
$buildTime = [DateTimeOffset]::FromUnixTimeSeconds($SourceDateEpoch)
$releaseName = "motk-companion-$Version-win-x64"
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$cachePath = [System.IO.Path]::GetFullPath($RuntimeCache)
$stage = Join-Path $outputRootPath ".$releaseName.build-$PID"
$releaseDir = Join-Path $outputRootPath $releaseName
$archive = "$releaseDir.zip"

function Remove-VerifiedTree([string]$Path, [string]$Parent) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove path outside $Parent" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Copy-RelativeFile([string]$RelativePath) {
  $source = Join-Path $componentRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release file is missing: $RelativePath" }
  $target = Join-Path (Join-Path $internal 'app') $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}

function Copy-RelativeDirectory([string]$RelativePath) {
  $source = Join-Path $componentRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Release directory is missing: $RelativePath" }
  $target = Join-Path (Join-Path $internal 'app') $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse
}

function Write-DeterministicZip([string]$Source, [string]$Destination, [DateTimeOffset]$Timestamp) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew)
  try {
    $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $files = Get-ChildItem -LiteralPath $Source -File -Recurse | Sort-Object { $_.FullName.Substring($Source.Length).Replace('\', '/') }
      foreach ($file in $files) {
        $relative = $file.FullName.Substring($Source.Length).TrimStart('\').Replace('\', '/')
        $entry = $zip.CreateEntry("$releaseName/$relative", [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $Timestamp
        $input = [System.IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $stream.Dispose() }
}

New-Item -ItemType Directory -Force -Path $outputRootPath,$cachePath | Out-Null
Remove-VerifiedTree $stage $outputRootPath
$internal = Join-Path $stage '_internal'
New-Item -ItemType Directory -Force -Path (Join-Path $internal 'app'),(Join-Path $internal 'runtime'),(Join-Path $internal 'scripts'),(Join-Path $internal 'legal') | Out-Null
$launcherPayload = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'windows\launcher.exe.base64')).Trim()
$launcherPath = Join-Path $internal 'MOTK Companion.exe'
[System.IO.File]::WriteAllBytes($launcherPath, [Convert]::FromBase64String($launcherPayload))
$launcherHash = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($launcherHash -ne 'f766f73df68fe24364dd65fda689eb3524ed9c5a67ee0f515fd90cb2d7ea69f2') { throw 'MOTK Companion launcher payload checksum mismatch.' }

$runtimeZip = Join-Path $cachePath ([System.IO.Path]::GetFileName([string]$lock.node.url))
if (-not (Test-Path -LiteralPath $runtimeZip)) { Invoke-WebRequest -UseBasicParsing -Uri $lock.node.url -OutFile $runtimeZip }
$runtimeHash = (Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($runtimeHash -ne ([string]$lock.node.sha256).ToLowerInvariant()) { throw "Node runtime checksum mismatch: $runtimeHash" }
$runtimeExtract = Join-Path $cachePath "node-v$($lock.node.version)-$($lock.node.platform)"
if (-not (Test-Path -LiteralPath (Join-Path $runtimeExtract 'node.exe'))) {
  $extractStage = "$runtimeExtract.extract-$PID"
  Remove-VerifiedTree $extractStage $cachePath
  Expand-Archive -LiteralPath $runtimeZip -DestinationPath $extractStage
  $inner = Get-ChildItem -LiteralPath $extractStage -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Node runtime archive has no root directory' }
  if (Test-Path -LiteralPath $runtimeExtract) { Remove-VerifiedTree $runtimeExtract $cachePath }
  Move-Item -LiteralPath $inner.FullName -Destination $runtimeExtract
  Remove-VerifiedTree $extractStage $cachePath
}
Copy-Item -LiteralPath (Join-Path $runtimeExtract 'node.exe') -Destination (Join-Path $internal 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $runtimeExtract 'LICENSE') -Destination (Join-Path $internal 'runtime\LICENSE-node.txt')
Copy-Item -LiteralPath (Join-Path $runtimeExtract 'README.md') -Destination (Join-Path $internal 'runtime\README-node.md')

$files = @(
  'assembly.mjs', 'cap-camera-digicamcontrol.mjs', 'cap-camera-gphoto2.mjs', 'cap-camera-sigma.mjs',
  'cap-control.mjs', 'cap-editor-kdenlive.mjs', 'cap-encode.mjs', 'cap-media-cut.mjs', 'cap-playout.mjs', 'cap-runner.mjs',
  'cap-uploader.mjs', 'cap-watcher.mjs', 'companion.example.json', 'companion.mjs', 'LICENSE', 'README.md'
)
$directories = @('bridge', 'lib', 'presets', 'recipes', 'docs\schema')
$files | ForEach-Object { Copy-RelativeFile $_ }
$directories | ForEach-Object { Copy-RelativeDirectory $_ }

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\install.ps1') -Destination (Join-Path $internal 'install.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\update.ps1') -Destination (Join-Path $internal 'update.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\uninstall.ps1') -Destination (Join-Path $internal 'uninstall.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\motk-companion.ps1') -Destination (Join-Path $internal 'scripts\motk-companion.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\diagnose.ps1') -Destination (Join-Path $internal 'scripts\diagnose.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\control-center.ps1') -Destination (Join-Path $internal 'scripts\control-center.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\copy-pairing-key.ps1') -Destination (Join-Path $internal 'scripts\copy-pairing-key.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\open-production-folder.ps1') -Destination (Join-Path $internal 'scripts\open-production-folder.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\stop-companion.ps1') -Destination (Join-Path $internal 'scripts\stop-companion.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\INSTALL MOTK COMPANION.cmd') -Destination (Join-Path $stage 'INSTALL MOTK COMPANION.cmd')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $internal 'legal\THIRD_PARTY_NOTICES.md')
$releaseDocuments = @('LICENSE', 'LICENSES.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'TRADEMARK.md', 'CHANGELOG.md')
foreach ($document in $releaseDocuments) { Copy-Item -LiteralPath (Join-Path $componentRoot $document) -Destination (Join-Path $internal "legal\$document") }
New-Item -ItemType Directory -Force -Path (Join-Path $internal 'docs') | Out-Null
Copy-Item -LiteralPath (Join-Path $componentRoot 'docs\INSTALL_WINDOWS.md') -Destination (Join-Path $internal 'docs\INSTALL_WINDOWS.md')
Copy-Item -LiteralPath (Join-Path $componentRoot 'docs\SUPPORTED_ENVIRONMENT.md') -Destination (Join-Path $internal 'docs\SUPPORTED_ENVIRONMENT.md')
Copy-Item -LiteralPath (Join-Path $componentRoot 'docs\MEDIA_PROCESSING_CONTRACT.md') -Destination (Join-Path $internal 'docs\MEDIA_PROCESSING_CONTRACT.md')

$releaseMetadata = [ordered]@{
  name = 'MOTK Companion'
  version = $Version
  platform = 'win-x64'
  sourceDateEpoch = $SourceDateEpoch
  node = [ordered]@{ version = [string]$lock.node.version; archiveSha256 = $runtimeHash; url = [string]$lock.node.url }
  publicRelease = [bool]$PublicRelease
  channel = if ($Version -match '(?i)beta') { 'beta' } else { 'stable' }
}
$releaseMetadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $internal 'RELEASE.json') -Encoding utf8

$sbom = [ordered]@{
  spdxVersion = 'SPDX-2.3'
  dataLicense = 'CC0-1.0'
  SPDXID = 'SPDXRef-DOCUMENT'
  name = "$releaseName-sbom"
  documentNamespace = "https://motk.invalid/spdx/$releaseName"
  creationInfo = [ordered]@{ created = $buildTime.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ'); creators = @('Tool: MOTK-Companion-build-release') }
  packages = @(
    [ordered]@{ name = 'MOTK Companion'; SPDXID = 'SPDXRef-Package-MOTK-Companion'; versionInfo = $Version; downloadLocation = 'NOASSERTION'; filesAnalyzed = $true; licenseConcluded = 'GPL-3.0-or-later'; licenseDeclared = 'GPL-3.0-or-later'; copyrightText = 'NOASSERTION' },
    [ordered]@{ name = 'Node.js'; SPDXID = 'SPDXRef-Package-Nodejs'; versionInfo = [string]$lock.node.version; downloadLocation = [string]$lock.node.url; filesAnalyzed = $false; licenseConcluded = 'NOASSERTION'; licenseDeclared = 'MIT'; copyrightText = 'Copyright Node.js contributors' }
  )
}
$sbom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $internal 'legal\SBOM.spdx.json') -Encoding utf8

Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object { $_.LastWriteTimeUtc = $buildTime.UtcDateTime }
$manifestFiles = Get-ChildItem -LiteralPath $internal -File -Recurse | Sort-Object { $_.FullName.Substring($internal.Length).Replace('\', '/') } | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($internal.Length).TrimStart('\').Replace('\', '/')
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
[ordered]@{ format = 1; release = $releaseName; files = @($manifestFiles) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $internal 'manifest.json') -Encoding utf8
(Get-Item -LiteralPath (Join-Path $internal 'manifest.json')).LastWriteTimeUtc = $buildTime.UtcDateTime
& (Join-Path $PSScriptRoot 'public-release-gate.ps1') -ReleaseDir $stage | Out-Null

Remove-VerifiedTree $releaseDir $outputRootPath
Move-Item -LiteralPath $stage -Destination $releaseDir
if (-not $SkipArchive) { Write-DeterministicZip $releaseDir $archive $buildTime }

$result = [ordered]@{
  releaseDirectory = $releaseDir
  archive = if ($SkipArchive) { $null } else { $archive }
  archiveSha256 = if ($SkipArchive) { $null } else { (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() }
  manifestFiles = $manifestFiles.Count
  nodeVersion = [string]$lock.node.version
}
$result | ConvertTo-Json -Depth 4
