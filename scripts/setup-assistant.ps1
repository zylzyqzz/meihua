[CmdletBinding()]
param(
  [string]$BundleRoot = '',
  [switch]$CheckOnly,
  [switch]$AutoInstall
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $candidate 'app')) {
    # Flat bundle tool layout: <bundle>\安装工具\environment.ps1.
  } elseif (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $candidate) 'app')) {
    # Current distribution: <bundle>\安装工具\内部\environment.ps1.
    $candidate = Split-Path -Parent $candidate
  } elseif ((Split-Path -Leaf $candidate) -eq 'app') {
    $candidate = Split-Path -Parent $candidate
  }
  $BundleRoot = $candidate
}
$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$installerDirectory = Join-Path $bundle 'installers'
New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null

function Write-Status([string]$State, [string]$Label, [string]$Detail = '') {
  $color = if ($State -eq 'OK') { 'Green' } elseif ($State -eq 'WARN') { 'Yellow' } else { 'Red' }
  $suffix = if ($Detail) { " - $Detail" } else { '' }
  Write-Host ("[{0}] {1}{2}" -f $State, $Label, $suffix) -ForegroundColor $color
}

function Find-Obs {
  $candidates = [System.Collections.Generic.List[string]]@(
    "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe",
    "${env:ProgramFiles(x86)}\obs-studio\bin\64bit\obs64.exe"
  )
  Get-Process obs64,obs32 -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $candidates.Add($_.Path) } }
  $command = Get-Command obs64.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { $candidates.Add($command.Source) }
  $uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $uninstallRoots) {
    Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^OBS Studio' } | ForEach-Object {
      if ($_.DisplayIcon) { $candidates.Add(([string]$_.DisplayIcon).Trim('"').Split(',')[0]) }
      if ($_.InstallLocation) { $candidates.Add((Join-Path ([string]$_.InstallLocation) 'bin\64bit\obs64.exe')) }
      # Portable/custom OBS installs often register only a DisplayIcon or an
      # uninstall command such as D:\ruanjian\obs-studio\bin\64bit\obs64.exe.
      # Extract that executable rather than assuming Program Files.
      foreach ($rawPath in @($_.DisplayIcon, $_.UninstallString)) {
        if (-not $rawPath) { continue }
        $match = [regex]::Match([string]$rawPath, '(?i)([A-Z]:\\.*?obs(?:64|32)?\.exe)')
        if ($match.Success) { $candidates.Add($match.Groups[1].Value) }
      }
    }
  }
  $shortcutRoots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  try {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutRoot in $shortcutRoots) {
      Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'OBS' } | ForEach-Object { $candidates.Add($shell.CreateShortcut($_.FullName).TargetPath) }
    }
  } catch { }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Find-Tikfinity {
  $candidates = @(
    (Join-Path $bundle 'tikfinity\TikFinity.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\tikfinity\TikFinity.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Test-VbCable {
  try {
    $device = Get-PnpDevice -ErrorAction Stop | Where-Object { $_.FriendlyName -match 'CABLE (Input|Output)|VB-Audio|VB-CABLE' } | Select-Object -First 1
    if ($device) { return $true }
  } catch {
    $device = Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CABLE|VB-Audio' } | Select-Object -First 1
    if ($device) { return $true }
  }
  $signedDriver = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object { $_.DeviceName -match 'CABLE|VB-Audio' -or $_.Manufacturer -match 'VB-Audio' -or $_.DriverProviderName -match 'VB-Audio' } | Select-Object -First 1
  if ($signedDriver) { return $true }
  try { return [bool]((pnputil.exe /enum-drivers 2>$null | Select-String -Pattern 'vbMmeCable|VB-Audio' | Select-Object -First 1)) } catch { return $false }
}

function Test-Nvidia {
  $controller = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Hardware = $controller; Smi = $smi }
}

function Test-CudaRuntime {
  $python = Join-Path $bundle 'gptsovits\runtime\python.exe'
  if (-not (Test-Path -LiteralPath $python)) { return $false }
  $result = & $python -c "import torch; print('1' if torch.cuda.is_available() else '0')" 2>$null
  return (($result | Select-Object -Last 1) -eq '1')
}

function Invoke-PackageVerification {
  $verifier = Join-Path $bundle '安装工具\内部\整包自检.ps1'
  if (-not (Test-Path -LiteralPath $verifier)) { $verifier = Join-Path $bundle '安装工具\整包自检.ps1' }
  if (-not (Test-Path -LiteralPath $verifier)) { $verifier = Join-Path $bundle 'verify-bundle.ps1' }
  if (-not (Test-Path -LiteralPath $verifier)) { Write-Status 'FAIL' '整包自检工具' '整包自检.ps1不存在'; return $false }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifier -BundleRoot $bundle | ForEach-Object { Write-Host $_ }
  $verificationPassed = ($LASTEXITCODE -eq 0)
  Write-Status $(if ($verificationPassed) { 'OK' } else { 'FAIL' }) '完整一体包' $(if ($verificationPassed) { '中控、素材、声音、数字人、依赖和源码齐全' } else { '请根据上方失败项重新复制整包' })
  return $verificationPassed
}

function Show-Environment {
  Clear-Host
  Write-Host '=== 梅花直播系统｜环境检查与安装 ===' -ForegroundColor Cyan
  Write-Host ("目录：{0}" -f $bundle)
  Write-Host ''
  $packageOk = Invoke-PackageVerification
  Write-Host ''

  $nvidia = Test-Nvidia
  if ($nvidia.Hardware -and $nvidia.Smi) { Write-Status 'OK' 'NVIDIA显卡与驱动' $nvidia.Hardware.Name }
  elseif ($nvidia.Hardware) { Write-Status 'FAIL' 'NVIDIA驱动' '检测到显卡，但nvidia-smi不可用' }
  else { Write-Status 'WARN' 'NVIDIA显卡' '未检测到；可以CPU试用，但声音和口型生成很慢' }

  $cudaReady = Test-CudaRuntime
  if ($cudaReady) { Write-Status 'OK' '本地CUDA推理' 'GPT-SoVITS与MuseTalk可使用GPU' }
  else { Write-Status 'WARN' '本地CUDA推理' '当前使用CPU，RTX机器安装Studio Driver后重新检查' }

  $obs = Find-Obs
  if ($obs) { Write-Status 'OK' 'OBS Studio' $obs } else { Write-Status 'FAIL' 'OBS Studio' '未安装' }

  $vbCable = Test-VbCable
  if ($vbCable) { Write-Status 'OK' 'VB-CABLE虚拟声卡' } else { Write-Status 'FAIL' 'VB-CABLE虚拟声卡' '未安装或安装后尚未重启' }

  $tikfinity = Find-Tikfinity
  if ($tikfinity) { Write-Status 'OK' 'TikFinity' $tikfinity } else { Write-Status 'FAIL' 'TikFinity' '未检测到' }

  $usedPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3210, 5173, 5200, 9881, 9898, 9899) }
  if ($usedPorts) {
    Write-Status 'WARN' '运行端口' ((($usedPorts.LocalPort | Sort-Object -Unique) -join ', ') + ' 已占用；可能已有梅花实例运行')
  } else { Write-Status 'OK' '运行端口' '全部可用' }

  return [pscustomobject]@{ Package=$packageOk; Nvidia=$nvidia; Cuda=$cudaReady; Obs=[bool]$obs; VbCable=$vbCable; Tikfinity=[bool]$tikfinity }
}

