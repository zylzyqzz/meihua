[CmdletBinding()]
param(
  [ValidateSet('Check', 'Install')]
  [string]$Action = 'Check',
  [string]$InstallRoot = '',
  [string[]]$Components = @('core', 'kokoro', 'obs', 'vbcable', 'tikfinity'),
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $installerRoot
$manifestPath = Join-Path $installerRoot 'components.json'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json

if (-not $InstallRoot) {
  $drive = if (Test-Path -LiteralPath 'D:\') { 'D:\' } else { 'C:\' }
  $InstallRoot = Join-Path $drive $manifest.defaults.installFolder
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$stateRoot = Join-Path $installerRoot 'state'
$logRoot = Join-Path $installerRoot 'logs'
New-Item -ItemType Directory -Force -Path $stateRoot, $logRoot | Out-Null
$logPath = Join-Path $logRoot ('install-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-InstallerLog([string]$Message, [ValidateSet('INFO','OK','WARN','FAIL')] [string]$Level = 'INFO') {
  $line = '{0:o} [{1}] {2}' -f [DateTimeOffset]::Now, $Level, $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Output ("[{0}] {1}" -f $Level, $Message)
}

function Write-ProgressEvent([int]$Percent, [string]$Message) {
  Write-Output ("@@PROGRESS {0} {1}" -f ([Math]::Max(0, [Math]::Min(100, $Percent))), $Message)
  Write-InstallerLog $Message
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user) -join ';'
}

function Get-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory = '') {
  $display = "$FilePath $($ArgumentList -join ' ')"
  Write-InstallerLog "运行：$display"
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
      $text = [string]$_
      Add-Content -LiteralPath $logPath -Value $text -Encoding UTF8
      Write-Output $text
    }
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败（$LASTEXITCODE）：$display" }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Ensure-WingetPackage([string]$CommandName, [string]$PackageId, [string]$Label) {
  if (Get-CommandPath $CommandName) { Write-InstallerLog "$Label 已安装" 'OK'; return }
  $winget = Get-CommandPath 'winget.exe'
  if (-not $winget) { throw "缺少 $Label，且本机没有 winget。请先从 Microsoft Store 安装应用安装程序。" }
  Write-InstallerLog "正在安装 $Label..."
  Invoke-Checked $winget @('install', '--id', $PackageId, '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  Refresh-ProcessPath
  if (-not (Get-CommandPath $CommandName)) { throw "$Label 安装后仍不可用；请重新打开安装器。" }
}

function Get-Python310 {
  $py = Get-CommandPath 'py.exe'
  if ($py) {
    $candidate = & $py -3.10 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -Last 1
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return [string]$candidate }
  }
  $python = Get-CommandPath 'python.exe'
  if ($python) {
    $version = & $python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>$null | Select-Object -Last 1
    if ($version -eq '3.10') { return $python }
  }
  return $null
}

function Ensure-Python310 {
  $python = Get-Python310
  if ($python) { Write-InstallerLog "Python 3.10 已安装：$python" 'OK'; return $python }
  $winget = Get-CommandPath 'winget.exe'
  if (-not $winget) { throw '缺少 Python 3.10，且本机没有 winget。' }
  Invoke-Checked $winget @('install', '--id', 'Python.Python.3.10', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  Refresh-ProcessPath
  $python = Get-Python310
  if (-not $python) { throw 'Python 3.10 安装后仍不可用；请重新打开安装器。' }
  return $python
}

function Ensure-Venv([string]$Python, [string]$VenvPath) {
  $venvPython = Join-Path $VenvPath 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython)) {
    Invoke-Checked $Python @('-m', 'venv', $VenvPath)
  }
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel')
  return $venvPython
}

function Ensure-HuggingFaceCli([string]$VenvPython) {
  Invoke-Checked $VenvPython @('-m', 'pip', 'install', '--disable-pip-version-check', 'huggingface_hub[hf_xet]')
  $hf = Join-Path (Split-Path -Parent $VenvPython) 'hf.exe'
  if (-not (Test-Path -LiteralPath $hf)) { throw 'Hugging Face CLI 安装后不可用。' }
  return $hf
}

