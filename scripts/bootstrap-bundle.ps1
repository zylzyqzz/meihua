[CmdletBinding()]
param(
  [string]$BundleRoot = '',
  [switch]$SkipSystemInstall,
  [switch]$NoOpen,
  [switch]$StartOptionalServices
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'app'))) { $candidate = Split-Path -Parent $candidate }
  $BundleRoot = $candidate
}
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$logs = Join-Path $bundle 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$bootstrapLog = Join-Path $logs 'bootstrap.log'

function Write-Step([string]$State, [string]$Text) {
  $color = if ($State -eq 'OK') { 'Green' } elseif ($State -eq 'WARN') { 'Yellow' } elseif ($State -eq 'INFO') { 'Cyan' } else { 'Red' }
  Write-Host ("[{0}] {1}" -f $State, $Text) -ForegroundColor $color
  try { Add-Content -LiteralPath $bootstrapLog -Value ('{0:o} [{1}] {2}' -f (Get-Date), $State, $Text) -Encoding UTF8 } catch { }
}

function Find-Tool([string]$DistributedName, [string]$SourceName) {
  foreach ($candidate in @(
    (Join-Path $PSScriptRoot $SourceName),
    (Join-Path $bundle "scripts\$SourceName")
  )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "Missing launcher tool: $SourceName"
}

try {
  Write-Host '=== MeihuaStudio check, install, and start ===' -ForegroundColor Cyan
  Write-Step 'INFO' "Bundle root: $bundle"

  $verify = Find-Tool 'verify-bundle.ps1' 'verify-bundle.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verify -BundleRoot $bundle
  if ($LASTEXITCODE -ne 0) { throw 'Bundle verification failed. Startup was stopped to avoid running an incomplete package.' }
  Write-Step 'OK' 'Bundle files, models, and runtimes passed verification'

  $environment = Find-Tool 'setup-assistant.ps1' 'setup-assistant.ps1'
  $environmentArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $environment, '-BundleRoot', $bundle, '-NoClear', '-SkipPackageVerification', '-ReportPath', (Join-Path $logs 'last-environment-report.json'))
  if ($SkipSystemInstall) { $environmentArgs += '-CheckOnly' } else { $environmentArgs += '-AutoInstall' }
  & powershell.exe @environmentArgs
  if ($LASTEXITCODE -ne 0) { throw 'Windows environment setup did not complete. Resolve the failed item above and run this launcher again.' }
  Write-Step 'OK' $(if ($SkipSystemInstall) { 'Environment check completed' } else { 'Environment check and installation completed' })

  $start = Find-Tool 'start-bundle-silent.ps1' 'start-bundle-silent.ps1'
  $startArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $start, '-BundleRoot', $bundle, '-NoOpen', '-ReportPath', (Join-Path $logs 'last-start-report.json'))
  if ($StartOptionalServices) { $startArgs += '-StartOptionalServices' }
  & powershell.exe @startArgs
  if ($LASTEXITCODE -ne 0) { throw 'Core service startup or runtime verification failed.' }

  $startReportPath = Join-Path $logs 'last-start-report.json'
  $startReport = if (Test-Path -LiteralPath $startReportPath) { Get-Content -Raw -LiteralPath $startReportPath | ConvertFrom-Json } else { $null }
  if ($startReport -and $startReport.status -eq 'RUNNING_WITH_WARNINGS') {
    Write-Step 'WARN' 'Core system is ready, but formal LIVE preflight still has warnings; review the admin preflight panel'
  } else {
    Write-Step 'OK' 'One-click workflow completed; the system is ready'
  }
  Write-Step 'INFO' 'Admin: http://127.0.0.1:5200/'
  Write-Step 'INFO' 'OBS stage: http://127.0.0.1:5173/obs/source/meihua-stage'
  Write-Step 'INFO' "Logs: $logs"
  if (-not $NoOpen) { Start-Process 'http://127.0.0.1:5200/' | Out-Null }
  exit 0
} catch {
  Write-Step 'FAIL' $_.Exception.Message
  Write-Step 'INFO' "See: $bootstrapLog"
  exit 1
}
