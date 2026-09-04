[CmdletBinding()]
param(
  [string]$BundleRoot = '',
  [switch]$NoOpen,
  [switch]$StartOptionalServices,
  [int]$StartupTimeoutSeconds = 90,
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Resolve-BundleRoot([string]$RequestedRoot) {
  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return (Resolve-Path -LiteralPath $RequestedRoot).Path
  }
  $scriptParent = Split-Path -Parent $PSScriptRoot
  foreach ($candidate in @($scriptParent, (Split-Path -Parent $scriptParent))) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'app'))) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw 'Unable to locate the MeihuaStudio bundle root.'
}

$bundle = Resolve-BundleRoot $BundleRoot
$logs = Join-Path $bundle 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
if ([string]::IsNullOrWhiteSpace($ReportPath)) { $ReportPath = Join-Path $logs 'last-start-report.json' }
$launchLog = Join-Path $logs 'launcher.log'
$startedProcesses = [System.Collections.Generic.List[object]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$services = [ordered]@{}
$mutex = New-Object System.Threading.Mutex($false, 'Local\MeihuaStudio.Bundle.Start')
$hasMutex = $false

function Write-Launch([string]$State, [string]$Message) {
  $color = if ($State -eq 'OK') { 'Green' } elseif ($State -eq 'WARN') { 'Yellow' } elseif ($State -eq 'INFO') { 'Cyan' } else { 'Red' }
  $line = '[{0}] {1}' -f $State, $Message
  Write-Host $line -ForegroundColor $color
  try { Add-Content -LiteralPath $launchLog -Value ('{0:o} {1}' -f (Get-Date), $line) -Encoding UTF8 } catch { }
}

function Require-BundleFile([string]$RelativePath, [string]$Label) {
  $path = Join-Path $bundle $RelativePath
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing ${Label}: $path" }
  if (-not (Get-Item -LiteralPath $path).PSIsContainer -and (Get-Item -LiteralPath $path).Length -le 0) { throw "${Label} is empty: $path" }
  return $path
}

function Get-PortConnection([int]$Port) {
  return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-PortOwner([int]$Port) {
  $connection = Get-PortConnection $Port
  if (-not $connection) { return $null }
  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    Port = $Port
    Pid = $connection.OwningProcess
    Name = if ($process) { $process.ProcessName } else { 'unknown' }
    Path = if ($process -and $process.Path) { $process.Path } else { '' }
  }
}

function Invoke-LocalJson([string]$Uri, [int]$TimeoutSeconds = 3, [hashtable]$Headers = @{}) {
  try { return Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSeconds }
  catch { return $null }
}

function Test-WebPage([string]$Uri) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400 -and $response.Content.Length -gt 100
  } catch { return $false }
}

function Get-ControlHeaders {
  $tokenPath = Join-Path $bundle 'app\data\runtime-control-token'
  if (Test-Path -LiteralPath $tokenPath) {
    $value = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
    if ($value) { return @{ 'x-meihua-token' = $value } }
  }
  return @{}
}

function Test-ServiceReady([string]$Name) {
  switch ($Name) {
    'control-service' { return $null -ne (Invoke-LocalJson 'http://127.0.0.1:3210/api/health' 3 (Get-ControlHeaders)) }
    'kokoro-tts-service' {
      $health = Invoke-LocalJson 'http://127.0.0.1:9890/health'
      return $null -ne $health -and $health.ready -eq $true -and $health.model_ready -eq $true
    }
    'voice-service' {
      $health = Invoke-LocalJson 'http://127.0.0.1:9881/health'
      return $null -ne $health -and $health.ready -ne $false
    }
    'avatar-service' {
      $health = Invoke-LocalJson 'http://127.0.0.1:9898/health'
      return $null -ne $health -and $health.ready -eq $true
    }
    'accent-service' {
      $health = Invoke-LocalJson 'http://127.0.0.1:9899/health'
      return $null -ne $health -and $health.ready -eq $true
    }
    default { return $false }
  }
}

