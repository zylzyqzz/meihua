[CmdletBinding()]
param(
  [string]$GptSoVitsRoot = '',
  [int]$Port = 9881,
  [string]$Host_ = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
if (-not $GptSoVitsRoot) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $GptSoVitsRoot = if ($env:GPT_SOVITS_HOME) { $env:GPT_SOVITS_HOME } else { Join-Path $projectRoot 'external\gptsovits-v3' }
}
$python = @(
  (Join-Path $GptSoVitsRoot 'runtime\python.exe'),
  (Join-Path $GptSoVitsRoot 'runtime\Scripts\python.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$apiScript = Join-Path $GptSoVitsRoot 'api_v3.py'
if (-not $python) { throw "GPT-SoVITS runtime python not found under: $GptSoVitsRoot\runtime" }
if (-not (Test-Path $apiScript)) { throw "api_v3.py not found: $apiScript" }

# GPT-SoVITS uses ffmpeg-python internally, which launches `ffmpeg` by name.
# Keep the runtime self-contained by exposing the binary bundled with this
# project instead of relying on a machine-wide FFmpeg installation.
$projectRoot = Split-Path -Parent $PSScriptRoot
$gpuProfileScript = Join-Path $PSScriptRoot 'resolve-gpu-profile.ps1'
if (Test-Path -LiteralPath $gpuProfileScript) {
  . $gpuProfileScript
  $gpuProfile = Set-MeihuaGpuRuntimeEnvironment
  Write-Host ("GPU runtime profile: {0} ({1})" -f $gpuProfile.Id, $gpuProfile.Description) -ForegroundColor Cyan
}
$ffmpegDirectory = Join-Path $projectRoot 'tools\ffmpeg'
$ffmpeg = Join-Path $ffmpegDirectory 'ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpeg)) {
  throw "Bundled FFmpeg not found: $ffmpeg"
}
$env:PATH = "$ffmpegDirectory;$env:PATH"
$env:FFMPEG_BINARY = $ffmpeg
# Model libraries emit Chinese progress text.  Keep redirected logs UTF-8 so
# a valid synthesis never fails merely while writing a diagnostic.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$cuda = (& $python -c "import torch; print('READY' if torch.cuda.is_available() else 'MISSING')" 2>$null | Select-Object -Last 1).Trim()
if ($cuda -eq 'READY') {
  $gpu = (& $python -c "import torch; print(torch.cuda.get_device_name(0))" 2>$null | Select-Object -Last 1).Trim()
  Write-Host "CUDA ready: $gpu" -ForegroundColor Green
} else {
  Write-Host 'No CUDA detected; GPT-SoVITS will use CPU automatically.' -ForegroundColor Yellow
}

$logsDir = Join-Path $projectRoot 'data\logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$stdout = Join-Path $logsDir 'gptsovits-api.out.log'
$stderr = Join-Path $logsDir 'gptsovits-api.err.log'

Write-Host "Starting GPT-SoVITS V3 on ${Host_}:$Port." -ForegroundColor Green
$process = Start-Process -FilePath $python -ArgumentList @('-u', $apiScript, '-a', $Host_, '-p', "$Port") -WorkingDirectory $GptSoVitsRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
for ($index = 0; $index -lt 240; $index++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://${Host_}:$Port/health" -TimeoutSec 1
    if ($health -and $health.ready) { Write-Host 'GPT-SoVITS API is up.' -ForegroundColor Green; break }
  } catch { }
  if ($process.HasExited) { Write-Warning "Process exited. See $stderr"; break }
}
if (-not $process.HasExited) { Write-Host "PID $($process.Id). Logs: $stdout" }
