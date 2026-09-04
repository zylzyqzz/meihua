[CmdletBinding()]
param(
  [string]$ProjectRoot = 'E:\meihua\meihua-live',
  [Parameter(Mandatory = $true)]
  [string]$Destination,
  [string]$PythonExe = 'python',
  [string]$RuntimeDataRoot = '',
  [string]$GptSoVitsRoot = '',
  [string]$MuseTalkRoot = ''
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($RuntimeDataRoot)) { $RuntimeDataRoot = Join-Path $project 'data' }
$runtimeData = (Resolve-Path -LiteralPath $RuntimeDataRoot).Path
$destinationFull = [System.IO.Path]::GetFullPath($Destination)
if ($destinationFull.StartsWith($project + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Destination must be outside the source project to prevent recursive packaging.'
}

function Copy-CleanTree([string]$Source, [string]$Target, [string[]]$ExcludeDirs = @()) {
  if (-not (Test-Path -LiteralPath $Source)) { return }
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  $arguments = @($Source, $Target, '/E', '/NFL', '/NDL', '/NP', '/R:2', '/W:2')
  foreach ($excluded in $ExcludeDirs) { $arguments += @('/XD', $excluded) }
  robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $Source -> $Target" }
}

function Export-SqliteDatabase([string]$Source, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Source)) { return }
  $pythonCommand = Get-Command $PythonExe -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw "Python runtime not found for consistent SQLite export: $PythonExe" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
  $code = @'
import sqlite3
import sys

source, target = sys.argv[1], sys.argv[2]
with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
    with sqlite3.connect(target) as target_db:
        source_db.backup(target_db)
'@
  $encodedCode = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
  & $pythonCommand.Source -c "import base64;exec(base64.b64decode('$encodedCode'))" $Source $Target
  if ($LASTEXITCODE -ne 0) { throw 'SQLite backup failed' }
}

if (Test-Path -LiteralPath $destinationFull) {
  $resolvedParent = (Resolve-Path -LiteralPath (Split-Path -Parent $destinationFull)).Path
  if (-not $destinationFull.StartsWith($resolvedParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe destination: $destinationFull"
  }
  Remove-Item -LiteralPath $destinationFull -Recurse -Force
}
New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null

$generatedDirs = @('node_modules', 'dist', 'release', '.vite', 'coverage', '.cache', 'out', '__pycache__')
foreach ($directory in @('apps', 'packages', 'services', 'scripts', 'config', 'docs', 'tests')) {
  Copy-CleanTree (Join-Path $project $directory) (Join-Path $destinationFull $directory) $generatedDirs
}

# Product assets are intentionally preserved. These are source-controlled or administrator-owned materials.
Copy-CleanTree (Join-Path $project 'assets') (Join-Path $destinationFull 'assets') @('__pycache__')

# Keep the runnable media tools but omit the duplicate compressed archive.
$sourceFfmpeg = Join-Path $project 'tools\ffmpeg\ffmpeg.exe'
$targetTools = Join-Path $destinationFull 'tools\ffmpeg'
New-Item -ItemType Directory -Path $targetTools -Force | Out-Null
if (Test-Path -LiteralPath $sourceFfmpeg) { Copy-Item -LiteralPath $sourceFfmpeg -Destination (Join-Path $targetTools 'ffmpeg.exe') -Force }

# Preserve the current configured scene and all user-facing materials. Exclude secrets, logs, caches and old backups.
$sourceData = $runtimeData
$targetData = Join-Path $destinationFull 'data'
New-Item -ItemType Directory -Path $targetData -Force | Out-Null
foreach ($materialDirectory in @('media', 'lux3d', 'audio', 'voices')) {
  Copy-CleanTree (Join-Path $sourceData $materialDirectory) (Join-Path $targetData $materialDirectory) @('__pycache__')
}
Export-SqliteDatabase (Join-Path $sourceData 'meihua-live.db') (Join-Path $targetData 'meihua-live.db')
foreach ($runtimeDirectory in @('logs', 'backups', 'tmp', 'tmp-avatar-review', 'secrets')) {
  New-Item -ItemType Directory -Path (Join-Path $targetData $runtimeDirectory) -Force | Out-Null
}

foreach ($file in @(
  '.env.example', '.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'README.md', 'THIRD_PARTY_NOTICES.md', 'tsconfig.base.json'
)) {
  $sourceFile = Join-Path $project $file
  if (Test-Path -LiteralPath $sourceFile) { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $destinationFull $file) -Force }
}

