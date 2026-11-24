@echo off
rem Universal Chip Lab, started from this repo's source (double-click me).
rem
rem This is the build that has the latest work AND shares its vehicle library
rem (.runtime\vehicle-library) with the command-line runner "pnpm vehicle ...",
rem so what is discovered or mapped from the command line shows up in the
rem cockpit a few seconds later. The installed app (desktop shortcut) keeps a
rem separate library and only changes with a new release.
rem
rem Keep this black window open while you use the app; closing the app closes it.
title Universal Chip Lab (from source)
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found on PATH. Install Node 24 and run:  npm install -g pnpm
  pause
  exit /b 1
)
set ECL_NO_DEVTOOLS=1
rem The desk simulator: a full virtual car on this PC (no Pi, no wiring). In the app:
rem Diagnostics - Connect - "Desk simulator". If one is already running, this one
rem just exits. Close its minimised window to stop it.
where python >nul 2>nul
if not errorlevel 1 start "Chip Lab desk simulator" /min python "%~dp0hardware\super-device\webui\desk_sim.py"
echo Starting Universal Chip Lab from %cd% ...
echo (first start takes 10-20 seconds; the window opens by itself)
call pnpm dev
echo.
echo Universal Chip Lab has stopped.
pause
