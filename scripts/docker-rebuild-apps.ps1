# Rebuild and restart Basefyio app images (admin-ui + platform-api).
# Run from repo root:  pwsh ./scripts/docker-rebuild-apps.ps1
# Or from scripts/:    pwsh ./docker-rebuild-apps.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building admin-ui and platform-api..." -ForegroundColor Cyan
docker compose build admin-ui platform-api
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Recreating containers (dependencies unchanged)..." -ForegroundColor Cyan
docker compose up -d --no-deps admin-ui platform-api
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done. Latest images are running. Hard-refresh the browser (Ctrl+F5)." -ForegroundColor Green
