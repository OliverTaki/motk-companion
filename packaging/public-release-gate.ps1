# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseDir
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ReleaseDir).Path
$failures = [System.Collections.Generic.List[string]]::new()
$required = @(
  'RELEASE.json', 'SBOM.spdx.json', 'manifest.json', 'LICENSE', 'LICENSES.md', 'SECURITY.md',
  'PRIVACY.md', 'CONTRIBUTING.md', 'TRADEMARK.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'runtime\node.exe', 'runtime\LICENSE-node.txt', 'app\companion.mjs', 'install.ps1', 'update.ps1', 'uninstall.ps1'
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

$manifestPath = Join-Path $root 'manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  foreach ($entry in $manifest.files) {
    $path = Join-Path $root ([string]$entry.path).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $failures.Add("manifest path is missing: $($entry.path)"); continue }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { $failures.Add("manifest checksum mismatch: $($entry.path)") }
  }
}

$nodePath = Join-Path $root 'runtime\node.exe'
if (Test-Path -LiteralPath $nodePath) {
  $expected = 'v' + [string](Get-Content -Raw -LiteralPath (Join-Path $root 'RELEASE.json') | ConvertFrom-Json).node.version
  $actual = & $nodePath --version
  if ($actual -ne $expected) { $failures.Add("bundled Node version is $actual, expected $expected") }
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  throw "Public release gate failed with $($failures.Count) finding(s)"
}
Write-Output "PASS public release candidate gate ($($allFiles.Count) files, zero findings)"