function Wait-Service([string]$Name, [int]$Port, [int]$TimeoutSeconds, [bool]$Required) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ServiceReady $Name) {
      $services[$Name] = [ordered]@{ port = $Port; status = 'READY'; required = $Required }
      Write-Launch 'OK' ("{0} is ready on port {1}" -f $Name, $Port)
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  $owner = Get-PortOwner $Port
  $detail = if ($owner) { "port is owned by $($owner.Name) (PID $($owner.Pid)) but its health check failed" } else { 'process did not listen before the startup timeout' }
  $services[$Name] = [ordered]@{ port = $Port; status = 'FAILED'; required = $Required; detail = $detail }
  if ($Required) { throw "$Name failed: $detail. Check its error log under $logs." }
  $warnings.Add("$Name is not ready: $detail")
  Write-Launch 'WARN' "$Name is not ready (optional capability): $detail"
  return $false
}

function Assert-PortSafe([string]$Name, [int]$Port) {
  if (-not (Get-PortConnection $Port)) { return }
  if (Test-ServiceReady $Name) { return }
  $owner = Get-PortOwner $Port
  $ownerText = if ($owner) { "$($owner.Name) (PID $($owner.Pid), $($owner.Path))" } else { 'an unknown process' }
  throw "Port $Port is owned by $ownerText but is not a healthy $Name. The launcher did not terminate the process."
}

