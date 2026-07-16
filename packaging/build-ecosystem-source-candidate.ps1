param(
  [Parameter(Mandatory = $true)][string]$ShootRoot,
  [Parameter(Mandatory = $true)][string]$SiteRoot,
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'source-dist')
)

$ErrorActionPreference = 'Stop'
$companionRoot = Split-Path $PSScriptRoot -Parent
$outputRootPath = [IO.Path]::GetFullPath($OutputRoot)
$candidateRoot = Join-Path $outputRootPath 'motk-ecosystem-source-candidate'

function Assert-Directory([string]$path, [string]$label) {
  $resolved = [IO.Path]::GetFullPath($path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "$label directory not found" }
  return $resolved
}

function Remove-VerifiedCandidate([string]$path, [string]$parent) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $resolvedPath = [IO.Path]::GetFullPath($path)
  $resolvedParent = [IO.Path]::GetFullPath($parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'refusing to remove candidate outside output root' }
  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Copy-PublicFile([string]$root, [string]$relative, [string]$destinationRoot) {
  $source = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "required public file missing: $relative" }
  $destination = Join-Path $destinationRoot $relative
  $parent = Split-Path $destination -Parent
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $source -Destination $destination
}

function Copy-PublicTree([string]$root, [string]$relative, [string]$destinationRoot) {
  $sourceRoot = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "required public directory missing: $relative" }
  Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | ForEach-Object {
    $tail = $_.FullName.Substring($root.Length).TrimStart('\', '/')
    Copy-PublicFile $root $tail $destinationRoot
  }
}

$shootRootPath = Assert-Directory $ShootRoot 'Shoot'
$siteRootPath = Assert-Directory $SiteRoot 'site'
Remove-VerifiedCandidate $candidateRoot $outputRootPath
New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null

$companionDestination = Join-Path $candidateRoot 'motk-companion'
$companionFiles = @(
  'assembly.mjs', 'cap-camera-digicamcontrol.mjs', 'cap-camera-gphoto2.mjs', 'cap-camera-sigma.mjs',
  'cap-control.mjs', 'cap-editor-kdenlive.mjs', 'cap-encode.mjs', 'cap-media-cut.mjs', 'cap-playout.mjs', 'cap-runner.mjs',
  'cap-uploader.mjs', 'cap-watcher.mjs', 'companion.example.json', 'companion.mjs', 'README.md', 'LICENSE',
  'LICENSES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'PRIVACY.md', 'SECURITY.md', 'TRADEMARK.md', '.gitignore'
)
$companionFiles | ForEach-Object { Copy-PublicFile $companionRoot $_ $companionDestination }
@('bridge', 'gas', 'lib', 'presets', 'recipes', 'tests') | ForEach-Object { Copy-PublicTree $companionRoot $_ $companionDestination }
@('CLOUDFLARE_ENVIRONMENTS.md', 'INSTALL_WINDOWS.md', 'MEDIA_PROCESSING_CONTRACT.md', 'SUPPORTED_ENVIRONMENT.md') | ForEach-Object { Copy-PublicFile $companionRoot (Join-Path 'docs' $_) $companionDestination }
Copy-PublicTree $companionRoot 'docs\schema' $companionDestination
@('package.json', 'package-lock.json', 'wrangler.jsonc', 'wrangler.production.example.jsonc') | ForEach-Object { Copy-PublicFile $companionRoot (Join-Path 'cloudflare' $_) $companionDestination }
@('migrations', 'public', 'scripts', 'src', 'tests') | ForEach-Object { Copy-PublicTree $companionRoot (Join-Path 'cloudflare' $_) $companionDestination }
@('build-release.ps1', 'build-ecosystem-source-candidate.ps1', 'public-release-gate.ps1', 'pre-publish-identity-scrub-guard.ps1', 'runtime-lock.json', 'THIRD_PARTY_NOTICES.md') | ForEach-Object { Copy-PublicFile $companionRoot (Join-Path 'packaging' $_) $companionDestination }
Copy-PublicTree $companionRoot 'packaging\windows' $companionDestination

