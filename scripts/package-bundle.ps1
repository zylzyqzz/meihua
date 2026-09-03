[CmdletBinding()]
param(
  [string]$ProjectRoot = 'E:\meihua\meihua-live',
  [string]$GptSoVitsRoot = 'E:\meihua\V3音色包',
  [string]$MuseTalkRoot = 'E:\meihua\MuseTalk',
  [string]$OutRoot = 'E:\meihua\bundle',
  [string]$NodeExe = '',
  [string]$DesktopPath = ''
)
$ErrorActionPreference = 'Stop'

function Copy-Tree([string]$Source, [string]$Destination, [string[]]$ExcludeDirs = @()) {
  $args = @($Source, $Destination, '/E', '/NFL', '/NDL', '/NP', '/R:2', '/W:2')
  foreach ($dir in $ExcludeDirs) { $args += @('/XD', $dir) }
  robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $Source -> $Destination" }
}

function Get-FileCount([string]$Path) {
  return @(
    Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue
  ).Count
}

function Copy-RequiredPayload([string]$Source, [string]$Destination, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "Missing source ${Label}: $Source" }
  $sourceCount = Get-FileCount $Source
  if ($sourceCount -le 0) { throw "Source ${Label} is empty: $Source" }
  Copy-Tree $Source $Destination
  $destinationCount = Get-FileCount $Destination
  if ($destinationCount -ne $sourceCount) {
    throw "Payload copy mismatch for $Label (source=$sourceCount, destination=$destinationCount)"
  }
  Write-Host ("Copied {0}: {1} files" -f $Label, $destinationCount) -ForegroundColor DarkGreen
}

Write-Host '=== 梅花数字人整包打包 ===' -ForegroundColor Green

