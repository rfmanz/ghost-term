@echo off
cd /d "%~dp0"
start /B node server.js
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window --start-fullscreen --force-device-scale-factor=1.25 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\GhostTerm" --no-first-run http://localhost:3000
