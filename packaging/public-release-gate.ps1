# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseDir
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ReleaseDir).Path
$internal = Join-Path $root '_internal'
$failures = [System.Collections.Generic.List[string]]::new()
& (Join-Path $PSScriptRoot 'pre-publish-identity-scrub-guard.ps1') -SourceRoot $root -SkipGitHistory | Out-Host
$required = @(
  'INSTALL MOTK COMPANION.cmd', '_internal\RELEASE.json', '_internal\manifest.json',
  '_internal\legal\SBOM.spdx.json', '_internal\legal\LICENSE', '_internal\legal\LICENSES.md',
  '_internal\legal\SECURITY.md', '_internal\legal\PRIVACY.md', '_internal\legal\CONTRIBUTING.md',
  '_internal\legal\TRADEMARK.md', '_internal\legal\CHANGELOG.md', '_internal\legal\THIRD_PARTY_NOTICES.md',
  '_internal\runtime\node.exe', '_internal\runtime\LICENSE-node.txt', '_internal\app\companion.mjs',
  '_internal\install.ps1', '_internal\update.ps1', '_internal\uninstall.ps1',
  '_internal\scripts\control-center.ps1', '_internal\MOTK Companion.exe'
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { $failures.Add("missing required release file: $relative") }
}

$allFiles = Get-ChildItem -LiteralPath $root -File -Recurse
foreach ($file in $allFiles) {
  $relative = $file.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
  if ($relative -match '(^|/)(INTERACTION_LOGS|\.claude|\.codex|\.git|node_modules|\.venv)(/|$)') { $failures.Add("private/build path included: $relative") }
  if ($relative -match '(?i)(^|/)(\.env(?:\..*)?|credentials[^/]*|service-account[^/]*|pairing-token\.json|google-token\.json|jobs\.jsonl|companion\.json)$') { $failures.Add("secret or mutable state file included: $relative") }
  if ($file.Extension -notin @('.mjs', '.js', '.json', '.md', '.ps1', '.sql', '.gs', '.txt', '.cmd', '.yml', '.yaml', '.toml')) { continue }
  $text = Get-Content -Raw -LiteralPath $file.FullName -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  if ($text -match '(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') { $failures.Add("private key material found: $relative") }
  if ($text -match '(?i)[A-Z]:\\Users\\[^\\\s]+') { $failures.Add("machine-specific user path found: $relative") }
  if ($text -match '(?i)(?:^|[\\/])(?:\.claude|\.codex|INTERACTION_LOGS)(?:[\\/]|$)') { $failures.Add("private workspace reference found: $relative") }
  if ($text -match '(?i)"(?:client_secret|refresh_token|private_key)"\s*:\s*"(?!\s*(?:|PLACEHOLDER|REPLACE_ME)\s*")[^"]+"') { $failures.Add("credential-like JSON value found: $relative") }
  if ($text -match 'script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}' -and $text -notmatch 'script\.google\.com/macros/s/DEPLOYMENT_ID_PLACEHOLDER') { $failures.Add("live Apps Script deployment URL found: $relative") }
}

$manifestPath = Join-Path $internal 'manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  foreach ($entry in $manifest.files) {
    $path = Join-Path $internal ([string]$entry.path).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $failures.Add("manifest path is missing: $($entry.path)"); continue }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { $failures.Add("manifest checksum mismatch: $($entry.path)") }
  }
}

$nodePath = Join-Path $internal 'runtime\node.exe'
if (Test-Path -LiteralPath $nodePath) {
  $expected = 'v' + [string](Get-Content -Raw -LiteralPath (Join-Path $internal 'RELEASE.json') | ConvertFrom-Json).node.version
  $actual = & $nodePath --version
  if ($actual -ne $expected) { $failures.Add("bundled Node version is $actual, expected $expected") }
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  throw "Public release gate failed with $($failures.Count) finding(s)"
}
Write-Output "PASS public release candidate gate ($($allFiles.Count) files, zero findings)"
