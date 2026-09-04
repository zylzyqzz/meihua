[CmdletBinding()]
param(
  [string]$ProjectRoot = 'E:\meihua\meihua-live',
  [string]$SourceBundle = 'E:\meihua\bundle\MeihuaStudio',
  [string]$ReleaseRoot = 'E:\meihua\release-configured',
  [string]$ReleaseName = 'MeihuaStudio',
  [switch]$ResumeFromPhase5
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$source = (Resolve-Path -LiteralPath $SourceBundle).Path
$releaseParent = [IO.Path]::GetFullPath($ReleaseRoot)
$target = Join-Path $releaseParent $ReleaseName

function Copy-Tree([string]$From, [string]$To, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @()) {
  if (-not (Test-Path -LiteralPath $From)) { return }
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  $arguments = @($From, $To, '/E', '/COPY:DAT', '/DCOPY:DAT', '/NFL', '/NDL', '/NP', '/R:2', '/W:2')
  foreach ($directory in $ExcludeDirs) { $arguments += @('/XD', $directory) }
  foreach ($file in $ExcludeFiles) { $arguments += @('/XF', $file) }
  robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $From -> $To" }
}

function Export-Sqlite([string]$From, [string]$To) {
  $python = Join-Path $source 'gptsovits\runtime\python.exe'
  if (-not (Test-Path -LiteralPath $python)) { throw 'Bundled Python is missing; cannot create a consistent live database snapshot.' }
  $code = @'
import sqlite3, sys
source, target = sys.argv[1], sys.argv[2]
with sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30) as src:
    with sqlite3.connect(target, timeout=30) as dst:
        src.backup(dst, pages=2048, sleep=0.02)
        row = dst.execute("pragma integrity_check").fetchone()
        if not row or row[0] != "ok":
            raise RuntimeError(f"integrity_check failed: {row}")
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
  & $python -c "import base64;exec(base64.b64decode('$encoded'))" $From $To
  if ($LASTEXITCODE -ne 0) { throw 'SQLite online backup failed.' }
}

function Read-DpapiPlaintext([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $cipher = (Get-Content -Raw -LiteralPath $Path).Trim()
    if (-not $cipher) { return $null }
    $secure = ConvertTo-SecureString $cipher
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  } catch { return $null }
}

function Export-PortableSecrets([string]$DataRoot, [string]$Destination) {
  $secretRoot = Join-Path $DataRoot 'secrets'
  $items = @()
  foreach ($fileName in @(
    'llm-api-key.dpapi', 'tts-api-key.dpapi', 'voice-clone-api-key.dpapi',
    'avatar-clone-api-key.dpapi', 'voice-clone-aliyun-api-key.dpapi',
    'voice-clone-baidu-api-key.dpapi', 'avatar-clone-aliyun-credentials.dpapi',
    'avatar-clone-baidu-api-key.dpapi', 'vtube-studio.dpapi'
  )) {
    $plain = Read-DpapiPlaintext (Join-Path $secretRoot $fileName)
    if ([string]::IsNullOrWhiteSpace($plain)) { continue }
    $items += [ordered]@{ fileName = $fileName; valueBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)) }
    $plain = $null
  }
  if (-not ($items | Where-Object { $_.fileName -eq 'llm-api-key.dpapi' })) {
    throw 'The configured DeepSeek secret could not be exported from the current Windows account.'
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  [ordered]@{ version = 1; createdAt = [DateTimeOffset]::Now.ToString('o'); secrets = $items } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Destination -Encoding UTF8
}

function Export-Obs([string]$Destination) {
  $obsRoot = Join-Path $env:APPDATA 'obs-studio'
  $sceneDirectory = Join-Path $obsRoot 'basic\scenes'
  $sceneFile = Get-ChildItem -LiteralPath $sceneDirectory -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'meihua-stage' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $sceneFile) { throw 'The active Meihua OBS browser source was not found.' }
  $collection = Get-Content -Raw -LiteralPath $sceneFile.FullName | ConvertFrom-Json
  $browser = @($collection.sources | Where-Object { $_.id -eq 'browser_source' -and $_.settings.url -match 'meihua-stage' })[0]
  $scene = @($collection.sources | Where-Object { $_.id -eq 'scene' })[0]
  if (-not $browser -or -not $scene) { throw 'OBS scene collection does not contain the unified stage.' }
  $browser.settings.url = 'http://127.0.0.1:5173/obs/source/meihua-stage'
  $browser.settings.width = 1080
  $browser.settings.height = 1920
  if ($browser.settings.PSObject.Properties.Name -notcontains 'shutdown') { $browser.settings | Add-Member shutdown $false } else { $browser.settings.shutdown = $false }
  if ($browser.settings.PSObject.Properties.Name -notcontains 'restart_when_active') { $browser.settings | Add-Member restart_when_active $true } else { $browser.settings.restart_when_active = $true }
  $browserItem = @($scene.settings.items | Where-Object { $_.source_uuid -eq $browser.uuid })[0]
  if (-not $browserItem) { throw 'OBS unified stage item was not found in the scene.' }
  $browserItem.visible = $true
  $browserItem.locked = $true
  $scene.settings.items = @($browserItem)
  $collection.name = 'MeihuaStudio'
  $collection.sources = @($browser, $scene)
  New-Item -ItemType Directory -Path (Join-Path $Destination 'scenes') -Force | Out-Null
  $collection | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $Destination 'scenes\MeihuaStudio.json') -Encoding UTF8

  $profile = Get-ChildItem -LiteralPath (Join-Path $obsRoot 'basic\profiles') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'basic.ini') } | Select-Object -First 1
  if ($profile) { Copy-Tree $profile.FullName (Join-Path $Destination 'profiles\MeihuaStudio') @() @('*.bak') }
}

