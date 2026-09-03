[CmdletBinding()]
param(
  [string]$BundleRoot = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  $candidate = $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'app')) -and
      (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $candidate) 'app'))) {
    $candidate = Split-Path -Parent $candidate
  }
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'app')) -and
      (Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $candidate)) 'app'))) {
    $candidate = Split-Path -Parent (Split-Path -Parent $candidate)
  }
  $BundleRoot = $candidate
}
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$failed = $false

function Write-Result([bool]$Ok, [string]$Label, [string]$Detail = '') {
  if ($Ok) {
    Write-Host ("[OK]   {0}{1}" -f $Label, $(if ($Detail) { " - $Detail" } else { '' })) -ForegroundColor Green
  } else {
    Write-Host ("[FAIL] {0}{1}" -f $Label, $(if ($Detail) { " - $Detail" } else { '' })) -ForegroundColor Red
    $script:failed = $true
  }
}

function Test-RequiredPath([string]$RelativePath, [string]$Label) {
  $fullPath = Join-Path $bundle $RelativePath
  $exists = Test-Path -LiteralPath $fullPath
  if ($exists -and -not (Get-Item -LiteralPath $fullPath).PSIsContainer) {
    $exists = (Get-Item -LiteralPath $fullPath).Length -gt 0
  }
  Write-Result $exists $Label $RelativePath
  return $exists
}

Write-Host '=== MeihuaStudio bundle verification ===' -ForegroundColor Cyan
Write-Host ("Bundle: {0}" -f $bundle)

$required = @(
  @('runtime\node\node.exe', 'Portable Node.js'),
  @('app\apps\orchestrator\dist\index.cjs', 'Control service build'),
  @('app\apps\admin\dist\index.html', 'Admin UI build'),
  @('app\apps\overlay\dist\index.html', 'OBS stage build'),
  @('gptsovits\runtime\python.exe', 'Bundled Python runtime'),
  @('gptsovits\api_v3.py', 'GPT-SoVITS V3 API'),
  @('gptsovits\tools\asr\models\openai-whisper\tiny.pt', 'Offline ASR model'),
  @('app\services\voice-asr\transcribe.py', 'Offline ASR service'),
  @('app\services\voice-accent\main.py', 'Target accent service'),
  @('app\services\kokoro-tts\main.py', 'Kokoro local voice service'),
  @('app\services\kokoro-tts\models\kokoro-v1.0.onnx', 'Kokoro ONNX model'),
  @('app\services\kokoro-tts\models\voices-v1.0.bin', 'Kokoro voice pack'),
  @('app\services\musetalk-service\main.py', 'MuseTalk service'),
  @('musetalk\models\musetalkV15\unet.pth', 'MuseTalk V1.5 model'),
  @('musetalk\.python-packages\diffusers', 'MuseTalk Python packages'),
  @('app\tools\ffmpeg\ffmpeg.exe', 'Bundled FFmpeg'),
  @('app\data\meihua-live.db', 'Configured scene database'),
  @('5-源码\源码说明.md', 'Clean full-chain source package'),
  @('5-源码\third_party\GPT-SoVITS\api_v3.py', 'GPT-SoVITS source code'),
  @('5-源码\third_party\MuseTalk\musetalk', 'MuseTalk source code'),
  @('installers\OBS-Studio-32.2.2-Windows-x64-Installer.exe', 'Offline OBS installer'),
  @('installers\VBCABLE_Driver_Pack45.zip', 'Offline VB-CABLE installer'),
  @('0-请先看这里.md', 'Start-here guide'),
  @('1-环境检查与安装.bat', 'Environment setup entry'),
  @('2-启动系统.bat', 'One-click launch entry'),
  @('3-操作攻略.md', 'Operator guide'),
  @('4-TikFinity图文攻略.md', 'TikFinity guide'),
  @('6-真实状态说明.md', 'Truthful implementation status'),
  @('安装工具\01-检查整包.bat', 'Bundle verification entry'),
  @('安装工具\02-检查并安装环境.bat', 'Environment setup entry'),
  @('desktop\MeihuaStudio.exe', 'Desktop launcher alternate name')
)

