@echo off
title Workflow Integrator
cd /d "%~dp0"
if not exist logs mkdir logs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0toggle-runner.ps1"
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: PowerShell exited with code %errorlevel%
    echo.
    pause
)