function Start-Hidden([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Name) {
  $stdout = Join-Path $logs "$Name.out.log"
  $stderr = Join-Path $logs "$Name.err.log"
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $startedProcesses.Add($process)
  if ($Name -eq 'kokoro-tts-service') {
    try { $process.PriorityClass = 'AboveNormal' } catch { }
  }
  Write-Launch 'INFO' ("Starting {0} (PID {1})" -f $Name, $process.Id)
  return $process
}

function Ensure-Service([string]$Name, [int]$Port, [string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [bool]$Required, [int]$TimeoutSeconds) {
  if (Test-ServiceReady $Name) {
    $services[$Name] = [ordered]@{ port = $Port; status = 'READY'; required = $Required; reused = $true }
    Write-Launch 'OK' ("{0} is already healthy; reusing it" -f $Name)
    return $true
  }
  Assert-PortSafe $Name $Port
  Start-Hidden $File $Arguments $WorkingDirectory $Name | Out-Null
  return Wait-Service $Name $Port $TimeoutSeconds $Required
}

function Start-TikFinity {
  $exe = @(
    (Join-Path $bundle 'tikfinity\TikFinity.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\tikfinity\TikFinity.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $exe) {
    $warnings.Add('TikFinity was not found. The console can run, but live-room events are unavailable.')
    Write-Launch 'WARN' 'TikFinity was not found; live-room capture is unavailable'
    return
  }
  if (Get-Process -Name TikFinity -ErrorAction SilentlyContinue) {
    Write-Launch 'OK' 'TikFinity is already running'
    return
  }
  $previousNoProxy = $env:NO_PROXY
  $env:NO_PROXY = (@($previousNoProxy -split ',' | Where-Object { $_ }) + @('tikfinity.zerody.one', 'tikfinity-origin.zerody.one') | Select-Object -Unique) -join ','
  try { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null }
  finally {
    if ($null -eq $previousNoProxy) { Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue } else { $env:NO_PROXY = $previousNoProxy }
  }
  Write-Launch 'INFO' 'TikFinity started; waiting for its saved live-room session'
}

function Save-Report([string]$Status, [object]$Preflight = $null, [string]$ErrorMessage = '') {
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    status = $Status
    bundleRoot = $bundle
    services = $services
    warnings = @($warnings)
    preflight = $Preflight
    error = $ErrorMessage
    urls = [ordered]@{ admin = 'http://127.0.0.1:5200/'; obs = 'http://127.0.0.1:5173/obs/source/meihua-stage'; api = 'http://127.0.0.1:3210/api/health' }
  }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

try {
  $hasMutex = $mutex.WaitOne(0)
  if (-not $hasMutex) {
    Write-Launch 'INFO' 'Another launcher is active; waiting for it to finish'
    if (-not (Wait-Service 'control-service' 3210 $StartupTimeoutSeconds $true)) { throw 'The concurrent launcher did not finish successfully.' }
    if (-not $NoOpen) { Start-Process 'http://127.0.0.1:5200/' | Out-Null }
    Save-Report 'READY'
    exit 0
  }

  Write-Launch 'INFO' "Bundle root: $bundle"
  $node = Require-BundleFile 'runtime\node\node.exe' 'portable Node.js'
  $controlEntry = Require-BundleFile 'app\apps\orchestrator\dist\index.cjs' 'control service production build'
  Require-BundleFile 'app\apps\admin\dist\index.html' 'admin UI build' | Out-Null
  Require-BundleFile 'app\apps\overlay\dist\index.html' 'OBS stage build' | Out-Null
  $python = Require-BundleFile 'gptsovits\runtime\python.exe' 'local voice Python runtime'
  $ffmpeg = Require-BundleFile 'app\tools\ffmpeg\ffmpeg.exe' 'FFmpeg'

  $env:MEIHUA_PROJECT_ROOT = Join-Path $bundle 'app'
  $env:MEIHUA_PRODUCTION = '1'
  $env:MUSETALK_HOME = Join-Path $bundle 'musetalk'
  $env:MUSETALK_PYTHON = $python
  $env:MUSETALK_PYTHONPATH = Join-Path $bundle 'musetalk\.python-packages'
  $env:MEIHUA_ACCENT_HOME = Join-Path $bundle 'openvoice'
  $env:KOKORO_MODEL_PATH = Join-Path $bundle 'app\services\kokoro-tts\models\kokoro-v1.0.onnx'
  $env:KOKORO_VOICES_PATH = Join-Path $bundle 'app\services\kokoro-tts\models\voices-v1.0.bin'
  $env:KOKORO_OUTPUT_DIR = Join-Path $bundle 'app\data\audio'
  $env:MEIHUA_FFMPEG_PATH = Split-Path -Parent $ffmpeg
  $env:PYTHONPATH = @($env:MUSETALK_PYTHONPATH, $env:MUSETALK_HOME, (Join-Path $env:MUSETALK_HOME 'musetalk\utils'), (Join-Path $bundle 'app\services\kokoro-tts\vendor')) -join ';'
  $env:PATH = "$env:MEIHUA_FFMPEG_PATH;$env:PATH"
  $env:PYTHONUTF8 = '1'
  $env:PYTHONIOENCODING = 'utf-8'

  $profileScript = Join-Path $PSScriptRoot 'resolve-gpu-profile.ps1'
  if (-not (Test-Path -LiteralPath $profileScript)) { $profileScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'resolve-gpu-profile.ps1' }
  if (Test-Path -LiteralPath $profileScript) {
    . $profileScript
    $gpuProfile = Set-MeihuaGpuRuntimeEnvironment
    Write-Launch 'INFO' ("GPU runtime profile: {0} - {1}" -f $gpuProfile.Id, $gpuProfile.Description)
  } else {
    $env:MEIHUA_GPU_PROFILE = 'CPU_COMPAT'
    $warnings.Add('GPU profile helper is missing; CPU-compatible settings are active.')
  }

  Start-TikFinity
  Ensure-Service 'control-service' 3210 $node @($controlEntry) (Join-Path $bundle 'app') $true $StartupTimeoutSeconds | Out-Null

  $headers = Get-ControlHeaders
  $settings = Invoke-LocalJson 'http://127.0.0.1:3210/api/settings' 5 $headers
  if (-not $settings) { throw 'The control service is running, but production settings could not be loaded.' }

  $ttsAdapter = [string]$settings.providers.tts.adapter
  if ($ttsAdapter -eq 'kokoro') {
    $kokoroMain = Require-BundleFile 'app\services\kokoro-tts\main.py' 'Kokoro service'
    Require-BundleFile 'app\services\kokoro-tts\models\kokoro-v1.0.onnx' 'Kokoro model' | Out-Null
    Require-BundleFile 'app\services\kokoro-tts\models\voices-v1.0.bin' 'Kokoro voice pack' | Out-Null
    Ensure-Service 'kokoro-tts-service' 9890 $python @('-u', $kokoroMain, '--host', '127.0.0.1', '--port', '9890') (Join-Path $bundle 'app\services\kokoro-tts') $true $StartupTimeoutSeconds | Out-Null
  } elseif ($ttsAdapter -eq 'gptsovits-v3' -or $ttsAdapter -eq 'gptsovits') {
    $gptApi = Require-BundleFile 'gptsovits\api_v3.py' 'GPT-SoVITS API'
    Ensure-Service 'voice-service' 9881 $python @('-u', $gptApi, '-a', '127.0.0.1', '-p', '9881') (Join-Path $bundle 'gptsovits') $true $StartupTimeoutSeconds | Out-Null
  } else {
    Write-Launch 'INFO' "TTS adapter $ttsAdapter does not require a local model service"
  }

  $llmAdapter = [string]$settings.providers.llm.adapter
  if ($llmAdapter -eq 'openai-compatible') {
    $runtimeHealth = Invoke-LocalJson 'http://127.0.0.1:3210/api/health' 5 $headers
    if (-not $runtimeHealth -or $runtimeHealth.llm -ne 'READY') {
      Write-Launch 'INFO' 'Running a real structured LLM readiness check'
      try {
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3210/api/providers/llm/test' -Headers $headers `
          -ContentType 'application/json' -Body '{}' -TimeoutSec 45 | Out-Null
      } catch {
        throw "Configured LLM failed its real startup check: $($_.Exception.Message)"
      }
    }
    Write-Launch 'OK' 'Configured LLM passed a real structured response check'
  }

  $presentationMode = [string]$settings.presentation.mode
  if ($presentationMode -eq 'DIGITAL_HUMAN') {
    $avatarAdapter = [string]$settings.providers.avatar.adapter
    if ($avatarAdapter -eq 'musetalk') {
      $museMain = Require-BundleFile 'app\services\musetalk-service\main.py' 'MuseTalk service'
      Ensure-Service 'avatar-service' 9898 $python @('-u', $museMain, '--host', '127.0.0.1', '--port', '9898') $env:MUSETALK_HOME $true ([Math]::Max($StartupTimeoutSeconds, 180)) | Out-Null
    } else {
      Write-Launch 'INFO' "Avatar adapter $avatarAdapter is handled by its cloud or external provider"
    }
  } else {
    Write-Launch 'OK' "Presentation mode $presentationMode does not require MuseTalk"
  }

  if ($StartOptionalServices) {
    if (Test-Path -LiteralPath (Join-Path $bundle 'gptsovits\api_v3.py')) {
      Ensure-Service 'voice-service' 9881 $python @('-u', (Join-Path $bundle 'gptsovits\api_v3.py'), '-a', '127.0.0.1', '-p', '9881') (Join-Path $bundle 'gptsovits') $false $StartupTimeoutSeconds | Out-Null
    }
    if (Test-Path -LiteralPath (Join-Path $bundle 'app\services\voice-accent\main.py')) {
      Ensure-Service 'accent-service' 9899 $python @('-u', (Join-Path $bundle 'app\services\voice-accent\main.py'), '--host', '127.0.0.1', '--port', '9899') (Join-Path $bundle 'app') $false $StartupTimeoutSeconds | Out-Null
    }
  }

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline -and (-not (Test-WebPage 'http://127.0.0.1:5200/') -or -not (Test-WebPage 'http://127.0.0.1:5173/obs/source/meihua-stage'))) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-WebPage 'http://127.0.0.1:5200/')) { throw 'Admin UI on port 5200 did not return a complete page.' }
  if (-not (Test-WebPage 'http://127.0.0.1:5173/obs/source/meihua-stage')) { throw 'OBS stage on port 5173 did not return a complete page.' }
  $services['admin-ui'] = [ordered]@{ port = 5200; status = 'READY'; required = $true }
  $services['obs-stage'] = [ordered]@{ port = 5173; status = 'READY'; required = $true }

  $preflight = Invoke-LocalJson 'http://127.0.0.1:3210/api/preflight?mode=LIVE' 10 $headers
  $reportStatus = 'READY'
  if ($preflight -and $preflight.ready -eq $false) {
    $reportStatus = 'RUNNING_WITH_WARNINGS'
    foreach ($check in @($preflight.checks | Where-Object { $_.status -eq 'FAIL' })) {
      $warnings.Add(("Live preflight: {0} - {1}" -f $check.label, $check.message))
    }
    Write-Launch 'WARN' 'Core startup passed, but formal LIVE preflight still has failed checks; see the startup report or admin preflight panel'
  }
  Save-Report $reportStatus $preflight
  Write-Launch 'OK' 'Startup verification passed: control API, admin UI, OBS stage, and active media services are reachable'
  Write-Launch 'INFO' "Startup report: $ReportPath"
  if (-not $NoOpen) { Start-Process 'http://127.0.0.1:5200/' | Out-Null }
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Launch 'FAIL' $message
  Save-Report 'FAILED' $null $message
  Write-Launch 'INFO' "Failure report: $ReportPath"
  exit 1
} finally {
  if ($hasMutex) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
