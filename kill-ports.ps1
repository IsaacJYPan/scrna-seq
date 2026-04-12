$ports = 5173, 8000
foreach ($port in $ports) {
    try {
        $found = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Closed' }
        if ($found) {
            foreach ($f in $found) {
                Write-Host "Killing process $($f.OwningProcess) on port $port"
                # Ensure we don't kill our own process
                if ($f.OwningProcess -ne $PID) {
                    Stop-Process -Id $f.OwningProcess -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {
        Write-Warning "Could not kill port $port"
    }
}
# Only kill Rscript.exe (it's safe)
taskkill /F /IM Rscript.exe /T 2>$null
# DO NOT kill node.exe generically as it kills the runner itself!
exit 0
