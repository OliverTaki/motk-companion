# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MOTK\Companion'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MOTK Companion'),
  [string]$ProductionRoot = '',
  [ValidateSet('', 'dummy', 'sigma', 'digicam', 'gphoto2')]
  [string]$CameraBackend = '',
  [string]$SigmaSdkZip = '',
  [switch]$Headless,
  [switch]$StartAfterSave,
  [switch]$OpenShootAfterSave
)

$ErrorActionPreference = 'Stop'
$officialOrigin = 'https://motk-public-site.pages.dev'
$shootUrl = "$officialOrigin/apps/shoot/index.html"
$dataPath = [System.IO.Path]::GetFullPath($DataDir)
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$configPath = Join-Path $dataPath 'companion.json'

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Companion configuration is missing: $configPath" }

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
  $settings = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $backup = "$configPath.before-setup.bak"
  Copy-Item -LiteralPath $configPath -Destination $backup -Force
  New-Item -ItemType Directory -Force -Path $rootPath | Out-Null
  $settings.allowOrigin = $officialOrigin
  $settings.productionRoot = $rootPath
  $settings.captureInbox = Join-Path $rootPath '.companion-capture'
  $settings.cameraBackend = $Backend
  $settings | Add-Member -NotePropertyName sigmaSdkZip -NotePropertyValue $(if ($Backend -eq 'sigma') { $SdkZip } else { '' }) -Force
  $settings | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $configPath -Encoding utf8
  return $rootPath
}