# 0. 构建产物（保证 dist 最新）
Push-Location $ProjectRoot
try { pnpm build; if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' } } finally { Pop-Location }

$bundle = Join-Path $OutRoot 'MeihuaStudio'
if (Test-Path $bundle) { Remove-Item $bundle -Recurse -Force }
New-Item -ItemType Directory -Path $bundle -Force | Out-Null

# Official offline installers for the two system-level dependencies that cannot live inside the app sandbox.
$installerDir = Join-Path $bundle 'installers'
New-Item -ItemType Directory -Path $installerDir -Force | Out-Null
$obsInstaller = Join-Path $installerDir 'OBS-Studio-32.2.2-Windows-x64-Installer.exe'
$vbCableInstaller = Join-Path $installerDir 'VBCABLE_Driver_Pack45.zip'
Invoke-WebRequest -UseBasicParsing -Uri 'https://cdn-fastly.obsproject.com/downloads/OBS-Studio-32.2.2-Windows-x64-Installer.exe' -OutFile $obsInstaller
Invoke-WebRequest -UseBasicParsing -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile $vbCableInstaller
$installerHashes = @(
  "OBS-Studio-32.2.2-Windows-x64-Installer.exe  $((Get-FileHash -LiteralPath $obsInstaller -Algorithm SHA256).Hash)",
  "VBCABLE_Driver_Pack45.zip  $((Get-FileHash -LiteralPath $vbCableInstaller -Algorithm SHA256).Hash)"
)
Set-Content -LiteralPath (Join-Path $installerDir 'SHA256.txt') -Value $installerHashes -Encoding ASCII

# 1. app：生产运行树（orchestrator cjs + 前端 dist + config + data 骨架）
$app = Join-Path $bundle 'app'
New-Item -ItemType Directory -Path (Join-Path $app 'apps\orchestrator\dist') -Force | Out-Null
Copy-Item (Join-Path $ProjectRoot 'apps\orchestrator\dist\index.cjs') (Join-Path $app 'apps\orchestrator\dist\index.cjs') -Force
Copy-Tree (Join-Path $ProjectRoot 'apps\overlay\dist') (Join-Path $app 'apps\overlay\dist')
Copy-Tree (Join-Path $ProjectRoot 'apps\admin\dist') (Join-Path $app 'apps\admin\dist')
Copy-Tree (Join-Path $ProjectRoot 'config') (Join-Path $app 'config')
Copy-Tree (Join-Path $ProjectRoot 'services\musetalk-service') (Join-Path $app 'services\musetalk-service') @('__pycache__')
Copy-Tree (Join-Path $ProjectRoot 'services\voice-asr') (Join-Path $app 'services\voice-asr') @('__pycache__')
Copy-Tree (Join-Path $ProjectRoot 'services\voice-accent') (Join-Path $app 'services\voice-accent') @('__pycache__')
Copy-Tree (Join-Path $ProjectRoot 'services\kokoro-tts') (Join-Path $app 'services\kokoro-tts') @('__pycache__', 'output')
Copy-Tree (Join-Path $ProjectRoot 'tools\ffmpeg') (Join-Path $app 'tools\ffmpeg')
foreach ($dir in @('data\audio', 'data\media', 'data\voices', 'data\logs', 'data\backups', 'data\secrets')) {
  New-Item -ItemType Directory -Path (Join-Path $app $dir) -Force | Out-Null
}

# 保留当前场景配置与全部素材，但不携带日志、旧备份、本机密钥和临时缓存。
$sourcePython = Join-Path $GptSoVitsRoot 'runtime\python.exe'
& (Join-Path $ProjectRoot 'scripts\package-source.ps1') `
  -ProjectRoot $ProjectRoot `
  -Destination (Join-Path $bundle '5-源码') `
  -PythonExe $sourcePython `
  -GptSoVitsRoot $GptSoVitsRoot `
  -MuseTalkRoot $MuseTalkRoot
if ($LASTEXITCODE -ne 0) { throw 'clean source packaging failed' }
Copy-RequiredPayload (Join-Path $ProjectRoot 'data\media') (Join-Path $app 'data\media') 'media assets'
Copy-RequiredPayload (Join-Path $ProjectRoot 'data\lux3d') (Join-Path $app 'data\lux3d') 'Lux3D assets'
Copy-RequiredPayload (Join-Path $ProjectRoot 'data\audio') (Join-Path $app 'data\audio') 'audio assets'
Copy-RequiredPayload (Join-Path $ProjectRoot 'data\voices') (Join-Path $app 'data\voices') 'voice assets'
$sourceDatabase = Join-Path $bundle '5-源码\data\meihua-live.db'
if (-not (Test-Path -LiteralPath $sourceDatabase) -or (Get-Item -LiteralPath $sourceDatabase).Length -le 0) {
  throw "Packaged scene database is missing or empty: $sourceDatabase"
}
Copy-Item $sourceDatabase (Join-Path $app 'data\meihua-live.db') -Force

# 2. runtime\node：便携 node.exe
$nodeDir = Join-Path $bundle 'runtime\node'
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
if ($NodeExe -and (Test-Path $NodeExe)) {
  Copy-Item $NodeExe (Join-Path $nodeDir 'node.exe') -Force
} else {
  $systemNode = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $systemNode) { throw 'node.exe not found; pass -NodeExe explicitly' }
  Copy-Item $systemNode (Join-Path $nodeDir 'node.exe') -Force
}

# 3. GPT-SoVITS V3：整包复制（大体积，耐心等待）
Write-Host 'Copying GPT-SoVITS (multi-GB)...' -ForegroundColor Cyan
Copy-Tree $GptSoVitsRoot (Join-Path $bundle 'gptsovits')

# 3a. MuseTalk V1.5：代码、模型和隔离依赖一并复制；运行缓存不进发行包。
Write-Host 'Copying MuseTalk V1.5 (multi-GB)...' -ForegroundColor Cyan
$musePackages = Join-Path $MuseTalkRoot '.python-packages'
if (-not (Test-Path -LiteralPath $musePackages)) { throw 'MuseTalk runtime packages are missing. Run scripts/install-musetalk-runtime.ps1 first.' }
Copy-Tree $MuseTalkRoot (Join-Path $bundle 'musetalk') @('results', '__pycache__', '.git')

# 3b. OpenVoice model/runtime is optional at source-build time but the service
# boundary is always shipped so missing CUDA/assets are reported truthfully.
$openVoiceRoot = Join-Path $ProjectRoot 'openvoice'
if (Test-Path -LiteralPath $openVoiceRoot) { Copy-Tree $openVoiceRoot (Join-Path $bundle 'openvoice') }

# 3c. tikfinity：可选，检测到本机安装则一并打入（目标机免安装；账号仍需登录一次）
$tikFinityDir = Join-Path $env:LOCALAPPDATA 'Programs\tikfinity'
if (Test-Path (Join-Path $tikFinityDir 'TikFinity.exe')) {
  Write-Host 'Copying TikFinity (live event capture)...' -ForegroundColor Cyan
  Copy-Tree $tikFinityDir (Join-Path $bundle 'tikfinity')
} else {
  Write-Host 'TikFinity not found locally - bundle will ship without it (manual install on target machine).' -ForegroundColor Yellow
}

# 3b. desktop：梅花中控桌面客户端（win-unpacked，先构建保证最新）
if (-not $DesktopPath) { $DesktopPath = Join-Path $ProjectRoot 'apps\desktop\release\win-unpacked' }
$desktopExe = Join-Path $DesktopPath '梅花中控.exe'
$desktopSource = Join-Path $ProjectRoot 'apps\desktop\main.cjs'
$desktopNeedsBuild = -not (Test-Path -LiteralPath $desktopExe)
if (-not $desktopNeedsBuild -and (Test-Path -LiteralPath $desktopSource)) {
  # The launcher contains the bundle-root and FFmpeg environment fixes.  Do
  # not silently ship an old .exe simply because an earlier build exists.
  $desktopNeedsBuild = (Get-Item -LiteralPath $desktopSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $desktopExe).LastWriteTimeUtc
}
if ($desktopNeedsBuild) {
  Write-Host 'Building updated desktop client (梅花中控.exe)...' -ForegroundColor Cyan
  Push-Location (Join-Path $ProjectRoot 'apps\desktop')
  try { pnpm dist:dir; if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' } } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $desktopExe)) { throw "Desktop exe not found: $DesktopPath" }
Copy-Tree $DesktopPath (Join-Path $bundle 'desktop')

# 4. 启动器与说明
$toolsDirectory = Join-Path $bundle '安装工具'
$internalToolsDirectory = Join-Path $toolsDirectory '内部'
New-Item -ItemType Directory -Path $internalToolsDirectory -Force | Out-Null
Copy-Item (Join-Path $ProjectRoot 'scripts\verify-bundle.ps1') (Join-Path $internalToolsDirectory '整包自检.ps1') -Force
Copy-Item (Join-Path $ProjectRoot 'scripts\setup-assistant.ps1') (Join-Path $internalToolsDirectory '环境助手.ps1') -Force
Copy-Item (Join-Path $ProjectRoot 'scripts\start-bundle-silent.ps1') (Join-Path $internalToolsDirectory '静默启动.ps1') -Force
Copy-Item (Join-Path $ProjectRoot 'scripts\resolve-gpu-profile.ps1') (Join-Path $internalToolsDirectory 'resolve-gpu-profile.ps1') -Force

$verifyBat = @"
@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0内部\整包自检.ps1" -BundleRoot "%~dp0.."
echo.
pause
"@
Set-Content -Path (Join-Path $toolsDirectory '01-检查整包.bat') -Value $verifyBat -Encoding UTF8

$environmentBat = @"
@echo off
rem Runs quietly in the background.  OBS is silent; VB-CABLE deliberately
rem shows its official admin prompt because Windows cannot install a driver
rem safely without it.
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0内部\环境助手.ps1" -BundleRoot "%~dp0.." -AutoInstall
exit /b 0
"@
Set-Content -Path (Join-Path $toolsDirectory '02-检查并安装环境.bat') -Value $environmentBat -Encoding UTF8

$launchBat = @"
@echo off
setlocal
cd /d %~dp0

set "MEIHUA_STUDIO_ROOT=%~dp0"

rem 优先启动桌面客户端：它会自动拉起声音克隆(9881) / 目标口音(9899) / 视频数字人(9898) / 梅花中控(3210+5173+5200)，
rem 托盘常驻，窗口关闭后可从托盘重新打开。
if exist desktop\梅花中控.exe (
  start "" desktop\梅花中控.exe
  exit /b 0
)

rem 兜底：无桌面端时回退为浏览器模式（同目录 app/ 结构）
set MEIHUA_PROJECT_ROOT=%~dp0app
set MEIHUA_PRODUCTION=1

rem 自动拉起 TikFinity（若打包内含）
if exist tikfinity\TikFinity.exe (
  set "NO_PROXY=%NO_PROXY%,tikfinity.zerody.one,tikfinity-origin.zerody.one"
  tasklist /FI "IMAGENAME eq TikFinity.exe" | find /I "TikFinity.exe" >nul || start "" tikfinity\TikFinity.exe
)

start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0安装工具\内部\静默启动.ps1" -BundleRoot "%~dp0."
exit /b 0
"@
Set-Content -Path (Join-Path $bundle '2-启动系统.bat') -Value $launchBat -Encoding UTF8

$installBat = @"
@echo off
setlocal
cd /d %~dp0
rem First-run dependency check and installation happens without a PowerShell
rem window.  Only required Windows/UAC installer dialogs remain visible.
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0安装工具\内部\环境助手.ps1" -BundleRoot "%~dp0." -AutoInstall %*
exit /b 0
"@
Set-Content -Path (Join-Path $bundle '1-环境检查与安装.bat') -Value $installBat -Encoding UTF8

$readme = @"
# 梅花数字人直播一体包（MeihuaStudio）

## 一键使用（目标机：Windows + NVIDIA GPU）
1. 解压本目录到任意盘（建议 NVMe 盘）。
2. （首次）双击 `1-环境检查与安装.bat` - 检查并补齐显卡驱动、OBS、VB-CABLE、TikFinity、声音、数字人、模型与中控文件。
3. 双击 `2-启动系统.bat` - 打开梅花中控桌面客户端（托盘常驻；未检测到桌面端时自动回退浏览器模式）。
   桌面客户端会自动拉起声音克隆(9881) / 目标口音(9899) / 视频数字人(9898) / 梅花中控(3210+5173+5200)。
4. 「数字人中心」按三步操作：选择语言并克隆声音、上传人物视频、选择人物和声音后启用。每次测算播报时自动生成对应声音和口型。
5. OBS：只添加浏览器源 http://127.0.0.1:5173/obs/source/meihua-stage (1080x1920)，声音只从 VB-CABLE 音频总线进入。
6. 按 `4-TikFinity图文攻略.md` 登录、绑定直播间并完成评论/点赞/礼物实播验证。
7. 正式开播前跑完OBS 60分钟录制与TikFinity实播验收。

## 目录
- desktop\     梅花中控 桌面客户端（Electron，含迷你浏览器窗口与托盘）
- app\         梅花中控生产运行树（MEIHUA_PROJECT_ROOT 指向此处）
- runtime\node\  便携 Node 运行时
- gptsovits\  GPT-SoVITS 声音克隆（MIT）
- musetalk\   MuseTalk V1.5 视频数字人与完整模型（MIT）
- app\tools\ffmpeg\  内置媒体处理组件

## 常见问题
- 根目录只需按数字顺序操作：先看0，再运行1和2；3、4是使用攻略；5是完整源码；6是真实开发状态。
- 桌面端窗口关闭后程序仍在托盘：右键托盘图标「退出」才会停止全家服务。
- 想直接用浏览器后台：运行 app\apps\orchestrator\dist\index.cjs（设置 MEIHUA_PRODUCTION=1）后访问 http://127.0.0.1:5200/。
"@
Copy-Item (Join-Path $ProjectRoot 'docs\START-HERE.md') (Join-Path $bundle '0-请先看这里.md') -Force
Copy-Item (Join-Path $ProjectRoot 'docs\PERSONAL-OPERATOR-GUIDE.md') (Join-Path $bundle '3-操作攻略.md') -Force
Copy-Item (Join-Path $ProjectRoot 'docs\TIKFINITY-GUIDE.md') (Join-Path $bundle '4-TikFinity图文攻略.md') -Force
Copy-Item (Join-Path $ProjectRoot 'docs\POST-INSTALL-CHECK.md') (Join-Path $bundle '5-安装后检查.md') -Force
Copy-Tree (Join-Path $ProjectRoot 'docs\教程图片') (Join-Path $bundle '教程图片')
Copy-Item (Join-Path $ProjectRoot 'docs\DIGITAL-HUMAN-CENTER-STATUS.md') (Join-Path $bundle '6-真实状态说明.md') -Force
Copy-Item (Join-Path $ProjectRoot 'docs\VOICE-DIGITAL-HUMAN-API.md') (Join-Path $bundle '7-声音数字人API文档.md') -Force

$size = (Get-ChildItem $bundle -Recurse | Measure-Object Length -Sum).Sum / 1GB
Write-Host ("Bundle ready: {0} ({1:N1} GB)" -f $bundle, $size) -ForegroundColor Green
Write-Host "可选：Compress-Archive 或用 7z 打包 MeihuaStudio 目录分发给直播机。"
# Robocopy returns 1 when files were copied successfully.  Do not leak that
# success code as a failed release after every payload check has passed.
exit 0
