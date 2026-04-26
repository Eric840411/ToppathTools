@echo off
title Restarting Workflow Integrator...
cd /d "%~dp0"

echo.
echo  [*] Stopping servers on port 3000 and 5173...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($port in @(3000, 5173)) { $p = netstat -aon | Select-String "":$port\s"" | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1; if ($p) { taskkill /PID $p /F 2>$null | Out-Null; Write-Host ""  [OK] Port $port stopped (PID $p)"" } else { Write-Host ""  [--] Port $port was not running"" } }"

echo.
echo  [*] Starting servers...
timeout /t 1 /nobreak > nul

start "Workflow Integrator" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0toggle-runner.ps1"

echo  [OK] Servers restarting in a new window.
echo.
timeout /t 2 /nobreak > nul
