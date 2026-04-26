$ErrorActionPreference = 'Stop'

function Get-PidOnPort($port) {
    try {
        netstat -aon |
            Select-String ":$port\s" |
            Select-String 'LISTENING' |
            ForEach-Object { ($_ -split '\s+')[-1] } |
            Where-Object { $_ -match '^\d+$' } |
            Select-Object -First 1
    } catch {
        return $null
    }
}

function Stop-Servers {
    Write-Host ""
    Write-Host "  ================================" -ForegroundColor Red
    Write-Host "   Stopping Workflow Integrator" -ForegroundColor Red
    Write-Host "  ================================" -ForegroundColor Red
    Write-Host ""
    foreach ($port in @(3000, 5173)) {
        $p = Get-PidOnPort $port
        if ($p) {
            taskkill /PID $p /F 2>$null | Out-Null
            Write-Host "  [OK] Port $port stopped (PID $p)" -ForegroundColor DarkGray
        } else {
            Write-Host "  [--] Port $port not running" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    Write-Host "  All services stopped." -ForegroundColor Yellow
    Write-Host ""
    pause
}

function Start-Servers {
    $ts      = Get-Date -Format 'yyyyMMdd_HHmmss'
    $logFile = "logs\server_$ts.log"

    # 先清除殘留 process
    foreach ($port in @(3000, 5173)) {
        $p = Get-PidOnPort $port
        if ($p) {
            taskkill /PID $p /F 2>$null | Out-Null
            Write-Host "  Cleared old process on port $port (PID $p)" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    Write-Host "  ================================" -ForegroundColor Cyan
    Write-Host "   Starting Workflow Integrator" -ForegroundColor Cyan
    Write-Host "  ================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Log: $logFile" -ForegroundColor Yellow
    Write-Host ""

    Start-Transcript -Path $logFile -Append | Out-Null

    $t = Get-Date -Format 'HH:mm:ss'
    Write-Host "  [$t] Server starting..." -ForegroundColor Green

    npm run dev:all

    $t = Get-Date -Format 'HH:mm:ss'
    Write-Host ""
    Write-Host "  [$t] Server stopped." -ForegroundColor Red
    Stop-Transcript | Out-Null
}

try {
    $running = Get-PidOnPort 5173
    if ($running) {
        Stop-Servers
    } else {
        Start-Servers
    }
} catch {
    Write-Host ""
    Write-Host "  ==============================" -ForegroundColor Red
    Write-Host "   ERROR" -ForegroundColor Red
    Write-Host "  ==============================" -ForegroundColor Red
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Write-Host ""
    pause
    exit 1
}
