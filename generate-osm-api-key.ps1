# generate-osm-api-key.ps1
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Generate OSMWatcher API Key'

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Generate OSMWatcher API Key" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── Generate UUID ─────────────────────────────────────────────────────────────
$NEW_KEY = [System.Guid]::NewGuid().ToString()
Write-Host "  New API Key:" -ForegroundColor Yellow
Write-Host "  $NEW_KEY" -ForegroundColor White
Write-Host ""

# ── Update .env ───────────────────────────────────────────────────────────────
$envPath = Join-Path $ROOT ".env"
if (-not (Test-Path $envPath)) {
    New-Item -Path $envPath -ItemType File | Out-Null
    Write-Host "[WARN] .env not found, created new file." -ForegroundColor Yellow
}

$lines = Get-Content $envPath -Encoding UTF8 -ErrorAction SilentlyContinue
if ($null -eq $lines) { $lines = @() }
$lines = @($lines | Where-Object { $_ -notmatch '^OSM_WATCHER_API_KEY=' })
$lines += "OSM_WATCHER_API_KEY=$NEW_KEY"
[System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding $false))
Write-Host "[OK] .env updated" -ForegroundColor Green
Write-Host ""

# ── Start Cloudflare Tunnel and capture URL ───────────────────────────────────
$CLOUDFLARED = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $CLOUDFLARED)) {
    Write-Host "[ERROR] cloudflared not found at: $CLOUDFLARED" -ForegroundColor Red
    Write-Host "        Showing LAN URL only." -ForegroundColor DarkGray
    Write-Host ""
    $TUNNEL_URL = $null
} else {
    Write-Host "Starting Cloudflare Tunnel, waiting for URL (up to 60s)..." -ForegroundColor Cyan
    $logFile = Join-Path $env:TEMP "cf_tunnel_$([System.Guid]::NewGuid().ToString('N')).log"
    $proc = Start-Process -FilePath $CLOUDFLARED -ArgumentList "tunnel --url http://localhost:3000" -RedirectStandardError $logFile -NoNewWindow -PassThru

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

    if (-not $TUNNEL_URL) {
        Write-Host "[ERROR] Timed out waiting for tunnel URL." -ForegroundColor Red
        Write-Host "        Make sure server is running on port 3000." -ForegroundColor DarkGray
        Write-Host ""
    }
}

# ── Show results ──────────────────────────────────────────────────────────────
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Set this URL in OSMWatcher:" -ForegroundColor White
Write-Host ""

if ($TUNNEL_URL) {
    $WAN_URL = "${TUNNEL_URL}/api/machine-test/osm-status?key=${NEW_KEY}"
    Write-Host "  [WAN - Cloudflare Tunnel]" -ForegroundColor Green
    Write-Host "  $WAN_URL" -ForegroundColor White
    Write-Host ""
    Set-Clipboard -Value $WAN_URL
    Write-Host "[OK] WAN URL copied to clipboard" -ForegroundColor Green
} else {
    $LAN_URL = "http://localhost:3000/api/machine-test/osm-status?key=${NEW_KEY}"
    Write-Host "  [LAN]" -ForegroundColor Yellow
    Write-Host "  $LAN_URL" -ForegroundColor White
    Write-Host ""
    Set-Clipboard -Value $LAN_URL
    Write-Host "[OK] LAN URL copied to clipboard" -ForegroundColor Green
}

Write-Host ""
Write-Host "  NOTE: Restart server to apply new key." -ForegroundColor DarkYellow
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
