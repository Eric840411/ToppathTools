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

:: Generate UUID via PowerShell
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

:: Update .env
if not exist ".env" type nul > .env

powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Resolve-Path '.env'; $lines = Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue; if ($null -eq $lines){$lines=@()}; $lines = @($lines | Where-Object{$_ -notmatch '^OSM_WATCHER_API_KEY='}); $lines += 'OSM_WATCHER_API_KEY=%NEW_KEY%'; [System.IO.File]::WriteAllLines($f, $lines, (New-Object System.Text.UTF8Encoding $false))"

if %errorlevel% neq 0 (
    echo [ERROR] Failed to write .env
    echo.
    goto :end
)

echo [OK] .env updated
echo.

:: Show webhook URLs
echo ================================================
echo   Set this URL in OSMWatcher:
echo.
echo   [LAN]
echo   http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   [WAN - Cloudflare Tunnel]
echo   https://<tunnel-url>/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   NOTE: Restart server to apply new key.
echo ================================================
echo.

:: Copy LAN URL to clipboard
echo http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY% | clip
echo [OK] LAN URL copied to clipboard
echo.

:end
echo Press any key to close...
pause > nul
