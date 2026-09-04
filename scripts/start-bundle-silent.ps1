[CmdletBinding()]
param([string]$BundleRoot = '')

$ErrorActionPreference = 'Stop'
$scriptParent = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  # The distributed script lives under 安装工具\内部, while the source copy
  # lives under scripts.  Resolve both layouts without requiring the user to
  # type a path or open a PowerShell window.
  if (Test-Path -LiteralPath (Join-Path $scriptParent 'app')) {
    $BundleRoot = $scriptParent
  } elseif (Test-Path -LiteralPath (Join-Path $scriptParent 'apps')) {
    $BundleRoot = $scriptParent
  } else {
    $BundleRoot = Split-Path -Parent $scriptParent
  }
}
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$logs = Join-Path $bundle 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-HttpHealth([int]$Port, [string]$Path = '/health') {
  try {
    $result = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $Port, $Path) -TimeoutSec 2
    return $null -ne $result -and ($result.ready -ne $false)
  } catch { return $false }
}

function Wait-HttpHealth([int]$Port, [string]$Name, [string]$Path = '/health', [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpHealth $Port $Path) {
      Write-Host ("[OK] {0} is ready on {1}" -f $Name, $Port) -ForegroundColor Green
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Warning ("{0} did not become healthy. Open logs\\{1}.err.log before trying to clone." -f $Name, $Name)
  return $false
}

function Require-BundleFile([string]$RelativePath, [string]$Label) {
  $path = Join-Path $bundle $RelativePath
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing ${Label}: $path" }
  return $path
}

function Start-Hidden([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Name) {
  $stdout = Join-Path $logs "$Name.out.log"
  $stderr = Join-Path $logs "$Name.err.log"
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  if ($Name -eq 'kokoro-tts-service') {
    try { $process.PriorityClass = 'AboveNormal' } catch { Write-Warning 'Unable to raise Kokoro process priority.' }
  }
}

$env:MEIHUA_PROJECT_ROOT = Join-Path $bundle 'app'
$env:MEIHUA_PRODUCTION = '1'
$env:MUSETALK_HOME = Join-Path $bundle 'musetalk'
$env:MUSETALK_PYTHON = Join-Path $bundle 'gptsovits\runtime\python.exe'
$env:MUSETALK_PYTHONPATH = Join-Path $bundle 'musetalk\.python-packages'
$env:MEIHUA_ACCENT_HOME = Join-Path $bundle 'openvoice'
$env:KOKORO_MODEL_PATH = Join-Path $bundle 'app\services\kokoro-tts\models\kokoro-v1.0.onnx'
$env:KOKORO_VOICES_PATH = Join-Path $bundle 'app\services\kokoro-tts\models\voices-v1.0.bin'
$env:KOKORO_OUTPUT_DIR = Join-Path $bundle 'app\data\audio'
$env:MEIHUA_FFMPEG_PATH = Join-Path $bundle 'app\tools\ffmpeg'
$env:PYTHONPATH = @($env:MUSETALK_PYTHONPATH, $env:MUSETALK_HOME, (Join-Path $env:MUSETALK_HOME 'musetalk\utils'), (Join-Path $bundle 'app\services\kokoro-tts\vendor')) -join ';'
$env:PATH = "$env:MEIHUA_FFMPEG_PATH;$env:PATH"
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Require-BundleFile 'runtime\node\node.exe' 'portable Node runtime' | Out-Null
Require-BundleFile 'app\apps\orchestrator\dist\index.cjs' 'control service build' | Out-Null
Require-BundleFile 'app\tools\ffmpeg\ffmpeg.exe' 'bundled FFmpeg' | Out-Null
Require-BundleFile 'gptsovits\runtime\python.exe' 'voice Python runtime' | Out-Null
Require-BundleFile 'gptsovits\api_v3.py' 'voice API' | Out-Null
Require-BundleFile 'app\services\musetalk-service\main.py' 'avatar service' | Out-Null
Require-BundleFile 'app\services\voice-accent\main.py' 'target accent service' | Out-Null
Require-BundleFile 'app\services\kokoro-tts\main.py' 'Kokoro voice service' | Out-Null
Require-BundleFile 'app\services\kokoro-tts\models\kokoro-v1.0.onnx' 'Kokoro ONNX model' | Out-Null
Require-BundleFile 'app\services\kokoro-tts\models\voices-v1.0.bin' 'Kokoro voice pack' | Out-Null

$profileScript = Join-Path $PSScriptRoot 'resolve-gpu-profile.ps1'
if (-not (Test-Path -LiteralPath $profileScript)) {
  # Compatibility with an older flat bundle layout during upgrade.
  $profileScript = Join-Path $scriptParent 'resolve-gpu-profile.ps1'
}
if (Test-Path -LiteralPath $profileScript) {
  . $profileScript
  $gpuProfile = Set-MeihuaGpuRuntimeEnvironment
  Write-Host ("[INFO] GPU profile: {0} - {1}" -f $gpuProfile.Id, $gpuProfile.Description) -ForegroundColor Cyan
} else {
  $env:MEIHUA_GPU_PROFILE = 'CPU_COMPAT'
  $env:MUSETALK_BATCH_SIZE = '1'
  $env:MEIHUA_RELEASE_GPU_AFTER_TTS = '0'
  Write-Warning 'GPU profile helper missing; using safe CPU-compatible settings.'
}

if (-not (Test-Port 9881)) {
  Start-Hidden (Join-Path $bundle 'gptsovits\runtime\python.exe') @('-u', (Join-Path $bundle 'gptsovits\api_v3.py'), '-a', '127.0.0.1', '-p', '9881') (Join-Path $bundle 'gptsovits') 'voice-service'
}
if (-not (Test-Port 9898)) {
  Start-Hidden (Join-Path $bundle 'gptsovits\runtime\python.exe') @('-u', (Join-Path $bundle 'app\services\musetalk-service\main.py'), '--host', '127.0.0.1', '--port', '9898') $env:MUSETALK_HOME 'avatar-service'
}
if (-not (Test-Port 9899)) {
  Start-Hidden (Join-Path $bundle 'gptsovits\runtime\python.exe') @('-u', (Join-Path $bundle 'app\services\voice-accent\main.py'), '--host', '127.0.0.1', '--port', '9899') (Join-Path $bundle 'app') 'accent-service'
}
if (-not (Test-Port 9890)) {
  Start-Hidden (Join-Path $bundle 'gptsovits\runtime\python.exe') @('-u', (Join-Path $bundle 'app\services\kokoro-tts\main.py'), '--host', '127.0.0.1', '--port', '9890') (Join-Path $bundle 'app\services\kokoro-tts') 'kokoro-tts-service'
}
if (-not (Test-Port 3210)) {
  Start-Hidden (Join-Path $bundle 'runtime\node\node.exe') @((Join-Path $bundle 'app\apps\orchestrator\dist\index.cjs')) (Join-Path $bundle 'app') 'control-service'
}

$voiceReady = Wait-HttpHealth 9881 'voice-service'
$accentReady = Wait-HttpHealth 9899 'accent-service'
$kokoroReady = Wait-HttpHealth 9890 'kokoro-tts-service'
$avatarReady = Wait-HttpHealth 9898 'avatar-service'
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not (Test-Port 5200)) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Port 5200)) { throw 'Control console did not start. See logs\control-service.err.log.' }
if (-not $voiceReady -or -not $accentReady -or -not $avatarReady -or -not $kokoroReady) {
  Write-Warning 'The console is opening in diagnostic mode. Do not start cloning until the failed service is healthy.'
}
Start-Process 'http://127.0.0.1:5200/' | Out-Null
