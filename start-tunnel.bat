@echo off
echo Starting Toppath Tools...

cd /d "%~dp0"

where pm2.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PM2 is not installed. Run: npm install -g pm2
  pause
  exit /b 1
)

if not exist "node_modules\tsx\dist\cli.mjs" (
  echo [ERROR] Dependencies are missing. Run: npm install
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs"

echo Building frontend for production hosting...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

pm2.cmd describe toppath-server >nul 2>nul
if errorlevel 1 (
  echo Starting PM2 apps from ecosystem.config.cjs...
  pm2.cmd start ecosystem.config.cjs
) else (
  echo Restarting toppath-server...
  pm2.cmd restart toppath-server

  pm2.cmd describe toppath-tunnel >nul 2>nul
  if errorlevel 1 (
    echo Starting toppath-tunnel...
    pm2.cmd start ecosystem.config.cjs --only toppath-tunnel
  ) else (
    echo Restarting toppath-tunnel...
    pm2.cmd restart toppath-tunnel
  )
)

echo.
echo PM2 services:
pm2.cmd status
echo.
echo [Fixed] OSMWatcher Webhook URL:
echo   https://royal-parched-catcall.ngrok-free.dev/api/machine-test/osm-status
echo.
echo This URL is permanent and will not change on restart.
echo.
echo Useful commands:
echo   pm2.cmd logs toppath-server
echo   pm2.cmd logs toppath-tunnel
echo   pm2.cmd restart toppath-server
echo.
echo Note:
echo   If Windows opens a Node console window for toppath-server, keep it open.
echo   Closing it stops that server process; PM2 will restart it.
echo   For true background startup, use Task Scheduler with: pm2.cmd resurrect
pause
