@echo off
chcp 65001 > nul
title Generate OSMWatcher API Key

cd /d "%~dp0"

echo.
echo ================================================
echo   Generate OSMWatcher API Key
echo ================================================
echo.

:: ── 生成新 UUID ──────────────────────────────────
set NEW_KEY=
for /f "usebackq delims=" %%G in (`powershell -NoProfile -Command "[System.Guid]::NewGuid().ToString()"`) do set NEW_KEY=%%G

if "%NEW_KEY%"=="" (
    echo [ERROR] 無法生成 API Key，請確認 PowerShell 可正常執行。
    pause
    exit /b 1
)

echo   新 API Key：
echo   %NEW_KEY%
echo.

:: ── 寫入 .env ────────────────────────────────────
if not exist ".env" (
    echo [WARN] .env 不存在，建立新檔...
    type nul > .env
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lines = (Get-Content '.env' -Encoding UTF8 -ErrorAction SilentlyContinue); if ($null -eq $lines) { $lines = @() }; $lines = @($lines | Where-Object { $_ -notmatch '^OSM_WATCHER_API_KEY=' }); $lines += 'OSM_WATCHER_API_KEY=%NEW_KEY%'; [System.IO.File]::WriteAllLines((Resolve-Path '.env').Path, $lines, (New-Object System.Text.UTF8Encoding $false))"

if %errorlevel% neq 0 (
    echo [ERROR] 寫入 .env 失敗。
    pause
    exit /b 1
)

echo [OK] .env 已更新
echo.

:: ── 顯示 Webhook URL ─────────────────────────────
echo ================================================
echo   請複製以下 URL 設定到 OSMWatcher：
echo.
echo   [内網]
echo   http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   [外網 Cloudflare Tunnel]
echo   https://<tunnel-url>/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   注意：Server 需要重啟才會套用新 Key
echo ================================================
echo.

:: ── 複製到剪貼簿 ─────────────────────────────────
echo http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY% | clip
echo [OK] 内網 URL 已複製到剪貼簿
echo.
pause
