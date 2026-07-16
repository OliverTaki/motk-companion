# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'))

$ErrorActionPreference = 'Stop'
$recordPath = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'config\pairing-token.json'
Add-Type -AssemblyName System.Windows.Forms
if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
  [System.Windows.Forms.MessageBox]::Show('Start MOTK Companion once, then use this shortcut again.', 'Pairing key is not ready', 'OK', 'Information') | Out-Null
  exit 1
}
$record = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
if (-not $record.token) { throw 'The pairing record has no token.' }
[System.Windows.Forms.Clipboard]::SetText([string]$record.token)
[System.Windows.Forms.MessageBox]::Show('Pairing key copied. Paste it in MOTK Shoot > Settings > Camera > Tether.', 'MOTK Companion', 'OK', 'Information') | Out-Null

