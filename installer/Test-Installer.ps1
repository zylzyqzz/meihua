[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $installerRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-Installer([bool]$Condition, [string]$Message) {
  if ($Condition) { Write-Host "[OK] $Message" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Message" -ForegroundColor Red; $failures.Add($Message) }
}

$manifestPath = Join-Path $installerRoot 'components.json'
try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json }
catch { $manifest = $null; $failures.Add("组件清单无法解析：$($_.Exception.Message)") }

Assert-Installer ([bool]$manifest) 'components.json 可以解析'
if ($manifest) {
  $ids = @($manifest.components.id)
  Assert-Installer (($ids | Select-Object -Unique).Count -eq $ids.Count) '组件 ID 唯一'
  Assert-Installer ($ids -contains 'core') '包含必需的 core 组件'
  Assert-Installer ([bool](($manifest.components | Where-Object id -eq 'core').required)) 'core 不可取消'
  foreach ($component in $manifest.components) {
    foreach ($dependency in @($component.dependsOn) | Where-Object { $_ }) {
      Assert-Installer ($ids -contains $dependency) "$($component.id) 的依赖 $dependency 存在"
    }
  }
  foreach ($property in @('kokoroModelSha256', 'kokoroVoicesSha256', 'whisperTinySha256')) {
    Assert-Installer ([string]$manifest.pinnedSources.$property -match '^[A-Fa-f0-9]{64}$') "$property 是合法 SHA-256"
  }
}

foreach ($relative in @(
  'MeihuaInstaller.bat',
  'MeihuaInstaller.ps1',
  'Install-MeihuaComponents.ps1',
  'overlays\musetalk\musetalk\utils\preprocessing.py',
  'overlays\musetalk\scripts\realtime_inference.py',
  'overlays\gptsovits-v3\api_v3.py',
  'overlays\gptsovits-v3\start_api.py',
  'overlays\gptsovits-v3\requirements.txt',
  'overlays\musetalk\LICENSE.upstream',
  'overlays\gptsovits-v3\LICENSE.upstream'
)) {
  Assert-Installer (Test-Path -LiteralPath (Join-Path $installerRoot $relative)) "存在 $relative"
}

foreach ($script in @(
  (Join-Path $installerRoot 'MeihuaInstaller.ps1'),
  (Join-Path $installerRoot 'Install-MeihuaComponents.ps1'),
  (Join-Path $repositoryRoot 'scripts\start-kokoro-tts.ps1'),
  (Join-Path $repositoryRoot 'scripts\start-gptsovits.ps1'),
  (Join-Path $repositoryRoot 'scripts\start-musetalk-service.ps1')
)) {
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
  Assert-Installer ($errors.Count -eq 0) "PowerShell 语法正确：$(Split-Path -Leaf $script)"
}

$oversized = @(Get-ChildItem -LiteralPath $installerRoot -Recurse -File | Where-Object Length -ge 95MB)
Assert-Installer ($oversized.Count -eq 0) '安装器目录没有接近 GitHub 100 MB 限制的单文件'

if ($failures.Count) {
  Write-Host "安装器自检失败：$($failures.Count) 项" -ForegroundColor Red
  exit 1
}
Write-Host '安装器自检全部通过。' -ForegroundColor Green
