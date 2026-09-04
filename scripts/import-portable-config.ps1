[CmdletBinding()]
param(
  [string]$BundleRoot = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'app'))) { $candidate = Split-Path -Parent $candidate }
  $BundleRoot = $candidate
}
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$portableRoot = Join-Path $bundle 'private-config'
$markerPath = Join-Path $bundle 'app\data\.portable-config-imported.json'

function Write-ImportStatus([string]$State, [string]$Text) {
  $color = if ($State -eq 'OK') { 'Green' } elseif ($State -eq 'WARN') { 'Yellow' } else { 'Cyan' }
  Write-Host ("[{0}] {1}" -f $State, $Text) -ForegroundColor $color
}

function Import-Secrets {
  $payloadPath = Join-Path $portableRoot 'secrets.portable.json'
  if (-not (Test-Path -LiteralPath $payloadPath)) { return $false }
  $payload = Get-Content -Raw -LiteralPath $payloadPath | ConvertFrom-Json
  $allowed = @(
    'llm-api-key.dpapi', 'tts-api-key.dpapi', 'voice-clone-api-key.dpapi',
    'avatar-clone-api-key.dpapi', 'voice-clone-aliyun-api-key.dpapi',
    'voice-clone-baidu-api-key.dpapi', 'avatar-clone-aliyun-credentials.dpapi',
    'avatar-clone-baidu-api-key.dpapi', 'vtube-studio.dpapi'
  )
  $targetDirectory = Join-Path $bundle 'app\data\secrets'
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  $imported = 0
  foreach ($item in @($payload.secrets)) {
    $fileName = [string]$item.fileName
    if ($fileName -notin $allowed) { throw "Portable secret filename is not allowed: $fileName" }
    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$item.valueBase64))
    if ([string]::IsNullOrWhiteSpace($plain)) { continue }
    $encrypted = ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString
    [IO.File]::WriteAllText((Join-Path $targetDirectory $fileName), $encrypted, [Text.UTF8Encoding]::new($false))
    $plain = $null
    $imported++
  }
  Remove-Item -LiteralPath $payloadPath -Force
  Write-ImportStatus 'OK' ("Re-encrypted {0} private setting(s) for the current Windows user and removed the extracted transfer payload" -f $imported)
  return $true
}

function Import-ObsConfiguration {
  $obsPayload = Join-Path $portableRoot 'obs'
  if (-not (Test-Path -LiteralPath $obsPayload)) { return $false }
  $obsRoot = Join-Path $env:APPDATA 'obs-studio'
  $sceneSource = Join-Path $obsPayload 'scenes\MeihuaStudio.json'
  $profileSource = Join-Path $obsPayload 'profiles\MeihuaStudio'
  if (Test-Path -LiteralPath $sceneSource) {
    $sceneTargetDirectory = Join-Path $obsRoot 'basic\scenes'
    New-Item -ItemType Directory -Path $sceneTargetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sceneSource -Destination (Join-Path $sceneTargetDirectory 'MeihuaStudio.json') -Force
  }
  if (Test-Path -LiteralPath $profileSource) {
    $profileTarget = Join-Path $obsRoot 'basic\profiles\MeihuaStudio'
    New-Item -ItemType Directory -Path $profileTarget -Force | Out-Null
    Copy-Item -Path (Join-Path $profileSource '*') -Destination $profileTarget -Recurse -Force
  }
  Write-ImportStatus 'OK' 'Imported the unified 1080x1920 OBS stage and current broadcast profile'
  return $true
}

if (-not (Test-Path -LiteralPath $portableRoot)) {
  Write-ImportStatus 'INFO' 'No private transfer payload was found; existing machine settings were preserved'
  exit 0
}

try {
  $secretImported = Import-Secrets
  $obsImported = Import-ObsConfiguration
  $state = [ordered]@{
    importedAt = [DateTimeOffset]::Now.ToString('o')
    windowsUser = [Environment]::UserName
    secretsImported = $secretImported
    obsImported = $obsImported
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
  Remove-Item -LiteralPath $portableRoot -Recurse -Force
  Write-ImportStatus 'OK' 'Configured-state migration completed for this computer'
  exit 0
} catch {
  Write-Host ("[FAIL] Configured-state migration failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
}
