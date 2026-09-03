[CmdletBinding()]
param(
  [string]$MuseTalkRoot = 'E:\meihua\MuseTalk',
  [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

if (-not (Test-Path -LiteralPath (Join-Path $MuseTalkRoot 'scripts\realtime_inference.py'))) {
  throw "MuseTalk source is missing: $MuseTalkRoot"
}

if (-not $Python) {
  $candidates = @(
    (Join-Path $projectRoot 'tools\python\python.exe'),
    'E:\meihua\V3音色包\runtime\python.exe'
  )
  $Python = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python)) {
  throw 'Python 3.10 runtime is missing. Place the bundled runtime at tools\python or install the GPT-SoVITS package first.'
}

$target = Join-Path $MuseTalkRoot '.python-packages'
New-Item -ItemType Directory -Force -Path $target | Out-Null

Write-Host 'Installing portable MuseTalk runtime packages...' -ForegroundColor Cyan
& $Python -m pip install --disable-pip-version-check --no-input --upgrade --no-deps --target $target `
  torchvision==0.17.2 --index-url https://download.pytorch.org/whl/cu118
if ($LASTEXITCODE -ne 0) { throw 'Failed to install torchvision.' }

& $Python -m pip install --disable-pip-version-check --no-input --upgrade --no-deps --target $target `
  opencv-python==4.9.0.80 diffusers==0.30.2 accelerate==0.28.0 `
  mmengine==0.10.7 mmcv-lite==2.0.1 mmdet==3.1.0 mmpose==1.1.0 `
  imageio==2.37.0 imageio-ffmpeg==0.6.0 moviepy==1.0.3 `
  rich==13.9.4 pygments==2.19.2 importlib-metadata==8.7.0 zipp==3.23.0 `
  shapely==2.0.7 terminaltables==3.1.10 termcolor==2.5.0 chumpy==0.70 `
  json-tricks==3.17.3 munkres==1.1.4 xtcocotools==1.14.3 `
  proglog==0.1.12 decorator==4.4.2
if ($LASTEXITCODE -ne 0) { throw 'Failed to install MuseTalk dependencies.' }

$sfdWeight = Join-Path $MuseTalkRoot 'musetalk\utils\face_detection\detection\sfd\s3fd.pth'
if (-not (Test-Path -LiteralPath $sfdWeight)) {
  Write-Host 'Downloading the bundled SFD face detector...' -ForegroundColor Cyan
  Invoke-WebRequest `
    -Uri 'https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth' `
    -OutFile $sfdWeight `
    -UseBasicParsing
}

$required = @(
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
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $MuseTalkRoot $_)) })
if ($missing.Count) {
  throw "MuseTalk model package is incomplete: $($missing -join ', ')"
}

$oldPythonPath = $env:PYTHONPATH
$pythonPathItems = @($target, $MuseTalkRoot, (Join-Path $MuseTalkRoot 'musetalk\utils'), $oldPythonPath) | Where-Object { $_ }
$env:PYTHONPATH = $pythonPathItems -join [IO.Path]::PathSeparator
try {
  & $Python -c "import torch, cv2, diffusers, torchvision, mmcv, mmengine, mmdet, mmpose, face_detection; print('MuseTalk runtime ready:', 'CUDA' if torch.cuda.is_available() else 'CPU')"
  if ($LASTEXITCODE -ne 0) { throw 'MuseTalk runtime import validation failed.' }
} finally {
  $env:PYTHONPATH = $oldPythonPath
}

Write-Host 'MuseTalk runtime is complete. The same service now auto-selects CUDA or CPU.' -ForegroundColor Green
