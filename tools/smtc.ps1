param(
  [ValidateSet('query', 'play', 'pause', 'playpause', 'next', 'prev')]
  [string]$Action = 'query',
  [switch]$Json
)
# 被 Node 以管道方式调用时默认用系统代码页（GBK），中文歌名会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$target = $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'cloudmusic' } | Select-Object -First 1

if ($target -and $Action -ne 'query') {
  switch ($Action) {
    'play'      { $target.TryPlayAsync() | Out-Null }
    'pause'     { $target.TryPauseAsync() | Out-Null }
    'playpause' { $target.TryTogglePlayPauseAsync() | Out-Null }
    'next'      { $target.TrySkipNextAsync() | Out-Null }
    'prev'      { $target.TrySkipPreviousAsync() | Out-Null }
  }
  Start-Sleep -Milliseconds 700
  $target = $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'cloudmusic' } | Select-Object -First 1
}

$rows = @()
foreach ($s in $manager.GetSessions()) {
  $p = $s.GetPlaybackInfo()
  $title = ''
  $artist = ''
  try {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($props) {
      $title = $props.Title
      $artist = $props.Artist
    }
  } catch {}
  $rows += [pscustomobject]@{
    app    = $s.SourceAppUserModelId
    title  = $title
    artist = $artist
    status = [string]$p.PlaybackStatus
  }
}

if ($Json) {
  $payloadText = '[' + (($rows | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']'
  # PowerShell 管道到 Node 会走系统代码页，中文必乱码 → 用 base64 传输
  Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payloadText)))
  exit
}
if (-not $rows -or $rows.Count -eq 0) { Write-Output 'NO-MEDIA-SESSION'; exit }
foreach ($r in $rows) {
  Write-Output ("app=" + $r.app + " | title=" + $r.title + " | artist=" + $r.artist + " | status=" + $r.status)
}
