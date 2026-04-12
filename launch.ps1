# launch.ps1
Write-Host "CLEANING UP PORT 5173 AND 8000..." -ForegroundColor Cyan
./kill-ports.ps1
Start-Sleep -Seconds 2 # Extra grace for the OS

Write-Host "STARTING VITE ENGINE AND ELECTRON DASHBOARD..." -ForegroundColor Yellow
# Using local bin to avoid npx fetch latency or confusion
$bin = "./node_modules/.bin/concurrently"
if (Test-Path $bin) {
    & $bin --kill-others "npm run vite" "npm run electron-start"
} else {
    npx concurrently --kill-others "npx vite" "npx wait-on http://localhost:5173 && npx electron ."
}
