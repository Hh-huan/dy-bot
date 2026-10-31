$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (!(Test-Path '.venv\Scripts\python.exe')) {
  py -3.11 -m venv .venv
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install torch==2.4.0 torchaudio==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu124
& .\.venv\Scripts\python.exe -m pip install "seed-vc[realtime]"

if (!(Test-Path 'reference\pet-voice.wav')) {
  node scripts\make_reference.mjs
}

Write-Host '实时变声环境已就绪。' -ForegroundColor Green