function Save-Download([string]$Uri, [string]$Destination, [string]$Sha256 = '') {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  if ((Test-Path -LiteralPath $Destination) -and (-not $Sha256 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash -eq $Sha256)) {
    Write-InstallerLog "已存在并通过校验：$(Split-Path -Leaf $Destination)" 'OK'
    return
  }
  $partial = "$Destination.partial"
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  $curl = Get-CommandPath 'curl.exe'
  if ($curl) { Invoke-Checked $curl @('-L', '--fail', '--retry', '4', '--retry-delay', '2', '--output', $partial, $Uri) }
  else { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $partial }
  if ($Sha256 -and (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash -ne $Sha256) {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    throw "下载文件校验失败：$Destination"
  }
  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Test-ObsInstalled {
  return [bool](@(
    "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe",
    "${env:ProgramFiles(x86)}\obs-studio\bin\64bit\obs64.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Test-VbCableInstalled {
  return [bool](Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CABLE|VB-Audio' } | Select-Object -First 1)
}

function Test-TikfinityInstalled {
  return Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\tikfinity\TikFinity.exe')
}

function Get-EnvironmentReport {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  $driveName = [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\').TrimEnd(':')
  $drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
  $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    installRoot = $InstallRoot
    windows = if ($os) { $os.Caption } else { [Environment]::OSVersion.VersionString }
    windows64Bit = [Environment]::Is64BitOperatingSystem
    freeDiskGb = if ($drive) { [Math]::Round($drive.Free / 1GB, 1) } else { 0 }
    git = [bool](Get-CommandPath 'git.exe')
    node = [bool](Get-CommandPath 'node.exe')
    pnpm = [bool](Get-CommandPath 'pnpm.cmd')
    python310 = [bool](Get-Python310)
    ffmpeg = [bool](Get-CommandPath 'ffmpeg.exe')
    nvidia = [bool]$gpu
    nvidiaName = if ($gpu) { $gpu.Name } else { '' }
    nvidiaSmi = [bool](Get-CommandPath 'nvidia-smi.exe')
    obs = Test-ObsInstalled
    vbCable = Test-VbCableInstalled
    tikfinity = Test-TikfinityInstalled
    repositoryAvailable = Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json')
  }
  $reportPath = Join-Path $stateRoot 'environment.json'
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  return [pscustomobject]$report
}

function Resolve-ProjectRoot {
  if (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json')) { return $repositoryRoot }
  $target = Join-Path $InstallRoot 'meihua-live'
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Invoke-Checked (Get-CommandPath 'git.exe') @('clone', '--branch', $manifest.repository.branch, $manifest.repository.url, $target)
  } else {
    Invoke-Checked (Get-CommandPath 'git.exe') @('-C', $target, 'pull', '--ff-only')
  }
  return $target
}

function Install-Core([string]$ProjectRoot) {
  Ensure-WingetPackage 'node.exe' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  if (-not (Get-CommandPath 'pnpm.cmd')) {
    $corepack = Get-CommandPath 'corepack.cmd'
    if (-not $corepack) { throw 'Node.js 已安装，但未找到 corepack。' }
    Invoke-Checked $corepack @('enable')
    Invoke-Checked $corepack @('prepare', 'pnpm@11.19.0', '--activate')
    Refresh-ProcessPath
  }
  $pnpm = Get-CommandPath 'pnpm.cmd'
  if (-not $pnpm) { throw 'pnpm 安装失败。' }
  Invoke-Checked $pnpm @('install', '--frozen-lockfile') $ProjectRoot
  Invoke-Checked $pnpm @('build') $ProjectRoot
  Write-InstallerLog '梅花直播中控已构建完成' 'OK'
}

function Install-Kokoro([string]$ProjectRoot) {
  $python = Ensure-Python310
  $serviceRoot = Join-Path $ProjectRoot 'services\kokoro-tts'
  $venvPython = Ensure-Venv $python (Join-Path $serviceRoot '.venv')
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', (Join-Path $serviceRoot 'requirements.txt'))
  $models = Join-Path $serviceRoot 'models'
  Save-Download $manifest.pinnedSources.kokoroModelUrl (Join-Path $models 'kokoro-v1.0.onnx') $manifest.pinnedSources.kokoroModelSha256
  Save-Download $manifest.pinnedSources.kokoroVoicesUrl (Join-Path $models 'voices-v1.0.bin') $manifest.pinnedSources.kokoroVoicesSha256
  Invoke-Checked $venvPython @('-c', 'import kokoro_onnx, soundfile; print("KOKORO_READY")')
  Write-InstallerLog 'Kokoro 英文女声已安装并通过导入校验' 'OK'
}

function Install-GptSoVits([string]$ProjectRoot) {
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  $python = Ensure-Python310
  $target = Join-Path $ProjectRoot 'external\gptsovits-v3'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    Invoke-Checked (Get-CommandPath 'git.exe') @('clone', '--branch', $manifest.pinnedSources.gptSoVitsTag, '--depth', '1', 'https://github.com/RVC-Boss/GPT-SoVITS.git', $target)
  }
  Copy-Item -Path (Join-Path $installerRoot 'overlays\gptsovits-v3\*') -Destination $target -Recurse -Force
  $venvPython = Ensure-Venv $python (Join-Path $target 'runtime')
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', (Join-Path $target 'requirements.txt'))
  $hf = Ensure-HuggingFaceCli $venvPython
  Invoke-Checked $hf @('download', 'lj1995/GPT-SoVITS', '--local-dir', (Join-Path $target 'GPT_SoVITS\pretrained_models'))
  Invoke-Checked $hf @('download', 'G2PW/G2PWModel-v2-onnx', '--local-dir', (Join-Path $target 'GPT_SoVITS\text\G2PWModel'))
  [Environment]::SetEnvironmentVariable('GPT_SOVITS_HOME', $target, 'User')
  Write-InstallerLog 'GPT-SoVITS V3 与梅花兼容 API 已安装' 'OK'
}

function Install-Asr([string]$ProjectRoot) {
  $gptRoot = Join-Path $ProjectRoot 'external\gptsovits-v3'
  if (-not (Test-Path -LiteralPath (Join-Path $gptRoot 'api_v3.py'))) { Install-GptSoVits $ProjectRoot }
  Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ProjectRoot 'scripts\install-voice-asr.ps1'), '-GptSoVitsRoot', $gptRoot)
}

function Install-MuseTalk([string]$ProjectRoot) {
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  $python = Ensure-Python310
  $target = Join-Path $ProjectRoot 'external\musetalk'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    Invoke-Checked (Get-CommandPath 'git.exe') @('clone', 'https://github.com/TMElyralab/MuseTalk.git', $target)
    Invoke-Checked (Get-CommandPath 'git.exe') @('-C', $target, 'checkout', '--detach', $manifest.pinnedSources.musetalkCommit)
  }
  Copy-Item -Path (Join-Path $installerRoot 'overlays\musetalk\*') -Destination $target -Recurse -Force
  $venvPython = Ensure-Venv $python (Join-Path $target '.venv')
  $hf = Ensure-HuggingFaceCli $venvPython
  $models = Join-Path $target 'models'
  Invoke-Checked $hf @('download', 'TMElyralab/MuseTalk', '--local-dir', $models)
  Invoke-Checked $hf @('download', 'stabilityai/sd-vae-ft-mse', '--local-dir', (Join-Path $models 'sd-vae'), '--include', 'config.json', 'diffusion_pytorch_model.bin')
  Invoke-Checked $hf @('download', 'openai/whisper-tiny', '--local-dir', (Join-Path $models 'whisper'), '--include', 'config.json', 'pytorch_model.bin', 'preprocessor_config.json')
  Invoke-Checked $hf @('download', 'yzd-v/DWPose', '--local-dir', (Join-Path $models 'dwpose'), '--include', 'dw-ll_ucoco_384.pth')
  Invoke-Checked $hf @('download', 'ByteDance/LatentSync', '--local-dir', (Join-Path $models 'syncnet'), '--include', 'latentsync_syncnet.pt')
  Invoke-Checked $hf @('download', 'ManyOtherFunctions/face-parse-bisent', '--local-dir', (Join-Path $models 'face-parse-bisent'), '--include', '79999_iter.pth', 'resnet18-5c106cde.pth')
  Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ProjectRoot 'scripts\install-musetalk-runtime.ps1'), '-MuseTalkRoot', $target, '-Python', $venvPython)
  [Environment]::SetEnvironmentVariable('MUSETALK_HOME', $target, 'User')
  [Environment]::SetEnvironmentVariable('MUSETALK_PYTHON', $venvPython, 'User')
  Write-InstallerLog 'MuseTalk 固定版本、模型与梅花兼容补丁已安装' 'OK'
}

