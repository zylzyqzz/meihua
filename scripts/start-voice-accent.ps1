param(
  [string]$BundleRoot = '',
  [int]$Port = 9899
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
if (-not $BundleRoot) { $BundleRoot = Join-Path $projectRoot 'bundle\MeihuaStudio' }

$pythonCandidates = @(
  (Join-Path $BundleRoot 'gptsovits\runtime\python.exe'),
  (Join-Path $projectRoot 'tools\python\python.exe'),
  'python'
)
$python = $pythonCandidates | Where-Object { $_ -eq 'python' -or (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $python) { throw 'OpenVoice Python runtime not found.' }

$service = Join-Path $projectRoot 'services\voice-accent\main.py'
$bundleService = Join-Path $BundleRoot 'app\services\voice-accent\main.py'
if (Test-Path -LiteralPath $bundleService) { $service = $bundleService }
$accentHome = if ($env:MEIHUA_ACCENT_HOME) { $env:MEIHUA_ACCENT_HOME } elseif (Test-Path -LiteralPath (Join-Path $projectRoot 'openvoice')) { Join-Path $projectRoot 'openvoice' } else { Join-Path $BundleRoot 'openvoice' }
$env:MEIHUA_ACCENT_HOME = $accentHome
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

& $python $service --host 127.0.0.1 --port $Port
