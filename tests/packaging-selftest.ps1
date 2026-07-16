# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$componentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$builder = Join-Path $componentRoot 'packaging\build-release.ps1'
$root = Join-Path ([System.IO.Path]::GetTempPath()) "motk-packaging-selftest-$([guid]::NewGuid().ToString('N'))"
$cache = Join-Path $componentRoot 'packaging\.cache'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-Build([string]$Version, [string]$Output, [switch]$SkipArchive) {
  $text = if ($SkipArchive) {
    & $builder -Version $Version -OutputRoot $Output -RuntimeCache $cache -SkipArchive | Out-String
  } else {
    & $builder -Version $Version -OutputRoot $Output -RuntimeCache $cache | Out-String
  }
  return $text | ConvertFrom-Json
}

function Remove-SelfTestTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path)
  $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $full -Leaf).StartsWith('motk-packaging-selftest-')) { throw "Refusing cleanup outside self-test root: $full" }
  Remove-Item -LiteralPath $full -Recurse -Force
}

function Test-FreeTcpPort([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  $first = Invoke-Build '0.3.0-test.1' (Join-Path $root 'dist-a')
  $second = Invoke-Build '0.3.0-test.1' (Join-Path $root 'dist-b')
  Assert-True ($first.archiveSha256 -eq $second.archiveSha256) 'identical release inputs did not produce identical ZIP hashes'
  Assert-True ($first.manifestFiles -gt 20) 'release manifest is unexpectedly small'

  $install = Join-Path $root 'installed\MOTK Companion'
  $data = Join-Path $root 'data\Companion'
  & (Join-Path $first.releaseDirectory '_internal\install.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  Assert-True (Test-Path -LiteralPath (Join-Path $install '_internal\runtime\node.exe')) 'bundled Node runtime was not installed'
  Assert-True ((& (Join-Path $install '_internal\runtime\node.exe') --version) -eq 'v24.18.0') 'installed Node version differs from the runtime lock'
  $frontItems = @(Get-ChildItem -LiteralPath $install -Force | Select-Object -ExpandProperty Name | Sort-Object)
  Assert-True (($frontItems -join '|') -eq '_internal|MOTK Companion.exe') 'installed front contains items users should not need to touch'
  foreach ($friendlyFile in @('MOTK Companion.exe', '_internal\scripts\control-center.ps1', '_internal\scripts\stop-companion.ps1')) {
    Assert-True (Test-Path -LiteralPath (Join-Path $install $friendlyFile) -PathType Leaf) "friendly Windows entry is missing: $friendlyFile"
  }

  $configPath = Join-Path $data 'companion.json'
  $friendlyMedia = Join-Path $root 'friendly-media'
  $configured = (& (Join-Path $install '_internal\scripts\control-center.ps1') -DataDir $data -InstallDir $install -ProductionRoot $friendlyMedia -CameraBackend dummy -Headless -NoStart | Out-String) | ConvertFrom-Json
  Assert-True ([bool]$configured.ok) 'headless setup did not complete'
  Assert-True ($configured.productionRoot -eq [System.IO.Path]::GetFullPath($friendlyMedia)) 'setup did not save the selected local media folder'
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  Assert-True ($config.allowOrigin -eq 'https://motk-public-site.pages.dev') 'setup did not trust the official MOTK public site origin'
  $config | Add-Member -NotePropertyName selfTestMarker -NotePropertyValue 'keep-config' -Force
  do { $statusPort = Get-Random -Minimum 21000 -Maximum 45000; $busPort = $statusPort + 1 } until ((Test-FreeTcpPort $statusPort) -and (Test-FreeTcpPort $busPort))
  $config.statusPort = $statusPort
  $config.busPort = $busPort
  $config.capabilities.bridge = $false
  $config.capabilities.control = $false
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
  New-Item -ItemType Directory -Force -Path (Join-Path $data 'config'),(Join-Path $data 'state') | Out-Null
  Set-Content -LiteralPath (Join-Path $data 'state\jobs.jsonl') -Value '{"sentinel":"keep-job"}' -Encoding utf8
  $entryPoint = Join-Path $install '_internal\app\companion.mjs'
  $smokeStdout = Join-Path $root 'installed-smoke.stdout.txt'
  $smokeStderr = Join-Path $root 'installed-smoke.stderr.txt'
  $process = Start-Process -FilePath (Join-Path $install '_internal\runtime\node.exe') -ArgumentList @("`"$entryPoint`"", '--config', "`"$configPath`"") -WindowStyle Hidden -RedirectStandardOutput $smokeStdout -RedirectStandardError $smokeStderr -PassThru
  try {
    $status = $null
    for ($attempt = 0; $attempt -lt 50 -and -not $status; $attempt++) {
      try { $status = Invoke-RestMethod -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$statusPort/status" } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $status) {
      $stderrText = if (Test-Path -LiteralPath $smokeStderr) { Get-Content -Raw -LiteralPath $smokeStderr } else { '' }
      $stdoutText = if (Test-Path -LiteralPath $smokeStdout) { Get-Content -Raw -LiteralPath $smokeStdout } else { '' }
      throw "installed Companion did not start with the bundled runtime; stdout=$stdoutText stderr=$stderrText"
    }
    Assert-True ([bool]$status.ok) 'installed Companion status response was not healthy'
    $diagnostic = (& (Join-Path $install '_internal\scripts\diagnose.ps1') -DataDir $data | Out-String) | ConvertFrom-Json
    Assert-True ([bool]$diagnostic.ok) 'installed diagnostic reported a required failure'
    Assert-True ([bool](($diagnostic.checks | Where-Object name -eq 'status').ok)) 'installed diagnostic did not observe the running status endpoint'
  } catch {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    throw
  }
  Assert-True (-not $process.HasExited) 'Companion stopped before the running-update test'
  Assert-True (Test-Path -LiteralPath (Join-Path $data 'config\pairing-token.json')) 'first installed launch did not create a pairing record'
  $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  $tokenHash = (Get-FileHash -LiteralPath (Join-Path $data 'config\pairing-token.json') -Algorithm SHA256).Hash
  $jobHash = (Get-FileHash -LiteralPath (Join-Path $data 'state\jobs.jsonl') -Algorithm SHA256).Hash

  $third = Invoke-Build '0.3.0-test.2' (Join-Path $root 'dist-c') -SkipArchive
  $tamperPath = Join-Path $third.releaseDirectory '_internal\app\README.md'
  $originalBytes = [System.IO.File]::ReadAllBytes($tamperPath)
  [System.IO.File]::WriteAllBytes($tamperPath, $originalBytes + [byte]0x20)
  $tamperRejected = $false
  try { & (Join-Path $third.releaseDirectory '_internal\update.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null } catch { $tamperRejected = $true }
  Assert-True $tamperRejected 'tampered update package was accepted'
  $stateBefore = Get-Content -Raw -LiteralPath (Join-Path $data 'install-state.json') | ConvertFrom-Json
  Assert-True ($stateBefore.version -eq '0.3.0-test.1') 'rejected update changed installed state'
  [System.IO.File]::WriteAllBytes($tamperPath, $originalBytes)

  & (Join-Path $third.releaseDirectory '_internal\update.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  $process.Refresh()
  Assert-True $process.HasExited 'valid update did not stop the running installed Companion'
  $restartedStatus = $null
  for ($attempt = 0; $attempt -lt 50 -and -not $restartedStatus; $attempt++) {
    try { $restartedStatus = Invoke-RestMethod -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$statusPort/status" } catch { Start-Sleep -Milliseconds 100 }
  }
  Assert-True ([bool]$restartedStatus.ok) 'valid update did not restart Companion after replacing the running install'
  $stateAfter = Get-Content -Raw -LiteralPath (Join-Path $data 'install-state.json') | ConvertFrom-Json
  Assert-True ($stateAfter.version -eq '0.3.0-test.2') 'valid update did not replace the installed version'
  Assert-True ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -eq $configHash) 'update changed the user configuration'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $data 'config\pairing-token.json') -Algorithm SHA256).Hash -eq $tokenHash) 'update changed the pairing token store'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $data 'state\jobs.jsonl') -Algorithm SHA256).Hash -eq $jobHash) 'update changed the job journal'
  Assert-True (Test-Path -LiteralPath $stateAfter.previousInstall) 'valid update did not retain a rollback installation'

  & (Join-Path $install '_internal\uninstall.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $install)) 'uninstall left the application directory behind'
  Assert-True (Test-Path -LiteralPath (Join-Path $data 'config\pairing-token.json')) 'default uninstall removed retained data'

  & (Join-Path $third.releaseDirectory '_internal\install.ps1') -InstallDir $install -DataDir $data -NoShortcut | Out-Null
  & (Join-Path $install '_internal\uninstall.ps1') -InstallDir $install -DataDir $data -RemoveData -NoShortcut | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $install)) 'explicit data-removal uninstall left the application directory behind'
  Assert-True (-not (Test-Path -LiteralPath $data)) 'explicit data-removal uninstall left the data directory behind'

  Write-Output 'PASS'
  Write-Output "Built deterministic release ZIP $($first.archiveSha256), launched the installed Companion and diagnostics with bundled Node, updated it while running with an automatic stop/restart, rejected a tampered update, preserved config/token/jobs across update, retained data on default uninstall, and removed it only on explicit request."
} finally {
  if ($install) {
    $stopHelper = Join-Path $install '_internal\scripts\stop-companion.ps1'
    if (Test-Path -LiteralPath $stopHelper -PathType Leaf) { try { & $stopHelper -InstallDir $install | Out-Null } catch {} }
  }
  Remove-SelfTestTree $root
}
