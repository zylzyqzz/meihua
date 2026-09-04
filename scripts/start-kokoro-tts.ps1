[CmdletBinding()]
param(
  [int]$Port = 9890,
  [string]$Host_ = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$serviceRoot = Join-Path $projectRoot 'services\kokoro-tts'
$pythonCandidates = @(
  (Join-Path $serviceRoot '.venv\Scripts\python.exe'),
  (Join-Path $projectRoot 'bundle\MeihuaStudio\gptsovits\runtime\python.exe'),
  (Join-Path $projectRoot 'tools\python\python.exe'),
  'E:\shuzirenzhiboruanjian\ChanYinAi_V5-20260813\runtime\python.exe'
)
$python = $pythonCandidates | Where-Object { $_ -eq 'python' -or (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $python) { throw 'Kokoro Python runtime not found.' }

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:KOKORO_MODEL_PATH = Join-Path $serviceRoot 'models\kokoro-v1.0.onnx'
$env:KOKORO_VOICES_PATH = Join-Path $serviceRoot 'models\voices-v1.0.bin'
$env:KOKORO_OUTPUT_DIR = Join-Path $projectRoot 'data\audio'
$vendor = Join-Path $serviceRoot 'vendor'
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$vendor;$env:PYTHONPATH" } else { $vendor }
if (-not (Test-Path -LiteralPath $env:KOKORO_MODEL_PATH)) { throw "Kokoro model not found: $env:KOKORO_MODEL_PATH" }
if (-not (Test-Path -LiteralPath $env:KOKORO_VOICES_PATH)) { throw "Kokoro voices not found: $env:KOKORO_VOICES_PATH" }

Push-Location $serviceRoot
try {
  & $python -u (Join-Path $serviceRoot 'main.py') --host $Host_ --port $Port
  if ($LASTEXITCODE -ne 0) { throw "Kokoro service exited with code $LASTEXITCODE." }
} finally { Pop-Location }
