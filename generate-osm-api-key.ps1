# generate-osm-api-key.ps1  (重新取得 OSMWatcher Webhook URL)
$ErrorActionPreference = 'Stop'
trap {
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    $ErrorActionPreference = 'Continue'
    Read-Host "Press Enter to close"
    exit 1
}

$Host.UI.RawUI.WindowTitle = 'OSMWatcher Webhook URL'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  OSMWatcher Webhook URL" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── Start Cloudflare Tunnel ───────────────────────────────────────────────────
$CLOUDFLARED = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
Write-Host "Starting Cloudflare Tunnel..." -ForegroundColor Cyan
$logFile = Join-Path $env:TEMP "cf_tunnel_$([System.Guid]::NewGuid().ToString('N')).log"
Start-Process -FilePath $CLOUDFLARED -ArgumentList "tunnel --url http://localhost:3000" -RedirectStandardError $logFile -NoNewWindow

Write-Host "Waiting for URL (up to 60s)..." -ForegroundColor DarkGray
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
    Write-Host "  Make sure server is running on port 3000" -ForegroundColor DarkGray
}
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
