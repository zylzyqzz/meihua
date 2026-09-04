[CmdletBinding()]
param(
  [string]$Python = '',
  [int]$Port = 9898,
  [string]$AvatarId = 'default'
)
$ErrorActionPreference = 'Stop'
$serviceDir = Join-Path $PSScriptRoot '..\services\musetalk-service'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$museTalkRoot = if ($env:MUSETALK_HOME) { $env:MUSETALK_HOME } else { Join-Path $projectRoot 'external\musetalk' }
$required = @(
  'scripts\realtime_inference.py',
  'models\musetalkV15\unet.pth',
  'models\musetalkV15\musetalk.json',
  'models\whisper\config.json',
  'models\whisper\preprocessor_config.json',
  'models\whisper\pytorch_model.bin',
  'models\sd-vae\config.json',
  'models\sd-vae\diffusion_pytorch_model.bin',
  'models\dwpose\dw-ll_ucoco_384.pth',
  'models\face-parse-bisent\79999_iter.pth',
  'models\face-parse-bisent\resnet18-5c106cde.pth'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $museTalkRoot $_)) })
if ($missing.Count) { throw "MuseTalk 底座不完整，缺少：$($missing -join ', ')" }
if (-not $Python) {
  $bundledCandidates = @(
    $env:MUSETALK_PYTHON,
    (Join-Path $museTalkRoot '.venv\Scripts\python.exe'),
    (Join-Path $projectRoot 'tools\python\python.exe'),
    'E:\meihua\V3音色包\runtime\python.exe'
  )
  $bundledPython = $bundledCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($bundledPython) {
    $Python = $bundledPython
  } else {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if (-not $command) { throw 'MuseTalk Python 环境未安装或未加入 PATH。' }
    $Python = $command.Source
  }
}
$runtimePackages = Join-Path $museTalkRoot '.python-packages'
$pythonPaths = @($runtimePackages, $museTalkRoot, (Join-Path $museTalkRoot 'musetalk\utils'))
if ($env:PYTHONPATH) { $pythonPaths += $env:PYTHONPATH }
$env:PYTHONPATH = $pythonPaths -join [IO.Path]::PathSeparator
$env:MUSETALK_PYTHONPATH = $runtimePackages
$env:MUSETALK_PYTHON = $Python
$env:MEIHUA_FFMPEG_PATH = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\tools\ffmpeg')).Path
$dependencyCheck = & $Python -c "import fastapi, uvicorn, torch, cv2, transformers, diffusers, torchvision, mmcv, mmengine, mmdet, mmpose, face_detection; print('CUDA' if torch.cuda.is_available() else 'CPU')" 2>$null | Select-Object -Last 1
if ($dependencyCheck -notin @('CUDA', 'CPU')) { throw 'MuseTalk Python 依赖不完整，请先运行 scripts/install-musetalk-runtime.ps1。' }
$gpuProfileScript = Join-Path $PSScriptRoot 'resolve-gpu-profile.ps1'
if (Test-Path -LiteralPath $gpuProfileScript) {
  # A visible NVIDIA card is not enough: if this Python runtime cannot see
  # CUDA, force the conservative CPU profile instead of inheriting a stale
  # high-VRAM profile from an outer launcher.
  if ($dependencyCheck -eq 'CPU') { $env:MEIHUA_GPU_PROFILE = 'CPU_COMPAT' }
  . $gpuProfileScript
  $gpuProfile = Set-MeihuaGpuRuntimeEnvironment
  Write-Host ("GPU runtime profile: {0} ({1})" -f $gpuProfile.Id, $gpuProfile.Description) -ForegroundColor Cyan
} else {
  $env:MUSETALK_BATCH_SIZE = '1'
}
$env:MUSETALK_HOME = $museTalkRoot
Write-Host "Starting MuseTalk rendering service on port $Port ($dependencyCheck mode; batch $env:MUSETALK_BATCH_SIZE; default avatar label: $AvatarId)." -ForegroundColor Green
& $Python (Join-Path $serviceDir 'main.py') --port $Port