# Include source code for every local AI stage without duplicating multi-gigabyte runtimes and weights.
$thirdPartyRoot = Join-Path $destinationFull 'third_party'
if ($GptSoVitsRoot -and (Test-Path -LiteralPath $GptSoVitsRoot)) {
  Copy-CleanTree $GptSoVitsRoot (Join-Path $thirdPartyRoot 'GPT-SoVITS') @(
    'runtime', 'pretrained_models', 'G2PWModel', 'models', 'output', 'outputs', 'logs', '__pycache__', '.git'
  )
}
if ($MuseTalkRoot -and (Test-Path -LiteralPath $MuseTalkRoot)) {
  Copy-CleanTree $MuseTalkRoot (Join-Path $thirdPartyRoot 'MuseTalk') @(
    '.python-packages', 'models', 'results', 'logs', '__pycache__', '.git'
  )
}
$thirdPartyNotice = @'
# 第三方环节说明

- `GPT-SoVITS/`：声音克隆开源底座源码。完整Python运行时和模型在一体包根目录 `gptsovits/`。
- `MuseTalk/`：数字人口型开源底座源码。完整依赖和模型在一体包根目录 `musetalk/`。
- TikFinity：第三方闭源软件，没有可分发源码。若打包电脑已安装，官方程序位于一体包根目录 `tikfinity/`；操作见根目录 `4-TikFinity图文攻略.md`。
- FFmpeg：媒体转码工具，运行文件位于 `tools/ffmpeg/ffmpeg.exe`。

上游地址：

- GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>
- MuseTalk：<https://github.com/TMElyralab/MuseTalk>
- TikFinity：<https://tikfinity.zerody.one/app/>
'@
Set-Content -LiteralPath (Join-Path $thirdPartyRoot 'README.md') -Value $thirdPartyNotice -Encoding UTF8

$sourceGuide = @'
# 梅花直播系统源码

这是经过整理的完整源码，不包含可重新生成的臃肿内容。

## 保留内容

- `apps/`：后台、OBS 舞台、中控服务和桌面端源代码。
- `packages/`：共享类型、规则、适配器和场景渲染逻辑。
- `services/`：离线语音识别和 MuseTalk 服务代码。
- `third_party/GPT-SoVITS`：声音克隆底座源码；运行环境和模型位于一体包上一级的 `gptsovits/`。
- `third_party/MuseTalk`：数字人口型底座源码；运行依赖和模型位于一体包上一级的 `musetalk/`。
- TikFinity是第三方闭源程序，不存在可整理进来的源码；整包保留官方程序和完整图文操作攻略。
- `assets/`：项目原始素材，完整保留。
- `data/media`、`data/lux3d`、`data/audio`、`data/voices`：当前素材库内容。
- `data/meihua-live.db`：当前场景、声音、人物和业务配置的安全快照。
- `scripts/`、`docs/`、`config/`：安装、打包、说明和配置。

## 已排除内容

- `node_modules`、`dist`、`release`、Vite 缓存和测试覆盖率文件。
- 验收截图、临时转码、运行日志、历史数据库备份和本机密钥。
- FFmpeg 的重复压缩包，仅保留实际使用的 `ffmpeg.exe`。
- GPT-SoVITS和MuseTalk的Python运行时、模型权重没有在源码目录重复存放；完整运行副本已经位于一体包根目录。

## 本地开发

1. 安装 Node.js 20+ 与 pnpm。
2. 在本目录执行 `pnpm install`。
3. 执行 `pnpm typecheck` 和 `pnpm test`。
4. 执行 `pnpm dev` 启动开发环境。
5. 生成一体包时执行 `scripts/package-bundle.ps1`。

普通使用者无需进入本目录，直接返回上一级并按 `0-请先看这里.md` 操作。
'@
Set-Content -LiteralPath (Join-Path $destinationFull '源码说明.md') -Value $sourceGuide -Encoding UTF8

$measurement = Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Force | Measure-Object Length -Sum
Write-Host ("Clean source package ready: {0} ({1} files, {2:N2} GB)" -f $destinationFull, $measurement.Count, ($measurement.Sum / 1GB)) -ForegroundColor Green
exit 0
