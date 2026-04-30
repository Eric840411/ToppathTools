# build-and-tunnel.ps1
$ErrorActionPreference = 'Stop'
trap {
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Script stopped. Window will stay open." -ForegroundColor Yellow
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
Write-Host "[1/3] Stopping existing processes on port 3000 / 5173..." -ForegroundColor Yellow
foreach ($port in @(3000, 5173)) {
    $pid = (netstat -aon | Select-String ":$port\s" | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1)
    if ($pid) {
        taskkill /PID $pid /F 2>$null | Out-Null
        Write-Host "  [OK] Port $port stopped (PID $pid)" -ForegroundColor DarkGray
    } else {
        Write-Host "  [--] Port $port not running" -ForegroundColor DarkGray
    }
}
Write-Host ""

# ── Step 2: Build frontend ────────────────────────────────────────────────────
Write-Host "[2/3] Building frontend (npm run build)..." -ForegroundColor Yellow
Write-Host "----------------------------------------"
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Build failed." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host ""
Write-Host "[OK] Build complete!" -ForegroundColor Green
Write-Host ""

# ── Step 3: Start Server ──────────────────────────────────────────────────────
Write-Host "[3/3] Starting Server + Cloudflare Tunnel..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoProfile -NoExit -Command `"cd '$ROOT'; npx tsx server/index.ts`"" -WindowStyle Normal

Start-Sleep -Seconds 3

# ── Start Cloudflare Tunnel and capture URL ───────────────────────────────────
$CLOUDFLARED = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$logFile = Join-Path $env:TEMP "cf_tunnel_$([System.Guid]::NewGuid().ToString('N')).log"

Start-Process -FilePath $CLOUDFLARED -ArgumentList "tunnel --url http://localhost:3000" -RedirectStandardError $logFile -NoNewWindow

Write-Host "Waiting for Cloudflare Tunnel URL (up to 60s)..." -ForegroundColor Cyan

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

# ── Read existing API key from .env ──────────────────────────────────────────
$API_KEY = ""
$envPath = Join-Path $ROOT ".env"
if (Test-Path $envPath) {
    $keyLine = Get-Content $envPath -Encoding UTF8 | Where-Object { $_ -match '^OSM_WATCHER_API_KEY=' } | Select-Object -First 1
    if ($keyLine) { $API_KEY = $keyLine -replace '^OSM_WATCHER_API_KEY=', '' }
}

# ── Show results ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan

if ($TUNNEL_URL) {
    Write-Host "  Tunnel URL: $TUNNEL_URL" -ForegroundColor Green
    Write-Host ""

    if ($API_KEY) {
        $WEBHOOK_URL = "${TUNNEL_URL}/api/machine-test/osm-status?key=${API_KEY}"
        Write-Host "  OSMWatcher Webhook URL:" -ForegroundColor White
        Write-Host "  $WEBHOOK_URL" -ForegroundColor Yellow
        Write-Host ""
        Set-Clipboard -Value $WEBHOOK_URL
        Write-Host "  [OK] Webhook URL copied to clipboard" -ForegroundColor Green
    } else {
        Write-Host "  No API key found in .env" -ForegroundColor DarkYellow
        Write-Host "  Run generate-osm-api-key.bat to create one." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "  [ERROR] Could not get tunnel URL." -ForegroundColor Red
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close this window"