if (-not (Test-Path -LiteralPath $releaseParent)) { New-Item -ItemType Directory -Path $releaseParent -Force | Out-Null }
$releaseParentResolved = (Resolve-Path -LiteralPath $releaseParent).Path
$targetFull = [IO.Path]::GetFullPath($target)
if (-not $targetFull.StartsWith($releaseParentResolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe release target: $targetFull"
}
if (Test-Path -LiteralPath $targetFull) {
  if (-not $ResumeFromPhase5) { Remove-Item -LiteralPath $targetFull -Recurse -Force }
} elseif ($ResumeFromPhase5) {
  throw "Cannot resume because the release directory does not exist: $targetFull"
}
New-Item -ItemType Directory -Path $targetFull -Force | Out-Null
$sourceData = Join-Path $source 'app\data'
$targetData = Join-Path $targetFull 'app\data'

if (-not $ResumeFromPhase5) {
Write-Host '1/7 Copying original models, runtimes, installers, desktop, and TikFinity...' -ForegroundColor Cyan
foreach ($directory in @('gptsovits', 'musetalk', 'runtime', 'desktop', 'installers', 'tikfinity', 'runtime-tools')) {
  Copy-Tree (Join-Path $source $directory) (Join-Path $targetFull $directory) @('__pycache__', '.cache', 'logs') @('*.log', '*.tmp')
}

Write-Host '2/7 Copying current production application without transient data...' -ForegroundColor Cyan
Copy-Tree (Join-Path $source 'app') (Join-Path $targetFull 'app') @(
  (Join-Path $source 'app\data'), (Join-Path $source 'app\node_modules\.cache')
) @('*.log', '*.tmp')
New-Item -ItemType Directory -Path $targetData -Force | Out-Null
foreach ($directory in @('media', 'lux3d', 'audio', 'voices')) {
  Copy-Tree (Join-Path $sourceData $directory) (Join-Path $targetData $directory) @('__pycache__') @('*.tmp')
}
foreach ($directory in @('logs', 'backups', 'secrets')) { New-Item -ItemType Directory -Path (Join-Path $targetData $directory) -Force | Out-Null }

Write-Host '3/7 Taking a consistent online snapshot of the configured production database...' -ForegroundColor Cyan
Export-Sqlite (Join-Path $sourceData 'meihua-live.db') (Join-Path $targetData 'meihua-live.db')

Write-Host '4/7 Exporting portable private settings and a clean unified OBS scene...' -ForegroundColor Cyan
$privateRoot = Join-Path $targetFull 'private-config'
Export-PortableSecrets $sourceData (Join-Path $privateRoot 'secrets.portable.json')
Export-Obs (Join-Path $privateRoot 'obs')
}

Write-Host '5/7 Updating launchers, setup tools, documentation, and exact source snapshot...' -ForegroundColor Cyan
$sourceSnapshotName = (Get-ChildItem -LiteralPath $source -Directory | Where-Object { $_.Name -like '5-*' } | Select-Object -First 1).Name
if (-not $sourceSnapshotName) { throw 'The source snapshot directory name could not be resolved.' }
Copy-Tree $source $targetFull @('app', 'gptsovits', 'musetalk', 'runtime', 'desktop', 'installers', 'tikfinity', (Join-Path $source $sourceSnapshotName), 'backups', 'deploy-backups', 'logs', 'runtime-tools') @('*.log', '*.tmp')
foreach ($tool in @('verify-bundle.ps1','setup-assistant.ps1','start-bundle-silent.ps1','bootstrap-bundle.ps1','import-portable-config.ps1','resolve-gpu-profile.ps1')) {
  Copy-Item -LiteralPath (Join-Path $project "scripts\$tool") -Destination (Join-Path $targetFull "runtime-tools\$tool") -Force
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $project 'scripts\package-source.ps1') `
  -ProjectRoot $project -Destination (Join-Path $targetFull $sourceSnapshotName) `
  -PythonExe (Join-Path $source 'gptsovits\runtime\python.exe') -RuntimeDataRoot $sourceData `
  -GptSoVitsRoot (Join-Path $source 'gptsovits') -MuseTalkRoot (Join-Path $source 'musetalk')
if ($LASTEXITCODE -ne 0) { throw 'Source snapshot packaging failed.' }

Write-Host '6/7 Writing private-package guide and build identity...' -ForegroundColor Cyan
$gitRevision = (git -C $project rev-parse --short HEAD).Trim()
$identity = [ordered]@{ version = $gitRevision; builtAt = [DateTimeOffset]::Now.ToString('o'); source = $project; configuredFrom = $source; database = 'online-consistent-snapshot'; privateConfiguredPackage = $true }
$identity | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $targetFull 'BUILD-INFO.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $project 'docs\PORTABLE-CONFIGURED-PACKAGE.txt') -Destination (Join-Path $targetFull '00-PRIVATE-START-HERE.txt') -Force

Write-Host '7/7 Configured release directory is ready.' -ForegroundColor Green
Write-Host $targetFull -ForegroundColor Green
exit 0
