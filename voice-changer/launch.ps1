$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $dir '.venv\Scripts\python.exe'
$health = 'http://127.0.0.1:8790/health'

function Test-Service {
    try {
        $result = Invoke-RestMethod -Uri $health -TimeoutSec 2
        return [bool]$result.ok
    } catch {
        return $false
    }
}

if (-not (Test-Service)) {
    if (-not (Test-Path $python)) {
        Write-Host 'Missing Python environment: run voice-changer/setup.ps1 first.'
        Start-Sleep -Seconds 5
        exit 1
    }
    Start-Process -FilePath $python `
        -ArgumentList 'server.py', '--host', '127.0.0.1', '--port', '8790' `
        -WorkingDirectory $dir -WindowStyle Hidden
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Service) { break }
    }
}

if (-not (Test-Service)) {
    Write-Host 'Voice changer service failed to start. See voice-changer/service.log'
    Start-Sleep -Seconds 5
    exit 1
}

Start-Process 'http://127.0.0.1:8790/panel'
