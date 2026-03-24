@echo off
cd /d "%~dp0"

:: Check if server is healthy and how many browser windows are connected
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 2; $j = $r.Content | ConvertFrom-Json; if ($j.clients -gt 0) { exit 0 } else { exit 2 } } catch { exit 1 }"
set HEALTH=%errorlevel%

:: errorlevel 0 = server healthy + browsers connected → just add a tab
if %HEALTH%==0 (
  powershell -Command "Invoke-WebRequest -Uri 'http://localhost:3000/api/new-tab' -Method POST -ContentType 'application/json' -Body '{\"name\":\"scratch\"}' -UseBasicParsing | Out-Null"
  exit /b
)

:: errorlevel 2 = server healthy but no browsers → open Chrome (tabs=1 since server already exists)
if %HEALTH%==2 (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000?tabs=1 --start-fullscreen --force-device-scale-factor=1.75 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\GhostTerm1" --no-first-run
  exit /b
)

:: errorlevel 1 = server not running — kill stale processes and start fresh
powershell -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Seconds 1"

if exist "%~dp0ghost-term.pid" (
  set /p STALE_PID=<"%~dp0ghost-term.pid"
  powershell -Command "Stop-Process -Id %STALE_PID% -Force -ErrorAction SilentlyContinue"
  del "%~dp0ghost-term.pid" >nul 2>&1
)

:: Start server
powershell -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

:: Wait for server to become healthy (up to 10 seconds)
set RETRIES=0
:wait_loop
powershell -Command "try { Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 goto :server_ready
set /a RETRIES+=1
if %RETRIES% geq 10 (
  echo ERROR: ghost-term server failed to start
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto :wait_loop

:server_ready
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --start-fullscreen --force-device-scale-factor=1.75 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\GhostTerm1" --no-first-run