function Install-Obs {
  if (Find-Obs) { Write-Status 'OK' 'OBS Studio' '已经安装'; return }
  $localInstaller = Get-ChildItem -LiteralPath $installerDirectory -Filter 'OBS-Studio-*-Windows-x64-Installer.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($localInstaller) {
    Write-Host '正在静默安装包内OBS Studio...' -ForegroundColor Cyan
    Start-Process -FilePath $localInstaller.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden
    return
  }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    & $winget.Source install --id OBSProject.OBSStudio -e --accept-package-agreements --accept-source-agreements
  } else {
    Start-Process 'https://obsproject.com/download'
  }
}

function Install-VbCable {
  if (Test-VbCable) { Write-Status 'OK' 'VB-CABLE' '已经安装'; return }
  $archive = Join-Path $installerDirectory 'VBCABLE_Driver_Pack45.zip'
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Host '正在从VB-Audio官方下载VB-CABLE...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile $archive
  }
  $expanded = Join-Path $installerDirectory 'VBCABLE_Driver_Pack45'
  if (-not (Test-Path -LiteralPath $expanded)) { Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force }
  $setup = Get-ChildItem -LiteralPath $expanded -Recurse -File | Where-Object { $_.Name -eq 'VBCABLE_Setup_x64.exe' } | Select-Object -First 1
  if (-not $setup) { throw 'VB-CABLE官方安装程序未找到' }
  Write-Host '即将弹出一次Windows管理员确认和VB-CABLE官方安装页；点击 Install Driver 即可。' -ForegroundColor Yellow
  $process = Start-Process -FilePath $setup.FullName -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -notin @(0, $null)) { throw "VB-CABLE驱动安装失败（代码 $($process.ExitCode)）" }
  Write-Host 'VB-CABLE安装完成；首次安装后请重启Windows。' -ForegroundColor Green
}

