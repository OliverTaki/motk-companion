# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [string]$ExpectedName = 'OliverTaki',
  [string]$ExpectedEmail = '107835438+OliverTaki@users.noreply.github.com',
  [switch]$SkipGitHistory
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SourceRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "source root not found: $SourceRoot" }
$failures = [Collections.Generic.List[string]]::new()

if (-not $SkipGitHistory -and (Test-Path -LiteralPath (Join-Path $root '.git'))) {
  $commitLines = & git -C $root log --format='%H%x09%an%x09%ae%x09%cn%x09%ce'
  foreach ($line in $commitLines) {
    $parts = $line -split "`t"
    if ($parts.Count -lt 5) { continue }
    if ($parts[1] -ne $ExpectedName -or $parts[2] -ne $ExpectedEmail) { $failures.Add("commit author identity mismatch: $($parts[0])") }
    if ($parts[3] -ne $ExpectedName -or $parts[4] -ne $ExpectedEmail) { $failures.Add("commit committer identity mismatch: $($parts[0])") }
  }
  $tagLines = & git -C $root for-each-ref refs/tags --format='%(refname:short)%09%(taggername)%09%(taggeremail)'
  foreach ($line in $tagLines) {
    $parts = $line -split "`t"
    if ($parts.Count -lt 3 -or -not $parts[1]) { continue }
    $email = $parts[2].Trim('<', '>')
    if ($parts[1] -ne $ExpectedName -or $email -ne $ExpectedEmail) { $failures.Add("tagger identity mismatch: $($parts[0])") }
  }
}

$privatePatterns = @()
if ($env:MOTK_PRIVATE_PATTERNS) {
  $privatePatterns = $env:MOTK_PRIVATE_PATTERNS -split "[`r`n;]" | Where-Object { $_.Trim() }
}
$closedSourceMarker = -join ([char[]](77, 101, 103, 97, 80, 114, 111, 100))
$patterns = @(
  [regex]::Escape($closedSourceMarker),
  '(?i)[A-Z]:\\Users\\',
  '(?i)/(?:Users|home)/[^/]+/',
  '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'AIza[0-9A-Za-z_-]{30,}',
  '(?i)Bearer\s+[0-9A-Za-z._-]{32,}',
  '(?i)"(?:client_secret|refresh_token|private_key)"\s*:\s*"(?!\s*(?:|PLACEHOLDER|REPLACE_ME)\s*")[^"]+"'
) + $privatePatterns

$textExtensions = @('.md', '.txt', '.json', '.jsonc', '.mjs', '.js', '.ts', '.astro', '.html', '.css', '.ps1', '.cmd', '.gs', '.xml', '.yml', '.yaml', '.toml', '.sql')
$allFiles = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
  $candidate = $_.FullName.Substring($root.Length).TrimStart('\', '/')
  $candidate -notmatch '(?i)(?:^|[\\/])(?:\.git|node_modules|\.wrangler|\.cache|dist|tmp)(?:[\\/]|$)'
}
foreach ($file in $allFiles) {
  if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
  $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
  $text = Get-Content -Raw -LiteralPath $file.FullName -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  foreach ($pattern in $patterns) {
    if ($pattern -and $text -match $pattern) { $failures.Add("forbidden content pattern in: $relative") }
  }
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  throw "Pre-publish identity/scrub guard failed with $($failures.Count) finding(s)"
}
Write-Output "PASS pre-publish identity/scrub guard ($($allFiles.Count) scanned files)"
