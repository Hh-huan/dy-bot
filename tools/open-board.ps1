# Open the OBS/background board in a dedicated Chromium window with background
# throttling disabled. Run once; keep using that window.
$ErrorActionPreference = 'SilentlyContinue'
$url = 'http://127.0.0.1:8787/board/board.html?pet=center'
$profile = Join-Path $env:LOCALAPPDATA 'dy-live-board-profile'
$flags = @(
  '--new-window',
  "--user-data-dir=$profile",
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--use-fake-ui-for-media-stream',
  $url
)
$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
)
$browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList $flags
  Write-Host "Board opened with background throttling disabled."
} else {
  Start-Process $url
  Write-Host "Edge/Chrome not found; opened in default browser (flags not applied)."
}
