@echo off
echo Starting Toppath Tools...

:: Start server in new window (log stays visible)
start "Toppath Server" cmd /k "cd /d "%~dp0" && npx tsx server/index.ts"

:: Wait 4 seconds for server to boot
timeout /t 4 /nobreak >nul

:: Start ngrok with fixed static domain
start "ngrok Tunnel" cmd /k "ngrok http 3000 --domain=royal-parched-catcall.ngrok-free.app"

echo.
echo Two windows opened:
echo   - "Toppath Server"  ^<-- Server log
echo   - "ngrok Tunnel"    ^<-- Tunnel status
echo.
echo [Fixed] OSMWatcher Webhook URL:
echo   https://royal-parched-catcall.ngrok-free.app/api/machine-test/osm-status
echo.
echo This URL is permanent and will not change on restart.
pause
