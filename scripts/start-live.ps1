[CmdletBinding()]
param(
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Test-LocalPort([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(250)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.(?<minor>\d+)') { throw 'Unable to determine Node.js version.' }
if ([int]$Matches.major -lt 22 -or ([int]$Matches.major -eq 22 -and [int]$Matches.minor -lt 5)) {
  throw "Node.js 22.5+ is required; detected $nodeVersion."
}

$pnpmVersion = (& pnpm --version).Trim()
if ($pnpmVersion -notmatch '^(?<major>\d+)\.') { throw 'Unable to determine pnpm version.' }
if ([int]$Matches.major -lt 11) { throw "pnpm 11+ is required; detected $pnpmVersion." }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Dependencies are missing. Run pnpm install first.' }

$dataPath = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$mediaPath = Join-Path $dataPath 'media'
New-Item -ItemType Directory -Path $mediaPath -Force | Out-Null
$writeProbe = Join-Path $dataPath '.write-probe'
try { [System.IO.File]::WriteAllText($writeProbe, 'ok') } finally { if (Test-Path -LiteralPath $writeProbe) { Remove-Item -LiteralPath $writeProbe -Force } }

$checks = @(
  [pscustomobject]@{ Item = 'Node.js'; Status = $nodeVersion; Required = '22.5+' },
  [pscustomobject]@{ Item = 'pnpm'; Status = $pnpmVersion; Required = '11+' },
  [pscustomobject]@{ Item = 'SQLite data path'; Status = $dataPath; Required = 'writable' },
  [pscustomobject]@{ Item = 'TikFinity Desktop'; Status = if (Test-LocalPort 21213) { 'reachable, real-event verification still required' } else { 'not connected (local rehearsal remains available)' }; Required = 'required for LIVE_VERIFIED' },
  [pscustomobject]@{ Item = 'Media directory'; Status = $mediaPath; Required = 'writable; avatar/background assets are checked again before going live' }
)
$checks | Format-Table -AutoSize

if ($PreflightOnly) { exit 0 }

Write-Host 'Starting V2 Orchestrator, Overlay, and Admin. Local readiness is not OBS/LIVE verification.' -ForegroundColor Green
Push-Location $projectRoot
try { & pnpm dev } finally { Pop-Location }
