# Remove the Startup watchdog.
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'DYLiveCompanionBridge.vbs'
Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
  Where-Object { $_.CommandLine -like '*DYLiveCompanionBridge.vbs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Removed Startup watchdog: $target"
