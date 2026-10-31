#Requires -Version 5.1
<#
  dy-bot 一键准备（开播前跑一次）

  用法：
    powershell -ExecutionPolicy Bypass -File tools/quick-start.ps1
    powershell -ExecutionPolicy Bypass -File tools/quick-start.ps1 -Room https://live.douyin.com/123456
    powershell -ExecutionPolicy Bypass -File tools/quick-start.ps1 -CheckOnly

  做的事：检查 Node 版本 -> 启动本地桥接（8787）-> 打开背景板 / 扩展管理页 / 直播间。
  不能替你做的一步：在 chrome://extensions 里点「加载已解压的扩展程序」并选中 extension 目录（浏览器不允许脚本代点）。
#>
param(
  [string]$Room = "",
  [switch]$CheckOnly,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BridgeUrl = "http://127.0.0.1:8787"
$Errors = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow; $Warnings.Add($text) }
function Write-Err($text) { Write-Host "  [失败] $text" -ForegroundColor Red; $Errors.Add($text) }

Write-Step "1/4 检查运行环境"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err "没有找到 Node.js。装 Node.js 22 LTS 后重开终端：https://nodejs.org/"
} else {
  $nodeVersion = (& $node.Source -p "process.versions.node").Trim()
  $major = [int]($nodeVersion.Split(".")[0])
  if ($major -lt 20) {
    Write-Err "Node.js 版本 $nodeVersion 太低，需要 20 以上（推荐 22 LTS）。"
  } else {
    Write-Ok "Node.js $nodeVersion"
  }
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
  Write-Ok "浏览器：$chrome"
} else {
  Write-Warn2 "没找到 Chrome / Edge。扩展需要 Chrome 或 Edge 116 以上，请先安装。"
}

Write-Step "2/4 检查桥接服务（8787）"

function Test-Bridge {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BridgeUrl/api/board/state" -TimeoutSec 2
    return ($resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (Test-Bridge) {
  Write-Ok "桥接已在运行：$BridgeUrl"
} else {
  if ($CheckOnly) {
    Write-Warn2 "桥接没在运行（-CheckOnly 模式不启动）。开播前去掉 -CheckOnly 再跑一次。"
  } elseif (-not $node) {
    Write-Err "没有 Node.js，无法启动桥接。装好 Node.js 22 LTS 后重跑。"
  } else {
    Write-Host "  正在启动桥接 ..."
    Start-Process -FilePath $node.Source -ArgumentList "bridge/server.mjs" -WorkingDirectory $Root -WindowStyle Hidden
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 250
      if (Test-Bridge) { $ok = $true; break }
    }
    if ($ok) {
      Write-Ok "桥接已启动：$BridgeUrl"
    } else {
      Write-Err "桥接启动失败。手动运行：cd `"$Root`"; node bridge/server.mjs 看报错（常见是 8787 被占用）。"
    }
  }
}

Write-Step "3/4 打开需要的页面"

if ($CheckOnly -or $NoOpen) {
  Write-Host "  （-CheckOnly / -NoOpen：不打开浏览器页面）"
} elseif ($chrome) {
  $extUrl = if ($chrome -match "msedge") { "edge://extensions" } else { "chrome://extensions" }
  Start-Process $chrome "`"$extUrl`""
  Start-Sleep -Milliseconds 600
  Start-Process $chrome "`"$BridgeUrl/board`""
  if ($Room) {
    Start-Sleep -Milliseconds 600
    Start-Process $chrome "`"$Room`""
    Write-Ok "已打开：扩展管理页 / 背景板 / $Room"
  } else {
    Write-Warn2 "没传 -Room，直播间请自己打开。下次可加：-Room https://live.douyin.com/你的房间号"
  }
}

Write-Step "4/4 开播清单（每一项都要打勾）"

Write-Host @"

  [ ] 扩展已加载：chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> 选中 $Root\extension
  [ ] 主播账号已登录网页版抖音，直播间页面已刷新
  [ ] 侧边栏已绑定直播间，显示绿色「已连接 · 我的直播间」
  [ ] 首次先开「演练模式」，确认规则/AI 文案没问题后再关掉
  [ ] 全局发送间隔 >= 3 秒，每分钟回复 <= 12，同用户 <= 3
  [ ] AI 回复：填好 API Key 与模型；不想用 AI 就保持关闭
  [ ] 桌宠联动：设置 -> DSH 桌宠联动 -> 启用 -> 地址 http://127.0.0.1:64864 -> 宠物 ID main -> 测试气泡
  [ ] 背景板：设置 -> 直播背景板 -> 启用 -> 复制 OBS 地址；OBS 浏览器源 1920x1080
  [ ] 点歌：启用后试一句「点歌 晴天」，确认 QQ 音乐有反应
  [ ] 只保留一个助手页面（侧边栏或独立标签页二选一），避免重复回复

"@ -ForegroundColor Gray

if ($Errors.Count -gt 0) {
  Write-Host "`n有 $($Errors.Count) 个问题需要先解决：" -ForegroundColor Red
  $Errors | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "`n准备完成。桥接地址：$BridgeUrl" -ForegroundColor Green
Write-Host "背景板 16:9：$BridgeUrl/board    竖屏：$BridgeUrl/board/vertical" -ForegroundColor Green
if ($Warnings.Count -gt 0) {
  Write-Host "有 $($Warnings.Count) 条提醒，确认后再开播。" -ForegroundColor Yellow
}
