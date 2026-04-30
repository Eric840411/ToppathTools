@echo off
chcp 65001 > nul
title Toppath Tools - Build 外網版

cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Toppath Tools - Build 外網版       ║
echo  ╚══════════════════════════════════════╝
echo.

:: ── Step 1: 停止殘留 process ────────────────────────────────────────────────
echo  [1/3] 停止殘留服務（port 3000 / 5173）...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($port in @(3000, 5173)) { $p = netstat -aon | Select-String "":$port\s"" | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1; if ($p) { taskkill /PID $p /F 2>$null | Out-Null; Write-Host ""  [OK] Port $port stopped (PID $p)"" } else { Write-Host ""  [--] Port $port not running"" } }"
echo.

:: ── Step 2: Build 前端 ───────────────────────────────────────────────────────
echo  [2/3] 建置前端（npm run build）...
echo  ----------------------------------------
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Build 失敗，請檢查錯誤訊息。
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Build 完成！
echo.

:: ── Step 3: 啟動 Server + Tunnel ────────────────────────────────────────────
echo  [3/3] 啟動 Server 與 Cloudflare Tunnel...
echo.

start "Toppath Server (外網)" cmd /k "cd /d "%~dp0" && npx tsx server/index.ts"

timeout /t 4 /nobreak > nul

start "Cloudflare Tunnel" cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000"

echo.
echo  ════════════════════════════════════════
echo   兩個視窗已開啟：
echo     1. Toppath Server (外網)  ^<-- Server log
echo     2. Cloudflare Tunnel      ^<-- 公開 URL 在這裡
echo.
echo   OSMWatcher Webhook：
echo     https://^<tunnel-url^>/api/machine-test/osm-status
echo  ════════════════════════════════════════
echo.
pause
