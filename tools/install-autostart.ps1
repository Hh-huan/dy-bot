# Install a per-user Startup watchdog that keeps bridge/server.mjs running.
# Run once: powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
$ErrorActionPreference = 'Stop'
$watch = Join-Path $PSScriptRoot 'start-bridge-watch.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'DYLiveCompanionBridge.vbs'
Copy-Item -LiteralPath $watch -Destination $target -Force
Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$target`"") -WindowStyle Hidden
Write-Host "Installed Startup watchdog: $target"
Write-Host "It checks the bridge every minute and starts it if needed."
Write-Host "Log: $(Split-Path -Parent $PSScriptRoot)\bridge\autostart.log"
