[CmdletBinding()]
param(
  [ValidateSet('REHEARSAL', 'LIVE')]
  [string]$Mode = 'LIVE',
  [string]$ApiBase = 'http://127.0.0.1:3210',
  [string]$OverlayBase = 'http://127.0.0.1:5173',
  [string]$AdminUrl = 'http://127.0.0.1:5200/'
)

$ErrorActionPreference = 'Stop'
$failed = $false
$externalBlocked = $false
$tokenPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\runtime-control-token'
$controlToken = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -Raw -LiteralPath $tokenPath).Trim() } else { '' }
$Headers = if ($controlToken) { @{ 'x-meihua-token' = $controlToken } } else { @{} }

function Get-Json([string]$Path) {
  Invoke-RestMethod -Uri "$ApiBase$Path" -Headers $Headers -TimeoutSec 5
}

function Test-Page([string]$Name, [string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    $ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    [pscustomobject]@{ Item = $Name; Status = if ($ok) { 'PASS' } else { 'FAIL' }; Detail = "HTTP $($response.StatusCode)" }
  } catch {
    [pscustomobject]@{ Item = $Name; Status = 'FAIL'; Detail = $_.Exception.Message }
  }
}

try {
  $health = Get-Json '/api/health'
  $preflight = Get-Json "/api/preflight?mode=$Mode"
  $vtube = Get-Json '/api/avatar/vtube/status'
  $obsSources = Get-Json '/api/obs/sources/health'
} catch {
  Write-Error "Cannot reach control API ($ApiBase): $($_.Exception.Message)"
  exit 1
}

Write-Host "`nMeihua Live Control - $Mode readiness validation" -ForegroundColor Cyan
Write-Host 'Read-only: this script does not create sessions, inject events, or modify the database.' -ForegroundColor DarkGray

$tikfinityDetail = if ($health.tikfinity.verified) { 'Legal event verified' } else { 'No verified live event received' }
$vtubeDetail = if ($vtube.model) { "Model: $($vtube.model.modelName)" } else { 'Not authorized or no verified model loaded' }
$serviceRows = @(
  [pscustomobject]@{ Item = 'Control API'; Status = 'PASS'; Detail = "Up for $([math]::Round($health.uptimeMs / 1000)) seconds" },
  [pscustomobject]@{ Item = 'Local TTS'; Status = $health.tts; Detail = ($health.providers | Where-Object id -eq 'windows-tts').message },
  [pscustomobject]@{ Item = 'TikFinity'; Status = $health.tikfinity.status; Detail = $tikfinityDetail },
  [pscustomobject]@{ Item = 'VTube Studio actions (optional)'; Status = $vtube.status; Detail = $vtubeDetail },
  [pscustomobject]@{ Item = 'Audio output contract'; Status = 'BACKEND'; Detail = 'The orchestrator owns the only Windows playback path; no OBS audio browser source is required' }
)
$serviceRows | Format-Table -AutoSize

$sourceIds = @($obsSources | Where-Object enabled | Select-Object -ExpandProperty sourceId)
$sourceIds += 'full-preview'
$sourceIds = @($sourceIds | Select-Object -Unique)
$pageRows = @((Test-Page 'Chinese control page' $AdminUrl))
foreach ($sourceId in $sourceIds) { $pageRows += Test-Page "OBS source: $sourceId" "$OverlayBase/obs/source/$sourceId" }
$pageRows | Format-Table -AutoSize
if (($pageRows | Where-Object Status -eq 'FAIL').Count -gt 0) { $failed = $true }

Write-Host "`nOBS browser-source WebSocket status:" -ForegroundColor Cyan
$obsSources | Select-Object sourceId, enabled, connected, connections, lastConnectedAt | Format-Table -AutoSize

Write-Host "`nLive preflight:" -ForegroundColor Cyan
foreach ($check in $preflight.checks) {
  $color = switch ($check.status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
  Write-Host ("[{0}] {1} - {2}" -f $check.status, $check.label, $check.message) -ForegroundColor $color
  if ($check.status -eq 'FAIL') { $externalBlocked = $true }
}

if ($failed) {
  Write-Host "`nResult: a core service or OBS source is unreachable. Repair the local service first." -ForegroundColor Red
  exit 1
}
if ($Mode -eq 'LIVE' -and (-not $preflight.ready -or $externalBlocked)) {
  Write-Host "`nResult: formal live is not yet verified. This is a safety block, not a false-ready state. Follow docs/PRODUCTION-VALIDATION-PROTOCOL-V2.1.md for external validation." -ForegroundColor Yellow
  exit 2
}

Write-Host "`nResult: $Mode readiness passed. Retain the matching evidence before marking this version production-ready." -ForegroundColor Green
exit 0
