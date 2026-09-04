[CmdletBinding()]
param(
  [string]$BundleRoot = '',
  [switch]$Integration
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) { Write-Host "[PASS] $Message" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Message" -ForegroundColor Red; $failures.Add($Message) }
}

$scripts = @(
  'bootstrap-bundle.ps1',
  'setup-assistant.ps1',
  'start-bundle-silent.ps1',
  'verify-bundle.ps1',
  'package-bundle.ps1'
)
foreach ($name in $scripts) {
  $path = Join-Path $PSScriptRoot $name
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  Assert-True ($errors.Count -eq 0) "$name parses in Windows PowerShell"
}

foreach ($name in @('bootstrap-bundle.ps1', 'start-bundle-silent.ps1')) {
  $content = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $name)
  Assert-True (-not [regex]::IsMatch($content, '[^\x00-\x7F]')) "$name uses an ASCII-safe source encoding"
}

$packager = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'package-bundle.ps1')
foreach ($expected in @(
  'bootstrap-bundle.ps1',
  'start-bundle-silent.ps1',
  'last-start-report.json'
)) {
  Assert-True $packager.Contains($expected) "packager emits $expected"
}

if ($Integration) {
  if ([string]::IsNullOrWhiteSpace($BundleRoot)) { throw '-BundleRoot is required with -Integration.' }
  $resolvedBundle = (Resolve-Path -LiteralPath $BundleRoot).Path
  $environmentReport = Join-Path $resolvedBundle 'logs\launcher-test-environment.json'
  $startReport = Join-Path $resolvedBundle 'logs\launcher-test-start.json'

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-assistant.ps1') `
    -BundleRoot $resolvedBundle -CheckOnly -NoClear -SkipPackageVerification -ReportPath $environmentReport
  Assert-True ($LASTEXITCODE -eq 0) 'environment check exits successfully'
  Assert-True (Test-Path -LiteralPath $environmentReport) 'environment report is written'

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-bundle-silent.ps1') `
    -BundleRoot $resolvedBundle -NoOpen -ReportPath $startReport
  Assert-True ($LASTEXITCODE -eq 0) 'idempotent production startup exits successfully'
  Assert-True (Test-Path -LiteralPath $startReport) 'startup report is written'
  if (Test-Path -LiteralPath $startReport) {
    $report = Get-Content -Raw -LiteralPath $startReport | ConvertFrom-Json
    Assert-True ($report.status -in @('READY', 'RUNNING_WITH_WARNINGS')) 'startup report has a valid running status'
    foreach ($requiredService in @('control-service', 'admin-ui', 'obs-stage')) {
      Assert-True ($report.services.$requiredService.status -eq 'READY') "$requiredService is ready"
    }
  }
}

if ($failures.Count -gt 0) {
  Write-Host ("Launcher verification failed with {0} issue(s)." -f $failures.Count) -ForegroundColor Red
  exit 1
}
Write-Host 'Launcher verification passed.' -ForegroundColor Green
exit 0