foreach ($item in $required) {
  if ($item[0] -eq 'desktop\MeihuaStudio.exe') {
    $desktopFound = Get-ChildItem -LiteralPath (Join-Path $bundle 'desktop') -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -gt 50MB } |
      Sort-Object Length -Descending |
      Select-Object -First 1
    Write-Result ($null -ne $desktopFound) 'Desktop launcher' $(if ($desktopFound) { $desktopFound.Name } else { 'desktop executable missing' })
    continue
  }
  Test-RequiredPath $item[0] $item[1] | Out-Null
}

foreach ($materialDirectory in @('media', 'lux3d', 'audio', 'voices')) {
  $materialPath = Join-Path $bundle ("app\data\{0}" -f $materialDirectory)
  $materialCount = @(Get-ChildItem -LiteralPath $materialPath -Recurse -File -ErrorAction SilentlyContinue).Count
  Write-Result ($materialCount -gt 0) ("Material library: {0}" -f $materialDirectory) ("{0} files" -f $materialCount)
}

$nodeExe = Join-Path $bundle 'runtime\node\node.exe'
$orchestratorEntry = Join-Path $bundle 'app\apps\orchestrator\dist\index.cjs'
if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $orchestratorEntry)) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Native stderr (including harmless Node/Python warnings) must not be
    # promoted to a terminating PowerShell error by $ErrorActionPreference.
    $ErrorActionPreference = 'Continue'
    & $nodeExe --check $orchestratorEntry 2>$null | Out-Null
    $nodeSyntaxOk = ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Write-Result $nodeSyntaxOk 'Control service syntax check'
}

$pythonExe = Join-Path $bundle 'gptsovits\runtime\python.exe'
if (Test-Path -LiteralPath $pythonExe) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $pythonExe -c "import whisper, tiktoken, torch; print(torch.__version__)" 2>$null | Out-Null
    $voiceImportsOk = ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Write-Result $voiceImportsOk 'Voice clone and ASR Python imports'

  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = @(
      (Join-Path $bundle 'musetalk\.python-packages'),
      (Join-Path $bundle 'musetalk'),
      (Join-Path $bundle 'musetalk\musetalk\utils')
    ) -join ';'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $pythonExe -c "import torch, diffusers, cv2" 2>$null | Out-Null
      $museImportsOk = ($LASTEXITCODE -eq 0)
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    Write-Result $museImportsOk 'MuseTalk Python imports'
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
}

$ffmpegExe = Join-Path $bundle 'app\tools\ffmpeg\ffmpeg.exe'
if (Test-Path -LiteralPath $ffmpegExe) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $ffmpegExe -version 2>$null | Out-Null
    $ffmpegOk = ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Write-Result $ffmpegOk 'FFmpeg executable check'
}

$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  $gpuName = (& $nvidiaSmi.Source --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
  Write-Host ("[INFO] NVIDIA GPU detected{0}" -f $(if ($gpuName) { ": $gpuName" } else { '' })) -ForegroundColor Cyan
} else {
  Write-Host '[INFO] NVIDIA GPU was not detected. The package can start in CPU mode, but voice/avatar generation will be slow.' -ForegroundColor Yellow
}

$usedPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(3210, 5173, 5200, 9881, 9890, 9898, 9899) } |
  Sort-Object LocalPort
if ($usedPorts) {
  $portText = ($usedPorts.LocalPort | Select-Object -Unique) -join ', '
  Write-Host ("[WARN] Required ports already in use: {0}. Close the previous MeihuaStudio instance before starting another one." -f $portText) -ForegroundColor Yellow
} else {
  Write-Host '[OK]   Required ports are available' -ForegroundColor Green
}

if ($failed) {
  Write-Host 'Bundle verification failed. Re-copy or rebuild the package before use.' -ForegroundColor Red
  exit 1
}

Write-Host 'Bundle verification passed. Run the launcher to start MeihuaStudio.' -ForegroundColor Green
exit 0