function Start-InstalledCompanion {
  $launcher = Join-Path $installPath 'scripts\motk-companion.ps1'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Companion launcher is missing: $launcher" }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -DataDir `"$dataPath`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $installPath
}

if ($Headless) {
  if (-not $ProductionRoot) { throw 'ProductionRoot is required with -Headless.' }
  if (-not $CameraBackend) { $CameraBackend = 'dummy' }
  $savedRoot = Save-CompanionSettings $ProductionRoot $CameraBackend $SigmaSdkZip
  if ($StartAfterSave) { Start-InstalledCompanion }
  if ($OpenShootAfterSave) { Start-Process $shootUrl }
  [ordered]@{ ok = $true; productionRoot = $savedRoot; cameraBackend = $CameraBackend; allowOrigin = $officialOrigin } | ConvertTo-Json
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$current = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$defaultHiddenRoot = [System.IO.Path]::GetFullPath((Join-Path $dataPath 'production')).TrimEnd('\')
$currentRoot = if ($current.productionRoot) { [System.IO.Path]::GetFullPath([string]$current.productionRoot).TrimEnd('\') } else { $defaultHiddenRoot }
if ($currentRoot -eq $defaultHiddenRoot) { $currentRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'MOTK Companion Files' }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MOTK Companion Setup'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(650, 390)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Choose where local media is stored and what camera Companion controls.'
$title.Location = New-Object System.Drawing.Point(22, 20)
$title.Size = New-Object System.Drawing.Size(605, 42)
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
$form.Controls.Add($title)

$folderLabel = New-Object System.Windows.Forms.Label
$folderLabel.Text = 'Local media folder'
$folderLabel.Location = New-Object System.Drawing.Point(22, 77)
$folderLabel.AutoSize = $true
$form.Controls.Add($folderLabel)

$folderBox = New-Object System.Windows.Forms.TextBox
$folderBox.Text = $currentRoot
$folderBox.Location = New-Object System.Drawing.Point(22, 102)
$folderBox.Size = New-Object System.Drawing.Size(500, 28)
$form.Controls.Add($folderBox)

$browseFolder = New-Object System.Windows.Forms.Button
$browseFolder.Text = 'Browse…'
$browseFolder.Location = New-Object System.Drawing.Point(534, 99)
$browseFolder.Size = New-Object System.Drawing.Size(92, 32)
$browseFolder.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Choose the folder where Companion may read and create production media.'
  $dialog.SelectedPath = $folderBox.Text
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $folderBox.Text = $dialog.SelectedPath }
})
$form.Controls.Add($browseFolder)

$cameraLabel = New-Object System.Windows.Forms.Label
$cameraLabel.Text = 'Camera control'
$cameraLabel.Location = New-Object System.Drawing.Point(22, 150)
$cameraLabel.AutoSize = $true
$form.Controls.Add($cameraLabel)

$cameraBox = New-Object System.Windows.Forms.ComboBox
$cameraBox.DropDownStyle = 'DropDownList'
$cameraBox.Location = New-Object System.Drawing.Point(22, 175)
$cameraBox.Size = New-Object System.Drawing.Size(604, 28)
$cameraOptions = [ordered]@{
  'Browser camera / Media Tools only' = 'dummy'
  'SIGMA camera with Camera Control SDK' = 'sigma'
  'Camera through digiCamControl' = 'digicam'
  'Camera through gPhoto2' = 'gphoto2'
}
[void]$cameraBox.Items.AddRange([object[]]$cameraOptions.Keys)
$selectedBackend = if ($current.cameraBackend) { [string]$current.cameraBackend } else { 'dummy' }
$selectedLabel = @($cameraOptions.GetEnumerator() | Where-Object Value -eq $selectedBackend | Select-Object -First 1).Key
$cameraBox.SelectedItem = if ($selectedLabel) { $selectedLabel } else { 'Browser camera / Media Tools only' }
$form.Controls.Add($cameraBox)

$sdkLabel = New-Object System.Windows.Forms.Label
$sdkLabel.Text = 'SIGMA Camera Control SDK ZIP'
$sdkLabel.Location = New-Object System.Drawing.Point(22, 221)
$sdkLabel.AutoSize = $true
$form.Controls.Add($sdkLabel)

$sdkBox = New-Object System.Windows.Forms.TextBox
$sdkBox.Text = if ($current.sigmaSdkZip) { [string]$current.sigmaSdkZip } else { '' }
$sdkBox.Location = New-Object System.Drawing.Point(22, 246)
$sdkBox.Size = New-Object System.Drawing.Size(500, 28)
$form.Controls.Add($sdkBox)

$browseSdk = New-Object System.Windows.Forms.Button
$browseSdk.Text = 'Browse…'
$browseSdk.Location = New-Object System.Drawing.Point(534, 243)
$browseSdk.Size = New-Object System.Drawing.Size(92, 32)
$browseSdk.Add_Click({
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Choose CameraControlSDK_for_Win.zip'
  $dialog.Filter = 'ZIP files (*.zip)|*.zip'
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $sdkBox.Text = $dialog.FileName }
})
$form.Controls.Add($browseSdk)

$originInfo = New-Object System.Windows.Forms.Label
$originInfo.Text = "Allowed web app: $officialOrigin"
$originInfo.Location = New-Object System.Drawing.Point(22, 292)
$originInfo.Size = New-Object System.Drawing.Size(605, 24)
$originInfo.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($originInfo)

$toggleSigma = {
  $enabled = $cameraOptions[[string]$cameraBox.SelectedItem] -eq 'sigma'
  $sdkLabel.Enabled = $enabled; $sdkBox.Enabled = $enabled; $browseSdk.Enabled = $enabled
}
$cameraBox.Add_SelectedIndexChanged($toggleSigma)
& $toggleSigma

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(418, 337)
$cancel.Size = New-Object System.Drawing.Size(96, 34)
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save & Start'
$save.Location = New-Object System.Drawing.Point(522, 337)
$save.Size = New-Object System.Drawing.Size(104, 34)
$save.Add_Click({
  try {
    $backend = $cameraOptions[[string]$cameraBox.SelectedItem]
    $savedRoot = Save-CompanionSettings $folderBox.Text $backend $sdkBox.Text
    Start-InstalledCompanion
    Start-Process $shootUrl
    [System.Windows.Forms.MessageBox]::Show("Companion is starting.`n`nLocal media: $savedRoot`n`nUse 'Copy Pairing Key' from the Windows Start menu, then paste it in MOTK Shoot > Settings > Camera > Tether.", 'MOTK Companion is ready', 'OK', 'Information') | Out-Null
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Setup could not be saved', 'OK', 'Error') | Out-Null
  }
})
$form.Controls.Add($save)
$form.AcceptButton = $save

[void]$form.ShowDialog()

