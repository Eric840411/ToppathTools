@echo off
setlocal

cd /d "%~dp0"

if "%CENTRAL_URL%"=="" set "CENTRAL_URL=ws://localhost:3000"
if "%AGENT_LABEL%"=="" set "AGENT_LABEL=%COMPUTERNAME%"

echo Starting Toppath worker agent...
echo   CENTRAL_URL=%CENTRAL_URL%
echo   AGENT_LABEL=%AGENT_LABEL%
echo.
echo Close this window to stop this worker after the current run.
echo.

npx tsx server/agent-runner.ts

endlocal
