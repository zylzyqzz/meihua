[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $installerRoot 'Install-MeihuaComponents.ps1'
$testRoot = Join-Path $env:TEMP ('MeihuaInstallerDownloadTest-' + [Guid]::NewGuid().ToString('N'))
$InstallRoot = $testRoot
$repositoryRoot = Split-Path -Parent $installerRoot
$stateRoot = Join-Path $testRoot 'state'
$logRoot = Join-Path $testRoot 'logs'
$logPath = Join-Path $logRoot 'download-test.log'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installerRoot 'components.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $stateRoot, $logRoot | Out-Null

try {
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($backendPath, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw '安装后端脚本无法解析。' }
  foreach ($functionAst in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $functionAst.Extent.Text
  }

  $url = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  $reference = Join-Path $testRoot 'reference.txt'
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $reference -TimeoutSec 60
  $referenceBytes = [IO.File]::ReadAllBytes($reference)
  if ($referenceBytes.Length -lt 256) { throw '下载测试文件异常。' }
  $destination = Join-Path $testRoot 'downloads\SHASUMS256.txt'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  $prefix = [byte[]]::new(128)
  [Array]::Copy($referenceBytes, $prefix, 128)
  [IO.File]::WriteAllBytes("$destination.partial", $prefix)

  Save-Download $url $destination
  $expected = (Get-FileHash -Algorithm SHA256 -LiteralPath $reference).Hash
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
  if ($actual -ne $expected) { throw '断点续传后的文件与源文件不一致。' }
  if (-not ((Get-Content -Raw -LiteralPath $logPath) -match '已有缓存')) { throw '日志没有报告续传缓存。' }
  Write-Host '[OK] 断点续传真测通过：已有部分文件被继续下载，最终内容一致。' -ForegroundColor Green
} finally {
  $safeTempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedTestRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testRoot)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

