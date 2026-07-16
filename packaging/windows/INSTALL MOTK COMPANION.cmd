@echo off
setlocal
title Install MOTK Companion
echo Installing MOTK Companion for this Windows account...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0_internal\install.ps1" -NoRestart
if errorlevel 1 (
  echo.
  echo Installation did not finish. Keep this window open and report the message above.
  pause
  exit /b 1
)
echo.
echo Installation complete. Opening MOTK Companion...
"%LOCALAPPDATA%\Programs\MOTK Companion\MOTK Companion.exe" --first-run
if errorlevel 1 (
  echo.
  echo MOTK Companion could not open. You can reopen it from the Start menu.
  pause
)
