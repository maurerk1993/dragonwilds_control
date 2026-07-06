@echo off
setlocal EnableExtensions

REM Dragonwilds Server Control desktop launcher.
REM Run this from the app folder on the Windows 11 server.

set "APP_DIR=%~dp0"
set "DWSC_HOST=127.0.0.1"
set "DWSC_PORT=8787"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found.
  echo Install Node.js 20 or newer, then run this launcher again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

cd /d "%APP_DIR%"
node server\index.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Dragonwilds Server Control stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
