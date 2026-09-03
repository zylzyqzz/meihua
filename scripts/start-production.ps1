[CmdletBinding()]
param(
  [switch]$PreflightOnly,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$gpuProfileScript = Join-Path $PSScriptRoot 'resolve-gpu-profile.ps1'
if (Test-Path -LiteralPath $gpuProfileScript) {
  . $gpuProfileScript
  $gpuProfile = Set-MeihuaGpuRuntimeEnvironment
  Write-Host ("GPU runtime profile: {0} ({1})" -f $gpuProfile.Id, $gpuProfile.Description) -ForegroundColor Cyan
}
$dataPath = Join-Path $projectRoot 'data'
$logsPath = Join-Path $dataPath 'logs'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
New-Item -ItemType Directory -Path $logsPath -Force | Out-Null

function Test-LocalPort([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(250)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name is not available in PATH." }
}

Require-Command node
Require-Command pnpm
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Dependencies are missing. Run pnpm install first.' }
if ((Test-LocalPort 3210) -or (Test-LocalPort 5173) -or (Test-LocalPort 5200)) { throw 'A Meihua service or development server is already using 3210, 5173, or 5200. Stop it before starting production.' }

# V7: 自动拉起 TikFinity（直播事件采集外挂，账号登录一次后全自动）
$tikFinity = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\tikfinity\TikFinity.exe'),
  (Join-Path ${env:ProgramFiles} 'tikfinity\TikFinity.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($tikFinity) {
  $running = Get-Process -Name 'TikFinity' -ErrorAction SilentlyContinue
  if (-not $running) {
    Write-Host 'Starting TikFinity (live event capture)...' -ForegroundColor Cyan
    # TikFinity loads its Electron bootstrap with Axios. Local HTTP proxies can
    # reset that request even while ordinary browsers still reach the site.
    $previousNoProxy = $env:NO_PROXY
    $env:NO_PROXY = (@($previousNoProxy -split ',' | Where-Object { $_ }) + @(
      'tikfinity.zerody.one',
      'tikfinity-origin.zerody.one'
    ) | Select-Object -Unique) -join ','
    try {
      Start-Process -FilePath $tikFinity -WorkingDirectory (Split-Path $tikFinity) | Out-Null
    } finally {
      if ($null -eq $previousNoProxy) { Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue }
      else { $env:NO_PROXY = $previousNoProxy }
    }
    Start-Sleep -Seconds 3
  } else {
    Write-Host 'TikFinity already running.' -ForegroundColor DarkGray
  }
} else {
  Write-Warning 'TikFinity not installed - live gift/like capture unavailable. Install once from https://tikfinity.zerody.one/ then login (Connect TikTok Account) and set your TikTok name in Setup.'
}

Push-Location $projectRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
} finally { Pop-Location }

$databasePath = Join-Path $dataPath 'meihua-live.db'
$checks = @(
  [pscustomobject]@{ Item = 'Production API'; Status = '3210 (will start)'; Required = 'available' },
  [pscustomobject]@{ Item = 'OBS browser sources'; Status = '5173 (will start)'; Required = 'available' },
  [pscustomobject]@{ Item = 'Chinese control console'; Status = '5200 (will start)'; Required = 'available' },
  [pscustomobject]@{ Item = 'Voice cloning'; Status = if (Test-LocalPort 9881) { '9881 ready' } else { '9881 will start automatically' }; Required = 'bundled GPT-SoVITS' },
  [pscustomobject]@{ Item = 'Video avatar'; Status = if (Test-LocalPort 9898) { '9898 ready' } else { '9898 will start automatically' }; Required = 'bundled MuseTalk' },
  [pscustomobject]@{ Item = 'Target accent'; Status = if (Test-LocalPort 9899) { '9899 ready' } else { '9899 will start automatically' }; Required = 'local CUDA OpenVoice wrapper' },
  [pscustomobject]@{ Item = 'Kokoro English voice'; Status = if (Test-LocalPort 9890) { '9890 ready' } else { '9890 will start automatically' }; Required = 'local ONNX preset voice' },
  [pscustomobject]@{ Item = 'SQLite'; Status = $databasePath; Required = 'writable; WAL checkpoint on normal exit' },
  [pscustomobject]@{ Item = 'TikFinity'; Status = if (Test-LocalPort 21213) { 'port reachable; valid-event verification still required' } else { 'not reachable; rehearsal remains available' }; Required = 'formal live requires verification' },
  [pscustomobject]@{ Item = 'Avatar actions'; Status = if (Test-LocalPort 8001) { 'VTube API reachable; authorization/model tests remain optional' } else { 'not reachable; use browser avatar media or no avatar' }; Required = 'optional; never a core live blocker' }
)
$checks | Format-Table -AutoSize
if ($PreflightOnly) { exit 0 }

# A single launch entry owns the complete local stack. Both AI services use the
# same code on every machine and select CUDA automatically when it is present.
if (-not (Test-LocalPort 9881)) {
  Write-Host 'Starting voice cloning service (9881)...' -ForegroundColor Cyan
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-gptsovits.ps1')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
}
if (-not (Test-LocalPort 9898)) {
  Write-Host 'Starting video avatar service (9898)...' -ForegroundColor Cyan
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-musetalk-service.ps1')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsPath 'musetalk-service.out.log') `
    -RedirectStandardError (Join-Path $logsPath 'musetalk-service.err.log') | Out-Null
}
if (-not (Test-LocalPort 9899)) {
  Write-Host 'Starting target accent service (9899)...' -ForegroundColor Cyan
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-voice-accent.ps1')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsPath 'voice-accent-service.out.log') `
    -RedirectStandardError (Join-Path $logsPath 'voice-accent-service.err.log') | Out-Null
}
if (-not (Test-LocalPort 9890)) {
  Write-Host 'Starting local Kokoro English voice service (9890)...' -ForegroundColor Cyan
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-kokoro-tts.ps1')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsPath 'kokoro-tts-service.out.log') `
    -RedirectStandardError (Join-Path $logsPath 'kokoro-tts-service.err.log') | Out-Null
}

$attempt = 0
while ($true) {
  $attempt++
  $date = Get-Date -Format 'yyyy-MM-dd'
  $stdout = Join-Path $logsPath "production-$date.out.log"
  $stderr = Join-Path $logsPath "production-$date.err.log"
  Write-Host "Starting Meihua Live production process (attempt $attempt)." -ForegroundColor Green
  $oldMode = $env:MEIHUA_PRODUCTION
  $env:MEIHUA_PRODUCTION = '1'
  $process = Start-Process -FilePath node -ArgumentList 'apps/orchestrator/dist/index.cjs' -WorkingDirectory $projectRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  $ready = $false
  for ($index = 0; $index -lt 40; $index++) {
    Start-Sleep -Milliseconds 250
    try {
      $tokenPath = Join-Path $dataPath 'runtime-control-token'
      $headers = if (Test-Path -LiteralPath $tokenPath) { @{ 'x-meihua-token' = (Get-Content -Raw -LiteralPath $tokenPath).Trim() } } else { @{} }
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/health' -Headers $headers -TimeoutSec 1
      if ($health) { $ready = $true; break }
    } catch { }
    if ($process.HasExited) { break }
  }
  if ($oldMode) { $env:MEIHUA_PRODUCTION = $oldMode } else { Remove-Item Env:MEIHUA_PRODUCTION -ErrorAction SilentlyContinue }
  if (-not $ready) { Write-Warning "Production process did not become healthy. See $stderr" }
  else { Start-Process 'http://127.0.0.1:5200/' }
  Wait-Process -Id $process.Id
  if ($NoRestart -or $attempt -ge 5) { break }
  $seconds = [Math]::Min(30, [Math]::Pow(2, $attempt))
  Write-Warning "Production process exited. Restarting in $seconds seconds; unfinished sessions recover as PAUSED."
  Start-Sleep -Seconds $seconds
}
