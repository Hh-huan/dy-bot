# Start the local DY live companion service controller if it is not running.
# The controller owns the bridge process and can stop/start it from the extension.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node -or -not (Test-Path -LiteralPath $node)) { exit 1 }

$control = Get-NetTCPConnection -LocalPort 8786 -State Listen -ErrorAction SilentlyContinue
if ($control) { exit 0 }

$outLog = Join-Path $root 'bridge\control.out.log'
$errLog = Join-Path $root 'bridge\control.err.log'
try {
  Start-Process -FilePath $node `
    -ArgumentList @((Join-Path $root 'bridge\control.mjs')) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog
} catch {
  $_ | Out-File -FilePath $errLog -Append -Encoding utf8
  exit 1
}