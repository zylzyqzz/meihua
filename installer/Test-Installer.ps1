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
try { $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json }
catch { $manifest = $null; $failures.Add("组件清单无法解析：$($_.Exception.Message)") }

Assert-Installer ([bool]$manifest) 'components.json 可以解析'
Assert-Installer ($manifest.components[0].name -eq '梅花直播中控') 'Windows PowerShell 读取中文组件名正确'
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
  'Test-DownloadRecovery.ps1',
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

$launcherPath = Join-Path $installerRoot 'START-INSTALLER.cmd'
$launcherBytes = [IO.File]::ReadAllBytes($launcherPath)
$launcherText = [Text.Encoding]::ASCII.GetString($launcherBytes)
Assert-Installer (-not ($launcherBytes | Where-Object { $_ -gt 127 })) '启动入口仅使用 ASCII 字符'
Assert-Installer (-not ($launcherText -match '(?<!\r)\n')) '启动入口使用 Windows CRLF 换行'

$syntaxScripts = @(
  (Join-Path $installerRoot 'MeihuaInstaller.ps1'),
  (Join-Path $installerRoot 'Install-MeihuaComponents.ps1')
)
if (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json')) {
  $syntaxScripts += @(
    (Join-Path $repositoryRoot 'scripts\start-kokoro-tts.ps1'),
    (Join-Path $repositoryRoot 'scripts\start-gptsovits.ps1'),
    (Join-Path $repositoryRoot 'scripts\start-musetalk-service.ps1')
  )
}
foreach ($script in $syntaxScripts) {
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
  Assert-Installer ($errors.Count -eq 0) "PowerShell 语法正确：$(Split-Path -Leaf $script)"
}

$backendText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installerRoot 'Install-MeihuaComponents.ps1')
$guiText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installerRoot 'MeihuaInstaller.ps1')
Assert-Installer ($backendText -match "ValidateSet\('Check', 'Repair', 'Install'\)") '后端支持检查、补依赖、安装三段流程'
Assert-Installer ($backendText -match 'function Repair-Dependencies') '存在缺什么补什么的一键依赖修复逻辑'
Assert-Installer ($backendText -match 'python-3\.10\.11-amd64\.exe') '无 winget 时可从官方安装 Python 3.10'
Assert-Installer ($backendText -match 'ffmpeg-release-essentials\.zip') '可自动安装 FFmpeg'
Assert-Installer ($backendText -match 'vc_redist\.x64\.exe') '可自动安装 Microsoft VC++ 运行库'
Assert-Installer ($backendText -match '--continue-at') '大文件下载支持断点续传'
Assert-Installer ($backendText -match 'for \(\$attempt = 1; \$attempt -le 5') '下载中断后最多自动恢复五次'
Assert-Installer ($backendText -match '已下载部分会保留') '下载失败时保留缓存'
Assert-Installer ($backendText -match 'payload\\meihua-live-source\.zip') '支持内置源码载荷，无需登录私有 GitHub'
Assert-Installer ($backendText -match 'Set-ComponentInstallState') '组件安装状态可持久化并继续'
Assert-Installer ($backendText -match 'Test-ComponentReady') '重复安装前会复检并跳过已完成组件'
Assert-Installer ($guiText -match 'x:Name="RepairButton"') '界面包含“一键补齐依赖”按钮'
Assert-Installer ($guiText -match '\$exitCode -eq 0') '界面以真实退出码判断成功，不误判普通 stderr'
Assert-Installer ($guiText -match '继续安装') '失败后界面明确提供继续安装'

$oversized = @(Get-ChildItem -LiteralPath $installerRoot -Recurse -File | Where-Object Length -ge 95MB)
Assert-Installer ($oversized.Count -eq 0) '安装器目录没有接近 GitHub 100 MB 限制的单文件'

if ($failures.Count) {
  Write-Host "安装器自检失败：$($failures.Count) 项" -ForegroundColor Red
  exit 1
}
Write-Host '安装器自检全部通过。' -ForegroundColor Green
