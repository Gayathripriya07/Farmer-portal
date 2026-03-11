param(
  [int]$PortalPort = 5500,
  [int]$SmsPort = 8787
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-PortOpen([int]$Port) {
  try {
    return [bool](Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -InformationLevel Quiet)
  } catch {
    return $false
  }
}

if (Test-PortOpen $SmsPort) {
  Write-Host "Authority SMS server already running on port $SmsPort (skipping start)" -ForegroundColor Yellow
} else {
  Write-Host "Starting Authority SMS server on http://localhost:$SmsPort ..." -ForegroundColor Cyan
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd `"$root`"; `$env:PORT=$SmsPort; node authority-sms-server.js"
  )
}

if (Test-PortOpen $PortalPort) {
  Write-Host "Portal server already running on port $PortalPort (skipping start)" -ForegroundColor Yellow
} else {
  Write-Host "Starting static server on http://localhost:$PortalPort ..." -ForegroundColor Cyan
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd `"$root`"; `$env:PORT=$PortalPort; node static-server.js"
  )
}

Start-Sleep -Seconds 1
Write-Host "Opening portal..." -ForegroundColor Green
Start-Process "http://localhost:$PortalPort/index.html"

Write-Host ""
Write-Host "Done. Keep both server terminals open." -ForegroundColor Yellow
Write-Host "Health check: http://localhost:$SmsPort/api/health" -ForegroundColor Yellow