function Install-OpenVoice([string]$ProjectRoot) {
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  $python = Ensure-Python310
  $target = Join-Path $ProjectRoot 'external\openvoice'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    Invoke-Checked (Get-CommandPath 'git.exe') @('clone', '--depth', '1', 'https://github.com/myshell-ai/OpenVoice.git', $target)
  }
  $venvPython = Ensure-Venv $python (Join-Path $target '.venv')
  if (Test-Path -LiteralPath (Join-Path $target 'requirements.txt')) {
    Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', (Join-Path $target 'requirements.txt'))
  }
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-e', $target)
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', 'git+https://github.com/myshell-ai/MeloTTS.git')
  Invoke-Checked $venvPython @('-m', 'unidic', 'download')
  $checkpointArchive = Join-Path $ProjectRoot 'downloads\checkpoints_v2_0417.zip'
  Save-Download $manifest.pinnedSources.openVoiceV2CheckpointsUrl $checkpointArchive
  $checkpointRoot = Join-Path $target 'checkpoints_v2'
  if (-not (Test-Path -LiteralPath (Join-Path $checkpointRoot 'converter\config.json'))) {
    Expand-Archive -LiteralPath $checkpointArchive -DestinationPath $target -Force
  }
  if (-not (Test-Path -LiteralPath (Join-Path $checkpointRoot 'converter\config.json'))) { throw 'OpenVoice V2 模型解压后结构不完整。' }
  [Environment]::SetEnvironmentVariable('MEIHUA_ACCENT_HOME', $target, 'User')
  Write-InstallerLog 'OpenVoice V2、MeloTTS 和模型已安装；直播启用前必须在管理端通过健康检查' 'OK'
}

