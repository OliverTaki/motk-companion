@echo off
setlocal
title Install MOTK Companion
echo Installing MOTK Companion for this Windows account...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -NoRestart
if errorlevel 1 (
  echo.
  echo Installation did not finish. Keep this window open and report the message above.
  pause
  exit /b 1
)
echo.
echo Installation complete. Opening first-time setup...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\MOTK Companion\scripts\configure.ps1"
if errorlevel 1 (
  echo.
  echo Setup was not completed. You can reopen it from Start ^> MOTK Companion - Setup.
  pause
)