function Install-Tikfinity {
  if (Find-Tikfinity) { Write-Status 'OK' 'TikFinity' '整包已包含'; return }
  $installer = Join-Path $installerDirectory 'TikFinity-Setup.exe'
  if (-not (Test-Path -LiteralPath $installer)) {
    Write-Host '正在从TikFinity官方分发地址下载...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri 'https://tikfinity-electron-updates.b-cdn.net/win/TikFinity-Setup-2.0.0.exe' -OutFile $installer
  }
  Start-Process -FilePath $installer -Wait
}

function Open-NvidiaDriver {
  Start-Process 'https://www.nvidia.com/Download/index.aspx'
  Write-Host '请选择对应显卡和Windows版本，优先安装Studio Driver；安装后重启并重新运行本工具。' -ForegroundColor Yellow
}

function Install-Missing([object]$state) {
  if (-not $state.Obs) { Install-Obs }
  if (-not $state.VbCable) { Install-VbCable }
  if (-not $state.Tikfinity) { Install-Tikfinity }
  if ($state.Nvidia.Hardware -and -not $state.Nvidia.Smi) { Open-NvidiaDriver }
}

$state = Show-Environment
if ($CheckOnly) { return }
if ($AutoInstall) {
  try {
    Install-Missing $state
    Write-Host ''
    Write-Host '自动安装流程已完成。首次安装VB-CABLE后请重启Windows。' -ForegroundColor Green
    Start-Sleep -Seconds 2
    return
  } catch {
    Write-Host ("自动安装失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host '窗口将在8秒后关闭，详细结果可重新运行本工具查看。' -ForegroundColor Yellow
    Start-Sleep -Seconds 8
    exit 1
  }
}
while ($true) {
  Write-Host ''
  Write-Host '1. 自动补齐缺失环境（推荐）'
  Write-Host '2. 只安装OBS Studio'
  Write-Host '3. 只安装VB-CABLE'
  Write-Host '4. 只安装TikFinity'
  Write-Host '5. 打开NVIDIA官方驱动页面'
  Write-Host '6. 重新检查'
  Write-Host '0. 退出'
  $choice = Read-Host '请输入数字'
  try {
    switch ($choice) {
      '1' { Install-Missing $state; $state = Show-Environment }
      '2' { Install-Obs; $state = Show-Environment }
      '3' { Install-VbCable; $state = Show-Environment }
      '4' { Install-Tikfinity; $state = Show-Environment }
      '5' { Open-NvidiaDriver }
      '6' { $state = Show-Environment }
      '0' { return }
      default { Write-Host '请输入0到6。' -ForegroundColor Yellow }
    }
  } catch {
    Write-Host ("操作失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
  }
}
