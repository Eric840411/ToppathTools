@echo off
chcp 65001 > nul
title Toppath Tools - 產生 OSMWatcher API Key

cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   Toppath Tools - 產生 OSMWatcher API Key    ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: ── 用 PowerShell 生成新 UUID ────────────────────────────────────────────────
for /f "delims=" %%G in ('powershell -NoProfile -Command "[System.Guid]::NewGuid().ToString()"') do set NEW_KEY=%%G

echo  新 API Key：%NEW_KEY%
echo.

:: ── 寫入 / 更新 .env ─────────────────────────────────────────────────────────
if not exist ".env" (
    echo  [WARN] .env 不存在，建立新檔...
    echo. > .env
)

:: 先移除舊的 OSM_WATCHER_API_KEY 行（若有），再附加新的
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$env = Get-Content '.env' -Encoding UTF8; $env = $env | Where-Object { $_ -notmatch '^OSM_WATCHER_API_KEY=' }; $env += 'OSM_WATCHER_API_KEY=%NEW_KEY%'; [System.IO.File]::WriteAllLines('.env', $env, [System.Text.UTF8Encoding]::new($false))"

echo  [OK] .env 已更新（OSM_WATCHER_API_KEY）
echo.

:: ── 顯示完整 Webhook URL ─────────────────────────────────────────────────────
echo  ════════════════════════════════════════════════
echo   請將以下 URL 設定到 OSMWatcher：
echo.
echo   本機版（內網）：
echo   http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY%
echo.
echo   外網版（Cloudflare Tunnel）：
echo   https://^<tunnel-url^>/api/machine-test/osm-status?key=%NEW_KEY%
echo  ════════════════════════════════════════════════
echo.
echo  注意：Server 需要重啟才會套用新的 API Key。
echo.

:: ── 複製本機 URL 到剪貼簿 ────────────────────────────────────────────────────
echo http://localhost:3000/api/machine-test/osm-status?key=%NEW_KEY% | clip
echo  [OK] 本機 URL 已複製到剪貼簿
echo.
pause
