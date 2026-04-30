@echo off
:: Self-restart in a persistent window so output is never lost
if not defined STAY_OPEN (
    set STAY_OPEN=1
    cmd /k "%~f0"
    exit /b
)

title Generate OSMWatcher API Key
cd /d "%~dp0"

echo.
echo ================================================
echo   Generate OSMWatcher API Key
echo ================================================
echo.

:: ── Generate UUID ────────────────────────────────
set NEW_KEY=
for /f "usebackq delims=" %%G in (`powershell -NoProfile -Command "[System.Guid]::NewGuid().ToString()"`) do set NEW_KEY=%%G

if "%NEW_KEY%"=="" (
    echo [ERROR] Failed to generate key. Check PowerShell is available.
    echo.
    goto :end
)

echo   New API Key:
echo   %NEW_KEY%
echo.

:: ── Update .env ──────────────────────────────────
if not exist ".env" type nul > .env

powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Resolve-Path '.env'; $lines = Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue; if ($null -eq $lines){$lines=@()}; $lines = @($lines | Where-Object{$_ -notmatch '^OSM_WATCHER_API_KEY='}); $lines += 'OSM_WATCHER_API_KEY=%NEW_KEY%'; [System.IO.File]::WriteAllLines($f, $lines, (New-Object System.Text.UTF8Encoding $false))"

if %errorlevel% neq 0 (
    echo [ERROR] Failed to write .env
    echo.
    goto :end
)
echo [OK] .env updated
echo.

:: ── Start Cloudflare Tunnel and capture URL ──────
echo Starting Cloudflare Tunnel, waiting for URL...
echo (This may take 10-30 seconds)
echo.

set TUNNEL_LOG=%TEMP%\cf_tunnel_%RANDOM%.log
set TUNNEL_URL=

:: Start cloudflared in background, pipe output to log file
start /b "" "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 > "%TUNNEL_LOG%" 2>&1

:: Poll log file for the trycloudflare URL (up to 60 seconds)
set /a ATTEMPTS=0
:poll
timeout /t 2 /nobreak > nul
set /a ATTEMPTS+=1

for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "if (Test-Path '%TUNNEL_LOG%') { Get-Content '%TUNNEL_LOG%' | Select-String 'trycloudflare\.com' | ForEach-Object { if ($_ -match 'https://[a-z0-9\-]+\.trycloudflare\.com') { $matches[0] } } | Select-Object -First 1 }"`) do set TUNNEL_URL=%%U

if not "%TUNNEL_URL%"=="" goto :got_url
if %ATTEMPTS% lss 30 goto :poll

echo [ERROR] Timed out waiting for tunnel URL.
echo        Make sure cloudflared is installed and server is running on port 3000.
echo.
goto :show_lan_only

:: ── Display full webhook URLs ────────────────────
:got_url
echo ================================================
echo   Set this URL in OSMWatcher:
echo.
echo   [WAN - Cloudflare Tunnel]
echo   %TUNNEL_URL%/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   [LAN]
echo   http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   NOTE: Restart server to apply new key.
echo ================================================
echo.

:: Copy WAN URL to clipboard
echo %TUNNEL_URL%/api/machine-test/osm-status?key=%NEW_KEY% | clip
echo [OK] WAN URL copied to clipboard
echo.
goto :end

:show_lan_only
echo ================================================
echo   Set this URL in OSMWatcher (LAN only):
echo.
echo   http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   NOTE: Restart server to apply new key.
echo ================================================
echo.
echo http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY% | clip
echo [OK] LAN URL copied to clipboard
echo.

:end
:: Cleanup temp log
if exist "%TUNNEL_LOG%" del "%TUNNEL_LOG%"
echo Press any key to close...
pause > nul
