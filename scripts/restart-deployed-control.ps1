[CmdletBinding()]
param(
  [string]$BundleRoot = 'E:\meihua\bundle\MeihuaStudio'
)

$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$app = (Resolve-Path -LiteralPath (Join-Path $bundle 'app')).Path
$node = Join-Path $bundle 'runtime\node\node.exe'
$entry = Join-Path $app 'apps\orchestrator\dist\index.cjs'
if (-not (Test-Path -LiteralPath $node)) { throw "Portable Node is missing: $node" }
if (-not (Test-Path -LiteralPath $entry)) { throw "Control build is missing: $entry" }

$env:MEIHUA_PROJECT_ROOT = $app
$env:MEIHUA_PRODUCTION = '1'
$env:MEIHUA_FFMPEG_PATH = Join-Path $app 'tools\ffmpeg'
$env:PATH = "$env:MEIHUA_FFMPEG_PATH;$env:PATH"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $bundle "logs\control-service-$stamp.out.log"
$stderr = Join-Path $bundle "logs\control-service-$stamp.err.log"
$process = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $app `
  -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

$deadline = (Get-Date).AddSeconds(60)
$health = $null
$tokenPath = Join-Path $app 'data\runtime-control-token'
$headers = if (Test-Path -LiteralPath $tokenPath) { @{ 'x-meihua-token' = (Get-Content -Raw -LiteralPath $tokenPath).Trim() } } else { @{} }
while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) { throw "Control process exited with code $($process.ExitCode). See $stderr" }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/health' -Headers $headers -TimeoutSec 2
    if ($health) { break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $health) { throw "Control service did not become healthy. See $stderr" }

[pscustomobject]@{
  ProcessId = $process.Id
  Health = $health.status
  AdminPort = [bool](Get-NetTCPConnection -State Listen -LocalPort 5200 -ErrorAction SilentlyContinue)
  OverlayPort = [bool](Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue)
  ErrorLog = $stderr
}
