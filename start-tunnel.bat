@echo off
echo Starting Toppath Tools...

:: Start server in new window (log stays visible)
start "Toppath Server" cmd /k "cd /d "%~dp0" && npx tsx server/index.ts"

:: Wait 4 seconds for server to boot
timeout /t 4 /nobreak >nul

:: Start cloudflared tunnel in new window
start "Cloudflare Tunnel" cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000"

echo Two windows opened:
echo   - "Toppath Server"    ^<-- Server log here
echo   - "Cloudflare Tunnel" ^<-- Public URL here
pause
