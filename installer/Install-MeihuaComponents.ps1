[CmdletBinding()]
param(
  [ValidateSet('Check', 'Repair', 'Install')]
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
  [Console]::Out.WriteLine(("[{0}] {1}" -f $Level, $Message))
}

function Write-ProgressEvent([int]$Percent, [string]$Message) {
  [Console]::Out.WriteLine(("@@PROGRESS {0} {1}" -f ([Math]::Max(0, [Math]::Min(100, $Percent))), $Message))
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
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Git、winget、curl 等命令会把正常进度写入 stderr。Windows PowerShell 5
    # 在 Stop 模式下会把第一行 stderr 包装成 NativeCommandError，导致成功命令被误判。
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
      $text = [string]$_
      Add-Content -LiteralPath $logPath -Value $text -Encoding UTF8
      [Console]::Out.WriteLine($text)
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "命令执行失败（$exitCode）：$display" }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Format-ByteSize([long]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
  return "$Bytes B"
}

function Quote-NativeArgument([string]$Value) {
  if ($null -eq $Value) { return '""' }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-ResumableCurlDownload([string]$Curl, [string]$Source, [string]$Partial) {
  $arguments = @(
    '--location', '--fail', '--silent', '--show-error',
    '--connect-timeout', '20', '--speed-time', '120', '--speed-limit', '1024',
    '--continue-at', '-', '--output', $Partial, $Source
  )
  $argumentLine = ($arguments | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' '
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Curl
  $startInfo.Arguments = $argumentLine
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw '无法启动 curl 下载进程。' }
  $startedAt = Get-Date
  $lastReportAt = [DateTime]::MinValue
  try {
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 2
      $process.Refresh()
      if (((Get-Date) - $lastReportAt).TotalSeconds -ge 10) {
        $bytes = if (Test-Path -LiteralPath $Partial) { (Get-Item -LiteralPath $Partial).Length } else { 0 }
        $elapsed = [Math]::Max(1, ((Get-Date) - $startedAt).TotalSeconds)
        $speed = [long]($bytes / $elapsed)
        Write-InstallerLog ("下载中：{0}，已缓存 {1}，平均 {2}/秒；中断后再次安装会从这里继续" -f `
          (Split-Path -Leaf $Partial), (Format-ByteSize $bytes), (Format-ByteSize $speed))
        $lastReportAt = Get-Date
      }
    }
    $process.WaitForExit()
    $rawDetail = $process.StandardError.ReadToEnd()
    $detail = if ($rawDetail) { $rawDetail.Trim() } else { '' }
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
      if (-not $detail) { $detail = "curl 返回错误码 $exitCode" }
      throw $detail
    }
  } finally {
    $process.Dispose()
  }
}

function Get-FfmpegPath {
  $command = Get-CommandPath 'ffmpeg.exe'
  if ($command) { return $command }
  $bundled = Join-Path $InstallRoot 'runtime\ffmpeg\ffmpeg.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  return $null
}

function Invoke-SilentInstaller([string]$FilePath, [string[]]$ArgumentList, [bool]$Elevated = $false) {
  Write-InstallerLog ("运行安装程序：{0}" -f (Split-Path -Leaf $FilePath))
  $parameters = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    Wait = $true
    PassThru = $true
  }
  if ($Elevated) { $parameters.Verb = 'RunAs' }
  $process = Start-Process @parameters
  if ($process.ExitCode -notin @(0, 1641, 3010)) {
    throw "安装程序返回错误码 $($process.ExitCode)：$FilePath"
  }
}

function Install-DirectDependency([string]$PackageId, [string]$Label) {
  $downloads = Join-Path $InstallRoot 'downloads\dependencies'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  switch ($PackageId) {
    'Git.Git' {
      Write-InstallerLog '本机没有 winget，改用 Git for Windows 官方安装包。' 'WARN'
      $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'MeihuaInstaller' }
      $asset = $release.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
      if (-not $asset) { throw '无法从 Git for Windows 官方发布页找到 64 位安装程序。' }
      $installer = Join-Path $downloads $asset.name
      Save-Download $asset.browser_download_url $installer
      Invoke-SilentInstaller $installer @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-')
    }
    'OpenJS.NodeJS.LTS' {
      Write-InstallerLog '本机没有 winget，改用 Node.js 官方 LTS 安装包。' 'WARN'
      $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
      $nodeRelease = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-msi') } | Select-Object -First 1
      if (-not $nodeRelease) { throw '无法从 Node.js 官方发布页找到 Windows x64 LTS 安装包。' }
      $fileName = 'node-{0}-x64.msi' -f $nodeRelease.version
      $installer = Join-Path $downloads $fileName
      Save-Download ("https://nodejs.org/dist/{0}/{1}" -f $nodeRelease.version, $fileName) $installer
      Invoke-SilentInstaller 'msiexec.exe' @('/i', ('"{0}"' -f $installer), '/qn', '/norestart') $true
    }
    default { throw "本机没有 winget，且 $Label 暂无直接安装方案。" }
  }
}

function Ensure-WingetPackage([string]$CommandName, [string]$PackageId, [string]$Label) {
  if (Get-CommandPath $CommandName) { Write-InstallerLog "$Label 已安装" 'OK'; return }
  $winget = Get-CommandPath 'winget.exe'
  if ($winget) {
    Write-InstallerLog "正在通过 winget 安装 $Label..."
    Invoke-Checked $winget @('install', '--id', $PackageId, '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  } else {
    Install-DirectDependency $PackageId $Label
  }
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
    & $python -c 'import sys;sys.exit(0 if sys.version_info[:2]==(3,10) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { return $python }
  }
  foreach ($candidate in @(
    (Join-Path $InstallRoot 'runtime\python310\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
    (Join-Path $env:ProgramFiles 'Python310\python.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Python310\python.exe')
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Ensure-Python310 {
  $python = Get-Python310
  if ($python) { Write-InstallerLog "Python 3.10 已安装：$python" 'OK'; return $python }
  $winget = Get-CommandPath 'winget.exe'
  if ($winget) {
    Invoke-Checked $winget @('install', '--id', 'Python.Python.3.10', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  } else {
    Write-InstallerLog '本机没有 winget，改用 Python 官方 3.10.11 安装包。' 'WARN'
    $installer = Join-Path $InstallRoot 'downloads\dependencies\python-3.10.11-amd64.exe'
    $pythonRoot = Join-Path $InstallRoot 'runtime\python310'
    Save-Download 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe' $installer
    Invoke-SilentInstaller $installer @(
      '/quiet', 'InstallAllUsers=0', ("TargetDir=$pythonRoot"), 'PrependPath=0',
      'Include_launcher=0', 'Include_doc=0', 'Include_test=0', 'Shortcuts=0'
    )
    $pythonScripts = Join-Path $pythonRoot 'Scripts'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($userPath -split ';')
    foreach ($entry in @($pythonRoot, $pythonScripts)) {
      if ($entry -and -not ($pathEntries -contains $entry)) { $pathEntries += $entry }
    }
    [Environment]::SetEnvironmentVariable('Path', ($pathEntries | Where-Object { $_ }) -join ';', 'User')
  }
  Refresh-ProcessPath
  $python = Get-Python310
  if (-not $python) { throw 'Python 3.10 安装后仍不可用；请重新打开安装器。' }
  return $python
}

function Ensure-Pnpm {
  if (Get-CommandPath 'pnpm.cmd') { Write-InstallerLog 'pnpm 已安装' 'OK'; return }
  $corepack = Get-CommandPath 'corepack.cmd'
  if ($corepack) {
    Invoke-Checked $corepack @('enable')
    Invoke-Checked $corepack @('prepare', 'pnpm@11.19.0', '--activate')
  } else {
    $npm = Get-CommandPath 'npm.cmd'
    if (-not $npm) { throw 'Node.js 已安装，但未找到 npm/corepack。' }
    Invoke-Checked $npm @('install', '--global', 'pnpm@11.19.0', '--registry', 'https://registry.npmjs.org/')
  }
  Refresh-ProcessPath
  if (-not (Get-CommandPath 'pnpm.cmd')) { throw 'pnpm 安装后仍不可用；请重新打开安装器。' }
}

function Ensure-Ffmpeg {
  $existing = Get-FfmpegPath
  if ($existing) { Write-InstallerLog "FFmpeg 已安装：$existing" 'OK'; return }
  $archive = Join-Path $InstallRoot 'downloads\dependencies\ffmpeg-release-essentials.zip'
  $runtimeRoot = Join-Path $InstallRoot 'runtime\ffmpeg'
  Save-Download @(
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
  ) $archive
  $expanded = Join-Path $InstallRoot ('downloads\dependencies\ffmpeg-expand-{0}' -f (Get-Date -Format 'yyyyMMddHHmmss'))
  New-Item -ItemType Directory -Force -Path $expanded, $runtimeRoot | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $ffmpeg = Get-ChildItem -LiteralPath $expanded -Recurse -Filter 'ffmpeg.exe' -File | Select-Object -First 1
  if (-not $ffmpeg) { throw 'FFmpeg 压缩包中没有找到 ffmpeg.exe。' }
  Copy-Item -Path (Join-Path $ffmpeg.Directory.FullName '*') -Destination $runtimeRoot -Force
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $runtimeRoot)) {
    [Environment]::SetEnvironmentVariable('Path', (@($userPath, $runtimeRoot) | Where-Object { $_ }) -join ';', 'User')
  }
  Refresh-ProcessPath
  if (-not (Get-FfmpegPath)) { throw 'FFmpeg 已解压，但安装后仍不可用。' }
  Write-InstallerLog "FFmpeg 已安装：$runtimeRoot" 'OK'
}

function Test-VcRuntimeInstalled {
  return Test-Path -LiteralPath "$env:SystemRoot\System32\vcruntime140.dll"
}

function Ensure-VcRuntime {
  if (Test-VcRuntimeInstalled) { Write-InstallerLog 'Microsoft VC++ 运行库已安装' 'OK'; return }
  $installer = Join-Path $InstallRoot 'downloads\dependencies\vc_redist.x64.exe'
  Save-Download 'https://aka.ms/vs/17/release/vc_redist.x64.exe' $installer
  Invoke-SilentInstaller $installer @('/install', '/quiet', '/norestart') $true
  if (-not (Test-VcRuntimeInstalled)) { throw 'Microsoft VC++ 运行库安装后仍不可用，可能需要重启电脑。' }
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

function Save-Download([string[]]$Uri, [string]$Destination, [string]$Sha256 = '') {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  if ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt 0 -and `
      (-not $Sha256 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash -eq $Sha256)) {
    Write-InstallerLog "已存在并通过校验：$(Split-Path -Leaf $Destination)" 'OK'
    return
  }
  $partial = "$Destination.partial"
  if ((Test-Path -LiteralPath $partial) -and $Sha256 -and `
      (Get-Item -LiteralPath $partial).Length -gt 0 -and `
      (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash -eq $Sha256) {
    Move-Item -LiteralPath $partial -Destination $Destination -Force
    Write-InstallerLog "找到上次已经下载完成的缓存并通过校验：$(Split-Path -Leaf $Destination)" 'OK'
    return
  }
  if (Test-Path -LiteralPath $Destination) {
    Write-InstallerLog "现有文件校验失败，将重新下载：$(Split-Path -Leaf $Destination)" 'WARN'
    Remove-Item -LiteralPath $Destination -Force
  }
  $errors = [System.Collections.Generic.List[string]]::new()
  foreach ($source in @($Uri)) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      try {
        $cachedBytes = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
        Write-InstallerLog ("正在下载（第 {0}/5 次）：{1}；已有缓存 {2}" -f $attempt, $source, (Format-ByteSize $cachedBytes))
        $curl = Get-CommandPath 'curl.exe'
        if ($curl) {
          Invoke-ResumableCurlDownload $curl $source $partial
        } else {
          Write-InstallerLog '系统未找到 curl，本次使用 PowerShell 下载；建议更新 Windows 以获得断点续传能力。' 'WARN'
          Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $partial -TimeoutSec 3600
        }
        if (-not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -le 0) {
          throw '服务器没有返回有效文件'
        }
        if ($Sha256 -and (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash -ne $Sha256) {
          # A completed file with the wrong checksum cannot be safely resumed.
          Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
          throw 'SHA-256 校验不一致，已丢弃损坏缓存'
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
        Write-InstallerLog ("下载完成：{0}（{1}）" -f (Split-Path -Leaf $Destination), (Format-ByteSize (Get-Item -LiteralPath $Destination).Length)) 'OK'
        return
      } catch {
        $message = $_.Exception.Message
        $errors.Add("$source 第 $attempt 次 -> $message")
        if ($attempt -lt 5) {
          $delaySeconds = [Math]::Min(30, 3 * $attempt)
          Write-InstallerLog ("下载暂时中断：{0}。已下载部分会保留，{1} 秒后继续。" -f $message, $delaySeconds) 'WARN'
          Start-Sleep -Seconds $delaySeconds
        } else {
          Write-InstallerLog "当前下载源连续失败，准备尝试备用源；已下载缓存仍然保留。" 'WARN'
        }
      }
    }
  }
  $cached = if (Test-Path -LiteralPath $partial) { Format-ByteSize (Get-Item -LiteralPath $partial).Length } else { '0 B' }
  throw ("所有下载源暂时不可用，已保留 $cached 缓存。网络恢复后再次点击安装即可续传。详情：{0}" -f ($errors -join '；'))
}

function Test-ObsInstalled {
  $knownPaths = @(
    "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe",
    "${env:ProgramFiles(x86)}\obs-studio\bin\64bit\obs64.exe",
    "$env:LOCALAPPDATA\Programs\obs-studio\bin\64bit\obs64.exe",
    'D:\ruanjian\obs-studio\bin\64bit\obs64.exe'
  )
  if ($knownPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1) { return $true }
  if (Get-Process -Name 'obs64' -ErrorAction SilentlyContinue | Select-Object -First 1) { return $true }
  foreach ($registryRoot in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    $obsEntry = Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
      Where-Object { $_.DisplayName -match '^OBS Studio' } | Select-Object -First 1
    if ($obsEntry) { return $true }
  }
  return $false
}

function Test-VbCableInstalled {
  return [bool](Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CABLE|VB-Audio' } | Select-Object -First 1)
}

function Test-TikfinityInstalled {
  return Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\tikfinity\TikFinity.exe')
}

function Test-PythonImports([string]$Python, [string]$Imports) {
  if (-not $Python -or -not (Test-Path -LiteralPath $Python)) { return $false }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Python -c $Imports 2>$null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
  finally { $ErrorActionPreference = $previousPreference }
}

function Get-EnvironmentReport {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  $driveName = [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\').TrimEnd(':')
  $drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
  $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
  $installedProjectRoot = if (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json')) {
    $repositoryRoot
  } elseif (Test-Path -LiteralPath (Join-Path $InstallRoot 'meihua-live\package.json')) {
    Join-Path $InstallRoot 'meihua-live'
  } else { '' }
  $gptRoot = if ($installedProjectRoot) { Join-Path $installedProjectRoot 'external\gptsovits-v3' } else { '' }
  $museTalkRoot = if ($installedProjectRoot) { Join-Path $installedProjectRoot 'external\musetalk' } else { '' }
  $openVoiceRoot = if ($installedProjectRoot) { Join-Path $installedProjectRoot 'external\openvoice' } else { '' }
  $kokoroRoot = if ($installedProjectRoot) { Join-Path $installedProjectRoot 'services\kokoro-tts' } else { '' }
  $bundledFfmpeg = [bool]($installedProjectRoot -and @(Get-ChildItem -Path (Join-Path $installedProjectRoot 'node_modules\.pnpm\ffmpeg-static@*\node_modules\ffmpeg-static\ffmpeg.exe') -File -ErrorAction SilentlyContinue).Count)
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    installRoot = $InstallRoot
    windows = if ($os) { $os.Caption } else { [Environment]::OSVersion.VersionString }
    windows64Bit = [Environment]::Is64BitOperatingSystem
    freeDiskGb = if ($drive) { [Math]::Round($drive.Free / 1GB, 1) } else { 0 }
    powershell51 = ($PSVersionTable.PSVersion.Major -ge 5)
    winget = [bool](Get-CommandPath 'winget.exe')
    vcRuntime = Test-VcRuntimeInstalled
    git = [bool](Get-CommandPath 'git.exe')
    node = [bool](Get-CommandPath 'node.exe')
    pnpm = [bool](Get-CommandPath 'pnpm.cmd')
    python310 = [bool](Get-Python310)
    ffmpeg = [bool]((Get-FfmpegPath) -or $bundledFfmpeg)
    nvidia = [bool]$gpu
    nvidiaName = if ($gpu) { $gpu.Name } else { '' }
    nvidiaSmi = [bool](Get-CommandPath 'nvidia-smi.exe')
    cudaToolkit = [bool](Get-CommandPath 'nvcc.exe')
    obs = Test-ObsInstalled
    vbCable = Test-VbCableInstalled
    tikfinity = Test-TikfinityInstalled
    projectRoot = $installedProjectRoot
    repositoryAvailable = [bool]$installedProjectRoot
    repositoryIsGit = [bool]($installedProjectRoot -and (Test-Path -LiteralPath (Join-Path $installedProjectRoot '.git')))
    nodeDependencies = [bool]($installedProjectRoot -and (Test-Path -LiteralPath (Join-Path $installedProjectRoot 'node_modules')))
    productionBuild = [bool]($installedProjectRoot -and
      (Test-Path -LiteralPath (Join-Path $installedProjectRoot 'apps\admin\dist\index.html')) -and
      (Test-Path -LiteralPath (Join-Path $installedProjectRoot 'apps\overlay\dist\index.html')) -and
      (Test-Path -LiteralPath (Join-Path $installedProjectRoot 'apps\orchestrator\dist\app.js')))
    kokoroRuntime = [bool]($kokoroRoot -and (Test-Path -LiteralPath (Join-Path $kokoroRoot '.venv\Scripts\python.exe')))
    kokoroModel = [bool]($kokoroRoot -and (Test-Path -LiteralPath (Join-Path $kokoroRoot 'models\kokoro-v1.0.onnx')))
    kokoroVoices = [bool]($kokoroRoot -and (Test-Path -LiteralPath (Join-Path $kokoroRoot 'models\voices-v1.0.bin')))
    gptSoVitsRuntime = [bool]($gptRoot -and (Test-Path -LiteralPath (Join-Path $gptRoot 'runtime\Scripts\python.exe')))
    gptSoVitsModels = [bool]($gptRoot -and (Test-Path -LiteralPath (Join-Path $gptRoot 'GPT_SoVITS\pretrained_models')))
    whisperModel = [bool]($gptRoot -and (Test-Path -LiteralPath (Join-Path $gptRoot 'tools\asr\models\openai-whisper\tiny.pt')))
    museTalkRuntime = [bool]($museTalkRoot -and (Test-Path -LiteralPath (Join-Path $museTalkRoot '.venv\Scripts\python.exe')))
    museTalkModels = [bool]($museTalkRoot -and (Test-Path -LiteralPath (Join-Path $museTalkRoot 'models')))
    openVoiceRuntime = [bool]($openVoiceRoot -and (Test-Path -LiteralPath (Join-Path $openVoiceRoot '.venv\Scripts\python.exe')))
    openVoiceModels = [bool]($openVoiceRoot -and (Test-Path -LiteralPath (Join-Path $openVoiceRoot 'checkpoints_v2\converter\config.json')))
  }
  $reportPath = Join-Path $stateRoot 'environment.json'
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  return [pscustomobject]$report
}

function Write-EnvironmentCheck([bool]$Ready, [string]$Label, [string]$ReadyText, [string]$MissingText) {
  if ($Ready) { Write-InstallerLog ("{0}：{1}" -f $Label, $ReadyText) 'OK' }
  else { Write-InstallerLog ("{0}：{1}" -f $Label, $MissingText) 'WARN' }
}

function Write-EnvironmentSummary($Report) {
  Write-InstallerLog '—— 系统与磁盘 ——'
  Write-EnvironmentCheck $Report.windows64Bit 'Windows' ("{0}，64 位" -f $Report.windows) '不是 64 位 Windows，无法安装'
  Write-EnvironmentCheck ($Report.freeDiskGb -ge 3) '磁盘空间' ("可用 {0} GB" -f $Report.freeDiskGb) ("仅剩 {0} GB，至少需要 3 GB" -f $Report.freeDiskGb)

  Write-InstallerLog '—— 开发环境与依赖 ——'
  Write-EnvironmentCheck $Report.powershell51 'PowerShell' ("版本 {0}，可运行安装器" -f $PSVersionTable.PSVersion) '版本低于 5.1，需先更新 Windows PowerShell'
  Write-EnvironmentCheck $Report.winget 'Windows 应用安装器' 'winget 可用' '未安装 winget；不阻断，一键补齐会改用各软件官方安装包'
  Write-EnvironmentCheck $Report.vcRuntime 'Microsoft VC++ 运行库' '已安装' '未安装；本地模型运行需要，点击“一键补齐依赖”自动安装'
  Write-EnvironmentCheck $Report.git 'Git' '已安装，可下载源码' '未安装；点击“一键补齐依赖”自动安装'
  Write-EnvironmentCheck $Report.node 'Node.js' '已安装' '未安装；点击“一键补齐依赖”自动安装'
  Write-EnvironmentCheck $Report.pnpm 'pnpm' '已安装' '未安装；点击“一键补齐依赖”自动配置'
  Write-EnvironmentCheck $Report.python310 'Python 3.10' '已安装' '未安装；本地语音与数字人需要，点击“一键补齐依赖”自动安装'
  Write-EnvironmentCheck $Report.ffmpeg 'FFmpeg' '已安装，可处理音视频' '未安装；点击“一键补齐依赖”自动下载并配置'

  Write-InstallerLog '—— 显卡与驱动 ——'
  Write-EnvironmentCheck $Report.nvidia 'NVIDIA 显卡' $Report.nvidiaName '未检测到；不影响主中控和 Kokoro，实时数字人只能使用 CPU 或云服务'
  Write-EnvironmentCheck $Report.nvidiaSmi 'NVIDIA 驱动' '驱动命令可用' '未检测到；本地实时数字人不能标记为直播就绪'
  Write-EnvironmentCheck $Report.cudaToolkit 'CUDA 工具包' '已安装' '未检测到；仅影响本地实时数字人和口音模型'

  Write-InstallerLog '—— 主中控与前端 ——'
  Write-EnvironmentCheck $Report.repositoryAvailable '梅花源码' ("已存在：{0}" -f $Report.projectRoot) '尚未下载；点击开始安装后从私有仓库下载'
  Write-EnvironmentCheck $Report.repositoryIsGit '仓库版本管理' 'Git 仓库完整' '尚未建立；首次安装需要 GitHub 私有仓库访问权限'
  Write-EnvironmentCheck $Report.nodeDependencies 'Node 依赖' '已安装' '尚未安装；开始安装时自动执行'
  Write-EnvironmentCheck $Report.productionBuild '生产构建' '管理端、中控服务和 OBS 画面均已构建' '尚未完成；开始安装时自动构建'

  Write-InstallerLog '—— 声音、识别与数字人模型 ——'
  Write-EnvironmentCheck ($Report.kokoroRuntime -and $Report.kokoroModel -and $Report.kokoroVoices) 'Kokoro 英文女声' '运行环境、模型和四个女声包齐全' '未完整安装；勾选 Kokoro 后自动下载并校验'
  Write-EnvironmentCheck ($Report.gptSoVitsRuntime -and $Report.gptSoVitsModels) 'GPT-SoVITS 声音克隆' '运行环境和预训练模型齐全' '可选组件未完整安装'
  Write-EnvironmentCheck $Report.whisperModel 'Whisper 语音识别' '离线模型已安装' '可选组件未安装；勾选 Whisper 后自动安装'
  Write-EnvironmentCheck ($Report.museTalkRuntime -and $Report.museTalkModels) 'MuseTalk 实时数字人' '运行环境和模型目录齐全' '可选组件未完整安装；实时使用还需要 NVIDIA/CUDA'
  Write-EnvironmentCheck ($Report.openVoiceRuntime -and $Report.openVoiceModels) 'OpenVoice 口音转换' '运行环境和模型齐全' '可选组件未完整安装'

  Write-InstallerLog '—— 直播软件与音频驱动 ——'
  Write-EnvironmentCheck $Report.obs 'OBS Studio' '已安装' '未安装；默认组件会自动安装'
  Write-EnvironmentCheck $Report.vbCable 'VB-CABLE 音频驱动' '已安装，可建立统一 Audio Bus' '未安装；安装时会下载，驱动确认需要手动点击'
  Write-EnvironmentCheck $Report.tikfinity 'TikFinity' '已安装' '未安装；安装时会下载，账号登录需要手动完成'
  Write-InstallerLog 'DeepSeek / 云模型配置：出于安全原因，安装包不携带 API Key；安装完成后在中控填写，并以“真实调用成功”为准。' 'INFO'

  $defaultReady = $Report.windows64Bit -and ($Report.freeDiskGb -ge 3) -and $Report.git -and $Report.node -and
    $Report.pnpm -and $Report.repositoryAvailable -and $Report.nodeDependencies -and $Report.productionBuild -and
    $Report.ffmpeg -and $Report.kokoroRuntime -and $Report.kokoroModel -and $Report.kokoroVoices -and
    $Report.obs -and $Report.vbCable -and $Report.tikfinity
  if ($defaultReady) {
    Write-InstallerLog '结论：默认“英文女声 + 预录视频 + OBS”链路所需环境已齐全。' 'OK'
  } else {
    $repairable = @(
      (-not $Report.vcRuntime), (-not $Report.git), (-not $Report.node), (-not $Report.pnpm),
      (-not $Report.python310), (-not $Report.ffmpeg), (-not $Report.obs),
      (-not $Report.vbCable), (-not $Report.tikfinity)
    ) | Where-Object { $_ }
    Write-InstallerLog ('结论：当前检测到 {0} 个可补齐的环境/软件缺项。先点【一键补齐依赖】，成功后再点【安装所选组件】；模型、源码和生产构建会在第二步安装。' -f $repairable.Count) 'WARN'
  }
}

function Test-ProjectSourceComplete([string]$Path) {
  return (Test-Path -LiteralPath (Join-Path $Path 'package.json')) -and `
    (Test-Path -LiteralPath (Join-Path $Path 'pnpm-lock.yaml')) -and `
    (Test-Path -LiteralPath (Join-Path $Path 'apps\orchestrator\package.json')) -and `
    (Test-Path -LiteralPath (Join-Path $Path 'scripts\start-production.ps1'))
}

function Expand-PortableProjectSource([string]$Archive, [string]$Target) {
  $staging = Join-Path $InstallRoot ('.source-staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    Write-InstallerLog '正在解压安装器自带的主中控源码；此步骤不需要登录 GitHub。'
    Expand-Archive -LiteralPath $Archive -DestinationPath $staging -Force
    $sourceRoot = if (Test-ProjectSourceComplete $staging) {
      $staging
    } else {
      Get-ChildItem -LiteralPath $staging -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-ProjectSourceComplete $_.FullName } | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $sourceRoot) { throw '安装器内置源码包结构不完整。' }
    if (Test-Path -LiteralPath $Target) {
      $backup = "$Target.incomplete-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Move-Item -LiteralPath $Target -Destination $backup
      Write-InstallerLog "发现未完成的源码目录，已保留到：$backup" 'WARN'
    }
    if ($sourceRoot -eq $staging) {
      Move-Item -LiteralPath $staging -Destination $Target
      $staging = ''
    } else {
      Move-Item -LiteralPath $sourceRoot -Destination $Target
    }
    if (-not (Test-ProjectSourceComplete $Target)) { throw '主中控源码解压后校验失败。' }
    Write-InstallerLog "主中控源码已就绪：$Target" 'OK'
  } finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
  }
}

function Resolve-ProjectRoot {
  if (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json')) { return $repositoryRoot }
  $target = Join-Path $InstallRoot 'meihua-live'
  if (Test-ProjectSourceComplete $target) {
    Write-InstallerLog '检测到已经解压完成的主中控源码，本次直接继续，不重复下载。' 'OK'
    return $target
  }
  $portableArchive = Join-Path $installerRoot 'payload\meihua-live-source.zip'
  if (Test-Path -LiteralPath $portableArchive) {
    Expand-PortableProjectSource $portableArchive $target
    return $target
  }
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    try {
      Invoke-Checked (Get-CommandPath 'git.exe') @(
        '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=20',
        'clone', '--branch', $manifest.repository.branch, $manifest.repository.url, $target
      )
    } catch {
      if (Test-Path -LiteralPath (Join-Path $target 'package.json')) {
        Write-InstallerLog 'GitHub 连接中断，但源码文件已经完整下载；继续使用本地源码安装。' 'WARN'
      } else {
        throw '主中控源码下载失败。当前安装器没有离线源码载荷，且本机没有私有仓库权限。请使用完整版安装器，或登录有权访问 zylzyqzz/meihua 的 GitHub 账号。'
      }
    }
  } else {
    Write-InstallerLog '检测到已经下载好的主中控源码，本次直接复用，不重复联网拉取。' 'OK'
  }
  return $target
}

function Write-InstalledLaunchers([string]$ProjectRoot) {
  $launcher = Join-Path $InstallRoot 'START-MEIHUA.cmd'
  $powerShellLauncher = Join-Path $InstallRoot 'START-MEIHUA.ps1'
  $scriptContent = @'
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'meihua-live'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'scripts\start-production.ps1'))) {
  throw "没有找到已经安装的梅花直播系统：$projectRoot"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\start-production.ps1')
'@
  [IO.File]::WriteAllText($powerShellLauncher, $scriptContent, [Text.UTF8Encoding]::new($true))
  $cmdContent = @(
    '@echo off',
    'chcp 65001 >nul',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0START-MEIHUA.ps1"',
    'if errorlevel 1 pause'
  ) -join "`r`n"
  [IO.File]::WriteAllText($launcher, $cmdContent + "`r`n", [Text.Encoding]::ASCII)
  Write-InstallerLog "一键启动入口已创建：$launcher" 'OK'
}

function Install-Core([string]$ProjectRoot) {
  Ensure-WingetPackage 'node.exe' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
  Ensure-Pnpm
  $pnpm = Get-CommandPath 'pnpm.cmd'
  if (-not $pnpm) { throw 'pnpm 安装失败。' }
  Invoke-Checked $pnpm @(
    'install', '--frozen-lockfile', '--reporter', 'append-only', '--fetch-timeout', '60000',
    '--registry', 'https://registry.npmjs.org/'
  ) $ProjectRoot
  Invoke-Checked $pnpm @('build') $ProjectRoot
  Write-InstalledLaunchers $ProjectRoot
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
  Invoke-Checked $venvPython @('-c', 'import kokoro_onnx,soundfile,fastapi,uvicorn,pydantic')
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
  if ($winget) {
    Invoke-Checked $winget @('install', '--id', 'OBSProject.OBSStudio', '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  } else {
    Write-InstallerLog '本机没有 winget，改用 OBS Studio 官方 GitHub 安装包。' 'WARN'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/obsproject/obs-studio/releases/latest' -Headers @{ 'User-Agent' = 'MeihuaInstaller' }
    $asset = $release.assets | Where-Object { $_.name -match 'Full-Installer-x64\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw '无法从 OBS Studio 官方发布页找到 64 位安装程序。' }
    $installer = Join-Path $InstallRoot ('downloads\dependencies\{0}' -f $asset.name)
    Save-Download $asset.browser_download_url $installer
    Invoke-SilentInstaller $installer @('/S') $true
  }
  if (-not (Test-ObsInstalled)) { throw 'OBS Studio 安装后仍未检测到；请重新打开安装器复检。' }
}

function Set-ComponentInstallState([string]$Id, [string]$Status, [string]$Message = '') {
  $progressRoot = Join-Path $InstallRoot '.meihua-installer'
  New-Item -ItemType Directory -Force -Path $progressRoot | Out-Null
  [ordered]@{
    component = $Id
    status = $Status
    message = $Message
    updatedAt = [DateTimeOffset]::Now.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $progressRoot "component-$Id.json") -Encoding UTF8
}

function Test-ComponentReady([string]$Id, [string]$ProjectRoot) {
  switch ($Id) {
    'core' {
      return (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\admin\dist\index.html')) -and `
        (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\overlay\dist\index.html')) -and `
        ((Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\orchestrator\dist\index.cjs')) -or `
         (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\orchestrator\dist\app.js')))
    }
    'kokoro' {
      $root = Join-Path $ProjectRoot 'services\kokoro-tts'
      $venvPython = Join-Path $root '.venv\Scripts\python.exe'
      return (Test-Path -LiteralPath $venvPython) -and `
        (Test-Path -LiteralPath (Join-Path $root 'models\kokoro-v1.0.onnx')) -and `
        (Test-Path -LiteralPath (Join-Path $root 'models\voices-v1.0.bin')) -and `
        ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'models\kokoro-v1.0.onnx')).Hash -eq $manifest.pinnedSources.kokoroModelSha256) -and `
        ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'models\voices-v1.0.bin')).Hash -eq $manifest.pinnedSources.kokoroVoicesSha256) -and `
        (Test-PythonImports $venvPython 'import kokoro_onnx,soundfile,fastapi,uvicorn,pydantic')
    }
    'gptsovits' {
      $root = Join-Path $ProjectRoot 'external\gptsovits-v3'
      return (Test-Path -LiteralPath (Join-Path $root 'runtime\Scripts\python.exe')) -and `
        (Test-Path -LiteralPath (Join-Path $root 'GPT_SoVITS\pretrained_models'))
    }
    'asr' { return Test-Path -LiteralPath (Join-Path $ProjectRoot 'external\gptsovits-v3\tools\asr\models\openai-whisper\tiny.pt') }
    'musetalk' {
      $root = Join-Path $ProjectRoot 'external\musetalk'
      return (Test-Path -LiteralPath (Join-Path $root '.venv\Scripts\python.exe')) -and (Test-Path -LiteralPath (Join-Path $root 'models'))
    }
    'openvoice' {
      $root = Join-Path $ProjectRoot 'external\openvoice'
      return (Test-Path -LiteralPath (Join-Path $root '.venv\Scripts\python.exe')) -and `
        (Test-Path -LiteralPath (Join-Path $root 'checkpoints_v2\converter\config.json'))
    }
    'obs' { return Test-ObsInstalled }
    'vbcable' { return Test-VbCableInstalled }
    'tikfinity' { return Test-TikfinityInstalled }
  }
  return $false
}

function Repair-Dependencies([System.Collections.Generic.List[string]]$Selected) {
  $steps = [System.Collections.Generic.List[object]]::new()
  $steps.Add(@{ Label = 'Git'; Run = { Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git' } })
  $steps.Add(@{ Label = 'Node.js'; Run = { Ensure-WingetPackage 'node.exe' 'OpenJS.NodeJS.LTS' 'Node.js LTS' } })
  $steps.Add(@{ Label = 'pnpm'; Run = { Ensure-Pnpm } })
  if (@('kokoro','gptsovits','asr','musetalk','openvoice') | Where-Object { $Selected.Contains($_) }) {
    $steps.Add(@{ Label = 'Python 3.10'; Run = { Ensure-Python310 | Out-Null } })
  }
  $steps.Add(@{ Label = 'FFmpeg'; Run = { Ensure-Ffmpeg } })
  $steps.Add(@{ Label = 'Microsoft VC++ 运行库'; Run = { Ensure-VcRuntime } })
  if ($Selected.Contains('obs')) { $steps.Add(@{ Label = 'OBS Studio'; Run = { Install-Obs } }) }
  if ($Selected.Contains('vbcable')) { $steps.Add(@{ Label = 'VB-CABLE'; Run = { Install-VbCable } }) }
  if ($Selected.Contains('tikfinity')) { $steps.Add(@{ Label = 'TikFinity'; Run = { Install-Tikfinity } }) }

  $failures = [System.Collections.Generic.List[string]]::new()
  $index = 0
  foreach ($step in $steps) {
    $index++
    $percent = 8 + [int](82 * ($index - 1) / [Math]::Max(1, $steps.Count))
    Write-ProgressEvent $percent ("正在检查并补齐：{0}" -f $step.Label)
    try {
      & $step.Run
    } catch {
      $message = $_.Exception.Message
      $failures.Add("$($step.Label)：$message")
      Write-InstallerLog ("{0} 暂未补齐：{1}。安装器将继续检查其他项目。" -f $step.Label, $message) 'FAIL'
    }
  }
  if (($Selected.Contains('musetalk') -or $Selected.Contains('openvoice')) -and -not (Get-CommandPath 'nvidia-smi.exe')) {
    Write-InstallerLog '未检测到可用 NVIDIA 驱动。本地实时数字人/口音模型可以安装，但不能标记为 CUDA 实时直播就绪；显卡驱动需按显卡型号从 NVIDIA 官方安装。' 'WARN'
  }
  return $failures
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
  Refresh-ProcessPath
  Write-ProgressEvent 2 '正在检查 Windows 环境'
  $report = Get-EnvironmentReport
  Write-InstallerLog ("Windows：{0}；磁盘可用：{1} GB；NVIDIA：{2}" -f $report.windows, $report.freeDiskGb, $(if ($report.nvidia) { $report.nvidiaName } else { '未检测到' }))
  if (-not $report.windows64Bit) { throw '只支持 64 位 Windows 10/11。' }
  if ($Action -eq 'Check') {
    Write-EnvironmentSummary $report
    Write-ProgressEvent 100 '环境检查完成'
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
  if ($Action -eq 'Repair') {
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    $repairFailures = @(Repair-Dependencies $selected)
    Write-ProgressEvent 94 '正在复检补齐结果'
    $afterRepair = Get-EnvironmentReport
    Write-EnvironmentSummary $afterRepair
    if ($repairFailures.Count) {
      throw ("以下依赖暂未安装成功，其他成功项目已经保留；再次点击【一键补齐依赖】会继续：{0}" -f ($repairFailures -join '；'))
    }
    Write-ProgressEvent 100 '缺失依赖补齐完成，可以安装所选组件'
    exit 0
  }
  $requiredGb = [Math]::Round((@($manifest.components | Where-Object { $selected.Contains($_.id) } | ForEach-Object estimatedGb) | Measure-Object -Sum).Sum + 2, 1)
  if ($report.freeDiskGb -lt $requiredGb) { throw "磁盘空间不足：所选组件约需 $requiredGb GB，目前仅余 $($report.freeDiskGb) GB。" }

  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $projectRoot = Resolve-ProjectRoot
  $count = $selected.Count
  $componentFailures = [System.Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt $count; $index++) {
    $id = $selected[$index]
    $percent = 8 + [int](84 * $index / [Math]::Max(1, $count))
    $label = ($manifest.components | Where-Object id -eq $id | Select-Object -First 1).name
    if (Test-ComponentReady $id $projectRoot) {
      Write-ProgressEvent $percent "已安装，跳过重复处理：$label"
      Set-ComponentInstallState $id 'READY' '复检通过，直接复用'
      continue
    }
    Write-ProgressEvent $percent "正在安装或继续：$label"
    Set-ComponentInstallState $id 'INSTALLING'
    try {
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
      if (-not (Test-ComponentReady $id $projectRoot)) {
        throw '安装命令已结束，但最终完整性检查仍未通过'
      }
      Set-ComponentInstallState $id 'READY' '安装与复检通过'
    } catch {
      $message = $_.Exception.Message
      Set-ComponentInstallState $id 'FAILED' $message
      $componentFailures.Add("${label}：$message")
      Write-InstallerLog ("{0} 本轮未完成：{1}。已经下载的内容会保留，继续处理其他组件。" -f $label, $message) 'FAIL'
    }
  }

  if ($componentFailures.Count) {
    throw ("有 {0} 个组件暂未完成，其余成果均已保留。网络或权限恢复后再次点击安装即可继续：{1}" -f `
      $componentFailures.Count, ($componentFailures -join '；'))
  }

  $sourceRevision = if (Test-Path -LiteralPath (Join-Path $projectRoot '.git')) {
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      (& git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -Last 1)
    } finally { $ErrorActionPreference = $previousPreference }
  } else {
    'portable-source-' + ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot 'package.json')).Hash.Substring(0, 12).ToLowerInvariant())
  }
  $installState = [ordered]@{
    schemaVersion = 1
    installedAt = [DateTimeOffset]::Now.ToString('o')
    projectRoot = $projectRoot
    installRoot = $InstallRoot
    components = @($selected)
    sourceRevision = $sourceRevision
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
  [Console]::Out.WriteLine('@@FAILED')
  exit 1
}
