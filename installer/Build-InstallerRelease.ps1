[CmdletBinding()]
param(
  [string]$Version = '1.0.5',
  [string]$OutputRoot = 'E:\meihua\release-downloader'
)

$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $installerRoot
$stage = Join-Path $OutputRoot "stage-v$Version"
$portableFolder = Join-Path $OutputRoot "01-复制到新电脑-双击打开-v$Version"
$archive = Join-Path $OutputRoot "MeihuaInstaller-v$Version.zip"

function Assert-SafeOutputPath([string]$Path) {
  $resolvedRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\') + '\'
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝处理输出目录以外的路径：$resolvedPath"
  }
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
foreach ($path in @($stage, $portableFolder, $archive)) {
  Assert-SafeOutputPath $path
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($name in @(
  'components.json', 'Install-MeihuaComponents.ps1', 'MeihuaInstaller.ps1',
  'MeihuaInstaller.bat', 'START-INSTALLER.cmd', '启动梅花安装器.cmd',
  'README.md', 'THIRD-PARTY-SOURCES.md', 'Test-Installer.ps1', 'Test-DownloadRecovery.ps1'
)) {
  Copy-Item -LiteralPath (Join-Path $installerRoot $name) -Destination (Join-Path $stage $name) -Force
}
Copy-Item -LiteralPath (Join-Path $installerRoot 'overlays') -Destination (Join-Path $stage 'overlays') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'logs'), (Join-Path $stage 'state'), (Join-Path $stage 'payload') | Out-Null

$sourceArchive = Join-Path $stage 'payload\meihua-live-source.zip'
$git = Get-Command git.exe -ErrorAction Stop
# FFmpeg is installed and repaired independently. Keeping its 81 MB executable
# inside the source payload would duplicate the same dependency and push the
# portable source archive over GitHub's single-file limit.
& $git.Source -C $projectRoot archive --format=zip --output=$sourceArchive HEAD -- . `
  ':(exclude)tools/ffmpeg/ffmpeg.exe' ':(exclude)tools/ffmpeg/ffmpeg.exe.gz'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sourceArchive)) { throw '无法生成内置主源码载荷。' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stage 'Test-Installer.ps1')
if ($LASTEXITCODE -ne 0) { throw '安装器发布前自检失败。' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stage 'Test-DownloadRecovery.ps1')
if ($LASTEXITCODE -ne 0) { throw '安装器断点续传真测失败。' }

Copy-Item -LiteralPath $stage -Destination $portableFolder -Recurse -Force
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
[ordered]@{
  version = $Version
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  archive = $archive
  sha256 = $hash
  sourceRevision = (& $git.Source -C $projectRoot rev-parse HEAD | Select-Object -Last 1)
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputRoot "MeihuaInstaller-v$Version.json") -Encoding UTF8

Write-Host "安装器目录：$portableFolder" -ForegroundColor Green
Write-Host "压缩包：$archive" -ForegroundColor Green
Write-Host "SHA256：$hash" -ForegroundColor Green