$shootDestination = Join-Path $candidateRoot 'motk-shoot'
@('index.html', 'monitor.html', 'manifest.json', 'sw.js', 'README.md', 'LICENSE', '.gitignore') | ForEach-Object { Copy-PublicFile $shootRootPath $_ $shootDestination }
@('bridge', 'css', 'docs', 'experiments', 'js', 'tests') | ForEach-Object { Copy-PublicTree $shootRootPath $_ $shootDestination }

$siteDestination = Join-Path $candidateRoot 'motk-public-site'
@('package.json', 'package-lock.json', 'README.md') | ForEach-Object { Copy-PublicFile $siteRootPath $_ $siteDestination }
@('favicon.svg', '_redirects') | ForEach-Object { Copy-PublicFile $siteRootPath (Join-Path 'public' $_) $siteDestination }
Copy-PublicTree $siteRootPath 'src' $siteDestination

$failures = [Collections.Generic.List[string]]::new()
$forbiddenPaths = @(
  '(?i)(^|[\\/])(?:\.env|\.dev\.vars|\.wrangler|node_modules|originals|tmp|dist|output)(?:[\\/]|$)',
  '(?i)CameraControlSDK',
  '(?i)\.(?:raw|dll|exe|lib|hpp|pem|pfx|p12|key|zip)$'
)
# Maintainer-private identity patterns (real names, personal usernames) are not
# hard-coded here so the public copy of this script never carries the very list
# it screens for. Provide them out-of-band via the MOTK_PRIVATE_PATTERNS
# environment variable (newline- or semicolon-separated regexes); when unset,
# only the generic path/secret patterns below run.
$privatePatterns = @()
if ($env:MOTK_PRIVATE_PATTERNS) {
  $privatePatterns = $env:MOTK_PRIVATE_PATTERNS -split "[`r`n;]" | Where-Object { $_.Trim() }
}
$textPatterns = @(
  '(?i)[A-Z]:\\Users\\',
  '(?i)[F-Z]:\\',
  '(?i)/(?:Users|home)/[^/]+/',
  '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'AIza[0-9A-Za-z_-]{30,}',
  '(?i)Bearer\s+[0-9A-Za-z._-]{32,}',
  '(?i)docs\.google\.com/spreadsheets/d/[0-9A-Za-z_-]{20,}'
) + $privatePatterns
$textExtensions = @('.md', '.txt', '.json', '.jsonc', '.mjs', '.js', '.ts', '.astro', '.html', '.css', '.ps1', '.gs', '.xml', '.yml', '.yaml', '.toml')
$allFiles = @(Get-ChildItem -LiteralPath $candidateRoot -Recurse -File)
foreach ($file in $allFiles) {
  $relative = $file.FullName.Substring($candidateRoot.Length).TrimStart('\', '/')
  foreach ($pattern in $forbiddenPaths) { if ($relative -match $pattern) { $failures.Add("forbidden path: $relative") } }
  if ($textExtensions -contains $file.Extension.ToLowerInvariant()) {
    $content = Get-Content -Raw -LiteralPath $file.FullName
    foreach ($pattern in $textPatterns) { if ($content -match $pattern) { $failures.Add("sensitive pattern in: $relative") } }
  }
}

if ($failures.Count) { throw "Ecosystem public-source gate failed: $($failures -join '; ')" }

& (Join-Path $PSScriptRoot 'pre-publish-identity-scrub-guard.ps1') -SourceRoot $candidateRoot -SkipGitHistory | Out-Host

$manifest = @($allFiles | Sort-Object FullName | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($candidateRoot.Length).TrimStart('\', '/').Replace('\', '/')
    bytes = $_.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  }
})
[ordered]@{ format = 1; candidate = 'motk-ecosystem-source-candidate'; files = $manifest } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $candidateRoot 'SOURCE_MANIFEST.json') -Encoding utf8

[ordered]@{
  ok = $true
  candidateRoot = $candidateRoot
  files = $manifest.Count
  bytes = ($allFiles | Measure-Object -Property Length -Sum).Sum
  scrubFindings = 0
} | ConvertTo-Json -Depth 4
