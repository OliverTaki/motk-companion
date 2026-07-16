# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [string]$InstallDir = '',
  [string]$ProductionRoot = '',
  [ValidateSet('', 'dummy', 'sigma', 'digicam', 'gphoto2')]
  [string]$CameraBackend = '',
  [string]$SigmaSdkZip = '',
  [switch]$FirstRun,
  [switch]$OpenSettings,
  [switch]$Headless,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$officialOrigin = 'https://motk-public-site.pages.dev'
$shootUrl = "$officialOrigin/apps/shoot/index.html"
$mediaToolsUrl = "$officialOrigin/apps/media-tools/"
$dataPath = [System.IO.Path]::GetFullPath($DataDir)
$internalRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $InstallDir) { $InstallDir = Split-Path $internalRoot -Parent }
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$configPath = Join-Path $dataPath 'companion.json'
$tokenPath = Join-Path $dataPath 'config\pairing-token.json'

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Companion configuration is missing: $configPath" }

function Read-Settings {
  Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
}

function Test-SafeProductionRoot([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  if (-not $full -or $full -eq $driveRoot -or $full.Length -lt ($driveRoot.Length + 4)) { throw 'Choose a normal folder, not an entire drive.' }
  return $full
}

function Save-CompanionSettings([string]$Root, [string]$Backend, [string]$SdkZip) {
  $rootPath = Test-SafeProductionRoot $Root
  if ($Backend -eq 'sigma') {
    if (-not $SdkZip -or -not (Test-Path -LiteralPath $SdkZip -PathType Leaf) -or [System.IO.Path]::GetExtension($SdkZip) -ne '.zip') {
      throw 'Choose the original SIGMA Camera Control SDK ZIP.'
    }
    $SdkZip = [System.IO.Path]::GetFullPath($SdkZip)
  }
  $settings = Read-Settings
  Copy-Item -LiteralPath $configPath -Destination "$configPath.before-setup.bak" -Force
  New-Item -ItemType Directory -Force -Path $rootPath | Out-Null
  $settings.allowOrigin = $officialOrigin
  $settings.productionRoot = $rootPath
  $settings.captureInbox = Join-Path $rootPath '.companion-capture'
  $settings.cameraBackend = $Backend
  $settings.recipesDir = Join-Path $internalRoot 'app\recipes'
  $settings | Add-Member -NotePropertyName sigmaSdkZip -NotePropertyValue $(if ($Backend -eq 'sigma') { $SdkZip } else { '' }) -Force
  $settings | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $configPath -Encoding utf8
  return $rootPath
}

function Start-InstalledCompanion {
  if (Test-CompanionRunning) { return }
  $launcher = Join-Path $internalRoot 'scripts\motk-companion.ps1'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Companion launcher is missing.' }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -DataDir `"$dataPath`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $installPath -WindowStyle Hidden
}

function Test-CompanionRunning {
  try {
    $settings = Read-Settings
    $status = Invoke-RestMethod -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$([int]$settings.statusPort)/status"
    return [bool]$status.ok
  } catch { return $false }
}

function Wait-Companion([int]$Milliseconds = 5000) {
  $until = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
  do {
    if (Test-CompanionRunning) { return $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $until)
  return $false
}

function Read-PairingToken {
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { return '' }
  $record = Get-Content -Raw -LiteralPath $tokenPath | ConvertFrom-Json
  return [string]$record.token
}

function Open-ShootPaired {
  Start-InstalledCompanion
  [void](Wait-Companion)
  $token = Read-PairingToken
  if (-not $token) { throw 'Pairing is not ready. Restart Companion and try again.' }
  $fragment = 'pair=' + [Uri]::EscapeDataString($token) + '&agent=' + [Uri]::EscapeDataString('ws://127.0.0.1:8793')
  Start-Process "$shootUrl#$fragment"
}

if ($Headless) {
  if (-not $ProductionRoot) { throw 'ProductionRoot is required with -Headless.' }
  if (-not $CameraBackend) { $CameraBackend = 'dummy' }
  $savedRoot = Save-CompanionSettings $ProductionRoot $CameraBackend $SigmaSdkZip
  if (-not $NoStart) { Start-InstalledCompanion }
  [ordered]@{ ok = $true; productionRoot = $savedRoot; cameraBackend = $CameraBackend; allowOrigin = $officialOrigin } | ConvertTo-Json
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$color = [ordered]@{
  Back = [System.Drawing.Color]::FromArgb(19, 22, 28)
  Surface = [System.Drawing.Color]::FromArgb(30, 35, 44)
  SurfaceHover = [System.Drawing.Color]::FromArgb(42, 49, 61)
  Text = [System.Drawing.Color]::FromArgb(242, 245, 248)
  Muted = [System.Drawing.Color]::FromArgb(151, 161, 174)
  Accent = [System.Drawing.Color]::FromArgb(255, 190, 54)
  Ready = [System.Drawing.Color]::FromArgb(73, 209, 139)
  Offline = [System.Drawing.Color]::FromArgb(239, 99, 99)
}

function New-FlatButton([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($W, $H)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $color.Surface
  $button.ForeColor = $color.Text
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $button.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
  return $button
}

function New-Tile([string]$IconCode, [string]$Text, [int]$X, [scriptblock]$Action) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Location = New-Object System.Drawing.Point($X, 150)
  $panel.Size = New-Object System.Drawing.Size(300, 230)
  $panel.BackColor = $color.Surface
  $panel.Cursor = [System.Windows.Forms.Cursors]::Hand

  $icon = New-Object System.Windows.Forms.Label
  $icon.Text = [string][char]([Convert]::ToInt32($IconCode, 16))
  $icon.Font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 52)
  $icon.ForeColor = $color.Accent
  $icon.TextAlign = 'MiddleCenter'
  $icon.Location = New-Object System.Drawing.Point(0, 38)
  $icon.Size = New-Object System.Drawing.Size(300, 90)
  $icon.Cursor = [System.Windows.Forms.Cursors]::Hand

  $caption = New-Object System.Windows.Forms.Label
  $caption.Text = $Text
  $caption.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 16)
  $caption.ForeColor = $color.Text
  $caption.TextAlign = 'MiddleCenter'
  $caption.Location = New-Object System.Drawing.Point(0, 142)
  $caption.Size = New-Object System.Drawing.Size(300, 44)
  $caption.Cursor = [System.Windows.Forms.Cursors]::Hand

  $click = { try { & $Action } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MOTK Companion', 'OK', 'Error') | Out-Null } }.GetNewClosure()
  $enter = { $panel.BackColor = $color.SurfaceHover }.GetNewClosure()
  $leave = { $panel.BackColor = $color.Surface }.GetNewClosure()
  foreach ($control in @($panel, $icon, $caption)) {
    $control.Add_Click($click)
    $control.Add_MouseEnter($enter)
    $control.Add_MouseLeave($leave)
  }
  $panel.Controls.Add($icon)
  $panel.Controls.Add($caption)
  return $panel
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MOTK Companion'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(720, 500)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = $color.Back
$form.ForeColor = $color.Text
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$main = New-Object System.Windows.Forms.Panel
$main.Dock = 'Fill'
$main.BackColor = $color.Back

$brand = New-Object System.Windows.Forms.Label
$brand.Text = 'MOTK  COMPANION'
$brand.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18)
$brand.ForeColor = $color.Text
$brand.Location = New-Object System.Drawing.Point(35, 28)
$brand.Size = New-Object System.Drawing.Size(400, 42)
$main.Controls.Add($brand)

$statusDot = New-Object System.Windows.Forms.Label
$statusDot.Text = [string][char]0x25CF
$statusDot.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$statusDot.TextAlign = 'MiddleRight'
$statusDot.Location = New-Object System.Drawing.Point(530, 28)
$statusDot.Size = New-Object System.Drawing.Size(30, 36)
$main.Controls.Add($statusDot)

$statusText = New-Object System.Windows.Forms.Label
$statusText.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$statusText.TextAlign = 'MiddleLeft'
$statusText.Location = New-Object System.Drawing.Point(565, 29)
$statusText.Size = New-Object System.Drawing.Size(120, 34)
$main.Controls.Add($statusText)

$shootTile = New-Tile 'E722' 'SHOOT' 35 { Open-ShootPaired }
$filesTile = New-Tile 'E8B7' 'FILES' 385 {
  $root = [string](Read-Settings).productionRoot
  if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Force -Path $root | Out-Null }
  Start-Process explorer.exe -ArgumentList "`"$root`""
}
$main.Controls.Add($shootTile)
$main.Controls.Add($filesTile)

$settingsButton = New-FlatButton "$([char]0xE713)  SETTINGS" 35 420 145 42
$settingsButton.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$main.Controls.Add($settingsButton)

$mediaToolsButton = New-FlatButton "$([char]0xE943)  MEDIA TOOLS" 195 420 165 42
$mediaToolsButton.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$mediaToolsButton.Add_Click({ Start-Process $mediaToolsUrl })
$main.Controls.Add($mediaToolsButton)

$settings = New-Object System.Windows.Forms.Panel
$settings.Dock = 'Fill'
$settings.BackColor = $color.Back
$settings.Visible = $false

$backButton = New-FlatButton "$([char]0xE72B)" 25 22 48 42
$backButton.Font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 14)
$settings.Controls.Add($backButton)

$settingsTitle = New-Object System.Windows.Forms.Label
$settingsTitle.Text = 'SETTINGS'
$settingsTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18)
$settingsTitle.ForeColor = $color.Text
$settingsTitle.Location = New-Object System.Drawing.Point(90, 26)
$settingsTitle.Size = New-Object System.Drawing.Size(300, 40)
$settings.Controls.Add($settingsTitle)

$storageIcon = New-Object System.Windows.Forms.Label
$storageIcon.Text = [string][char]0xE8B7
$storageIcon.Font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 24)
$storageIcon.ForeColor = $color.Accent
$storageIcon.Location = New-Object System.Drawing.Point(35, 103)
$storageIcon.Size = New-Object System.Drawing.Size(50, 45)
$settings.Controls.Add($storageIcon)

$folderBox = New-Object System.Windows.Forms.TextBox
$folderBox.Location = New-Object System.Drawing.Point(94, 106)
$folderBox.Size = New-Object System.Drawing.Size(495, 30)
$folderBox.ReadOnly = $true
$folderBox.BackColor = $color.Surface
$folderBox.ForeColor = $color.Text
$folderBox.BorderStyle = 'FixedSingle'
$settings.Controls.Add($folderBox)

$browseFolder = New-FlatButton "$([char]0xE8B7)" 605 103 65 38
$browseFolder.Font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 14)
$browseFolder.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.SelectedPath = $folderBox.Text
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $folderBox.Text = $dialog.SelectedPath }
})
$settings.Controls.Add($browseFolder)

$cameraIcon = New-Object System.Windows.Forms.Label
$cameraIcon.Text = [string][char]0xE722
$cameraIcon.Font = New-Object System.Drawing.Font('Segoe MDL2 Assets', 24)
$cameraIcon.ForeColor = $color.Accent
$cameraIcon.Location = New-Object System.Drawing.Point(35, 181)
$cameraIcon.Size = New-Object System.Drawing.Size(50, 45)
$settings.Controls.Add($cameraIcon)

$cameraBox = New-Object System.Windows.Forms.ComboBox
$cameraBox.DropDownStyle = 'DropDownList'
$cameraBox.Location = New-Object System.Drawing.Point(94, 184)
$cameraBox.Size = New-Object System.Drawing.Size(576, 30)
$cameraBox.BackColor = $color.Surface
$cameraBox.ForeColor = $color.Text
$cameraOptions = [ordered]@{
  'PHONE / WEBCAM' = 'dummy'
  'SIGMA' = 'sigma'
  'CANON / NIKON / SONY' = 'digicam'
  'GPHOTO2' = 'gphoto2'
}
[void]$cameraBox.Items.AddRange([object[]]$cameraOptions.Keys)
$settings.Controls.Add($cameraBox)

$sdkBox = New-Object System.Windows.Forms.TextBox
$sdkBox.Location = New-Object System.Drawing.Point(94, 243)
$sdkBox.Size = New-Object System.Drawing.Size(495, 30)
$sdkBox.ReadOnly = $true
$sdkBox.BackColor = $color.Surface
$sdkBox.ForeColor = $color.Text
$sdkBox.BorderStyle = 'FixedSingle'
$settings.Controls.Add($sdkBox)

$browseSdk = New-FlatButton 'SDK' 605 240 65 38
$browseSdk.Add_Click({
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Filter = 'ZIP files (*.zip)|*.zip'
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $sdkBox.Text = $dialog.FileName }
})
$settings.Controls.Add($browseSdk)

$pairButton = New-FlatButton "$([char]0xE71B)  PAIR" 94 315 140 44
$pairButton.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$pairButton.Add_Click({
  try {
    Start-InstalledCompanion
    [void](Wait-Companion)
    $token = Read-PairingToken
    if (-not $token) { throw 'Pairing is not ready.' }
    [System.Windows.Forms.Clipboard]::SetText($token)
    $pairButton.Text = "$([char]0xE73E)  COPIED"
    $pairButton.BackColor = $color.Ready
  } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MOTK Companion', 'OK', 'Error') | Out-Null }
})
$settings.Controls.Add($pairButton)

$saveButton = New-FlatButton 'SAVE' 520 408 150 48
$saveButton.BackColor = $color.Accent
$saveButton.ForeColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
$settings.Controls.Add($saveButton)

function Load-SettingsView {
  $current = Read-Settings
  $defaultHiddenRoot = [System.IO.Path]::GetFullPath((Join-Path $dataPath 'production')).TrimEnd('\')
  $root = if ($current.productionRoot) { [System.IO.Path]::GetFullPath([string]$current.productionRoot).TrimEnd('\') } else { $defaultHiddenRoot }
  if ($root -eq $defaultHiddenRoot) { $root = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'MOTK Companion Files' }
  $folderBox.Text = $root
  $sdkBox.Text = if ($current.sigmaSdkZip) { [string]$current.sigmaSdkZip } else { '' }
  $selectedBackend = if ($current.cameraBackend) { [string]$current.cameraBackend } else { 'dummy' }
  $selectedLabel = @($cameraOptions.GetEnumerator() | Where-Object Value -eq $selectedBackend | Select-Object -First 1).Key
  $cameraBox.SelectedItem = if ($selectedLabel) { $selectedLabel } else { 'PHONE / WEBCAM' }
}

function Set-SettingsVisible([bool]$Visible) {
  if ($Visible) { Load-SettingsView }
  $settings.Visible = $Visible
  $main.Visible = -not $Visible
}

$cameraBox.Add_SelectedIndexChanged({
  $sigma = $cameraOptions[[string]$cameraBox.SelectedItem] -eq 'sigma'
  $sdkBox.Visible = $sigma
  $browseSdk.Visible = $sigma
})

$settingsButton.Add_Click({ Set-SettingsVisible $true })
$backButton.Add_Click({ if ($FirstRun) { return }; Set-SettingsVisible $false })
$saveButton.Add_Click({
  try {
    $backend = $cameraOptions[[string]$cameraBox.SelectedItem]
    [void](Save-CompanionSettings $folderBox.Text $backend $sdkBox.Text)
    Start-InstalledCompanion
    if (-not (Wait-Companion)) { throw 'Companion did not start.' }
    $script:FirstRun = $false
    Set-SettingsVisible $false
  } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MOTK Companion', 'OK', 'Error') | Out-Null }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1200
$timer.Add_Tick({
  $ready = Test-CompanionRunning
  $statusDot.ForeColor = if ($ready) { $color.Ready } else { $color.Offline }
  $statusText.Text = if ($ready) { 'READY' } else { 'OFFLINE' }
  $statusText.ForeColor = if ($ready) { $color.Ready } else { $color.Offline }
})

$form.Controls.Add($main)
$form.Controls.Add($settings)
$form.Add_Shown({
  if (-not $FirstRun -and -not $NoStart) { Start-InstalledCompanion }
  Set-SettingsVisible ([bool]($FirstRun -or $OpenSettings))
  $timer.Start()
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[void]$form.ShowDialog()
