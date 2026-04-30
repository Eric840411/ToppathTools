# build-and-tunnel.ps1
$ErrorActionPreference = 'Stop'
trap {
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    $ErrorActionPreference = 'Continue'
    Read-Host "Press Enter to close"
    exit 1
}

$Host.UI.RawUI.WindowTitle = 'Toppath Tools - Build + Tunnel'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Toppath Tools - Build + Tunnel" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Stop existing processes ──────────────────────────────────────────
Write-Host "[1/3] Stopping port 3000 / 5173..." -ForegroundColor Yellow
foreach ($port in @(3000, 5173)) {
    $procId = (netstat -aon | Select-String ":$port\s" | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1)
    if ($procId) {
        taskkill /PID $procId /F 2>$null | Out-Null
        Write-Host "  [OK] Port $port stopped" -ForegroundColor DarkGray
    }
}
Write-Host ""

# ── Step 2: Build frontend ────────────────────────────────────────────────────
Write-Host "[2/3] Building frontend..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
Write-Host "[OK] Build complete" -ForegroundColor Green
Write-Host ""

# ── Step 3: Start Server ──────────────────────────────────────────────────────
Write-Host "[3/3] Starting Server + Tunnel..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoProfile -NoExit -Command `"cd '$ROOT'; npx tsx server/index.ts`"" -WindowStyle Normal
Start-Sleep -Seconds 3

# ── Start Cloudflare Tunnel ───────────────────────────────────────────────────
$CLOUDFLARED = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$logFile = Join-Path $env:TEMP "cf_tunnel_$([System.Guid]::NewGuid().ToString('N')).log"
Start-Process -FilePath $CLOUDFLARED -ArgumentList "tunnel --url http://localhost:3000" -RedirectStandardError $logFile -NoNewWindow

Write-Host "Waiting for tunnel URL..." -ForegroundColor Cyan
$TUNNEL_URL = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $logFile) {
        $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $TUNNEL_URL = $matches[0]
            break
        }
    }
}
if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }

# ── Show result ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
if ($TUNNEL_URL) {
    $WEBHOOK = "$TUNNEL_URL/api/machine-test/osm-status"
    Write-Host "  OSMWatcher Webhook URL:" -ForegroundColor White
    Write-Host "  $WEBHOOK" -ForegroundColor Yellow
    Write-Host ""
    Set-Clipboard -Value $WEBHOOK
    Write-Host "  [OK] URL copied to clipboard" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Could not get tunnel URL" -ForegroundColor Red
}
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