function Install-Obs {
  if (Test-ObsInstalled) { Write-InstallerLog 'OBS Studio 已安装' 'OK'; return }
  $winget = Get-CommandPath 'winget.exe'
  if (-not $winget) { throw '未找到 winget，无法自动安装 OBS Studio。' }
  Invoke-Checked $winget @('install', '--id', 'OBSProject.OBSStudio', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
}

function Install-VbCable {
  if (Test-VbCableInstalled) { Write-InstallerLog 'VB-CABLE 已安装' 'OK'; return }
  $archive = Join-Path $InstallRoot 'downloads\VBCABLE_Driver_Pack45.zip'
  $expanded = Join-Path $InstallRoot 'downloads\VBCABLE_Driver_Pack45'
  Save-Download 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' $archive
  if (-not (Test-Path -LiteralPath $expanded)) { Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force }
  $setup = Get-ChildItem -LiteralPath $expanded -Recurse -Filter 'VBCABLE_Setup_x64.exe' -File | Select-Object -First 1
  if (-not $setup) { throw 'VB-CABLE 安装程序缺失。' }
  if (-not $NonInteractive) {
    Write-InstallerLog '即将弹出管理员确认；请在 VB-CABLE 窗口点击 Install Driver。' 'WARN'
    Start-Process -FilePath $setup.FullName -Verb RunAs -Wait
  } else { Write-InstallerLog '非交互模式跳过 VB-CABLE 驱动界面；请稍后从 downloads 目录手动安装。' 'WARN' }
}

function Install-Tikfinity {
  if (Test-TikfinityInstalled) { Write-InstallerLog 'TikFinity 已安装' 'OK'; return }
  $installer = Join-Path $InstallRoot 'downloads\TikFinity-Setup.exe'
  Save-Download 'https://tikfinity-electron-updates.b-cdn.net/win/TikFinity-Setup-2.0.0.exe' $installer
  if (-not $NonInteractive) { Start-Process -FilePath $installer -Wait }
  else { Write-InstallerLog '非交互模式已下载 TikFinity；请稍后完成图形安装和账号登录。' 'WARN' }
}

try {
  Write-ProgressEvent 2 '正在检查 Windows 环境'
  $report = Get-EnvironmentReport
  Write-InstallerLog ("Windows：{0}；磁盘可用：{1} GB；NVIDIA：{2}" -f $report.windows, $report.freeDiskGb, $(if ($report.nvidia) { $report.nvidiaName } else { '未检测到' }))
  if (-not $report.windows64Bit) { throw '只支持 64 位 Windows 10/11。' }
  if ($Action -eq 'Check') {
    Write-ProgressEvent 100 '环境检查完成'
    $report | ConvertTo-Json -Depth 6
    exit 0
  }

  $selected = [System.Collections.Generic.List[string]]::new()
  foreach ($component in @($Components)) {
    foreach ($id in ([string]$component -split ',')) {
      if ($id -and -not $selected.Contains($id.Trim())) { $selected.Add($id.Trim()) }
    }
  }
  if (-not $selected.Contains('core')) { $selected.Insert(0, 'core') }
  foreach ($id in @($selected)) {
    $definition = $manifest.components | Where-Object id -eq $id | Select-Object -First 1
    if (-not $definition) { throw "未知组件：$id" }
    foreach ($dependency in @($definition.dependsOn)) {
      if ($dependency -and -not $selected.Contains([string]$dependency)) { $selected.Add([string]$dependency) }
    }
  }
  $requiredGb = [Math]::Round((@($manifest.components | Where-Object { $selected.Contains($_.id) } | ForEach-Object estimatedGb) | Measure-Object -Sum).Sum + 2, 1)
  if ($report.freeDiskGb -lt $requiredGb) { throw "磁盘空间不足：所选组件约需 $requiredGb GB，目前仅余 $($report.freeDiskGb) GB。" }

  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $projectRoot = Resolve-ProjectRoot
  $count = $selected.Count
  for ($index = 0; $index -lt $count; $index++) {
    $id = $selected[$index]
    $percent = 8 + [int](84 * $index / [Math]::Max(1, $count))
    $label = ($manifest.components | Where-Object id -eq $id | Select-Object -First 1).name
    Write-ProgressEvent $percent "正在安装：$label"
    switch ($id) {
      'core' { Install-Core $projectRoot }
      'kokoro' { Install-Kokoro $projectRoot }
      'gptsovits' { Install-GptSoVits $projectRoot }
      'asr' { Install-Asr $projectRoot }
      'musetalk' { Install-MuseTalk $projectRoot }
      'openvoice' { Install-OpenVoice $projectRoot }
      'obs' { Install-Obs }
      'vbcable' { Install-VbCable }
      'tikfinity' { Install-Tikfinity }
    }
  }

  $installState = [ordered]@{
    schemaVersion = 1
    installedAt = [DateTimeOffset]::Now.ToString('o')
    projectRoot = $projectRoot
    installRoot = $InstallRoot
    components = @($selected)
    sourceRevision = (& git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -Last 1)
    manifest = $manifest.pinnedSources
  }
  $installState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stateRoot 'installation.json') -Encoding UTF8
  Write-ProgressEvent 96 '正在执行最终环境复检'
  Get-EnvironmentReport | Out-Null
  Write-ProgressEvent 100 '安装完成，可以运行梅花直播系统'
  Write-InstallerLog "项目目录：$projectRoot" 'OK'
  exit 0
} catch {
  Write-InstallerLog $_.Exception.Message 'FAIL'
  Write-Output '@@FAILED'
  exit 1
}
