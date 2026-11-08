@echo off
setlocal
cd /d "%~dp0"
title QunZai Site Admin
where node >nul 2>nul
if errorlevel 1 (
  echo [x] node.exe not found. Install Node.js: https://nodejs.org
  pause
  exit /b 1
)
echo Starting admin at http://127.0.0.1:8899/
echo Close this window to stop the server.
node server.js
pause
