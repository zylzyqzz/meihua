Set-StrictMode -Version Latest

function ConvertTo-PositiveInt([object]$Value) {
  $parsed = 0
  # Keep this helper compatible with the Windows PowerShell 5.1 that ships on
  # a clean Windows 10/11 machine.  The ternary operator is PowerShell 7+
  # only and used to make the one-click launcher terminate before it started
  # any service on a stock system.
  if ([int]::TryParse(([string]$Value).Trim(), [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }
  return $null
}

function Get-MeihuaGpuRuntimeProfile {
  $requested = ([string]$env:MEIHUA_GPU_PROFILE).Trim().ToUpperInvariant()
  $configuredVram = ConvertTo-PositiveInt $env:MEIHUA_GPU_VRAM_MB
  $gpuName = ([string]$env:MEIHUA_GPU_NAME).Trim()
  $freeVram = ConvertTo-PositiveInt $env:MEIHUA_GPU_FREE_MB
  $vram = $configuredVram

  if (-not $vram) {
    $smi = Get-Command 'nvidia-smi.exe' -ErrorAction SilentlyContinue
    if (-not $smi) { $smi = Get-Command 'nvidia-smi' -ErrorAction SilentlyContinue }
    if ($smi) {
      try {
        $line = & $smi.Source '--query-gpu=name,memory.total,memory.free' '--format=csv,noheader,nounits' 2>$null | Select-Object -First 1
        if ($line) {
          $parts = @($line -split ',' | ForEach-Object { $_.Trim() })
          if ($parts.Count -ge 3) {
            if (-not $gpuName) { $gpuName = $parts[0] }
            $vram = ConvertTo-PositiveInt $parts[1]
            $freeVram = ConvertTo-PositiveInt $parts[2]
          }
        }
      } catch { }
    }
  }

  $id = if ($requested -in @('CPU_COMPAT', 'SAFE_8GB', 'STANDARD_12GB', 'ENHANCED_16GB')) {
    $requested
  } elseif (-not $vram) {
    'CPU_COMPAT'
  } elseif ($vram -le 8192) {
    'SAFE_8GB'
  } elseif ($vram -le 12288) {
    'STANDARD_12GB'
  } else {
    'ENHANCED_16GB'
  }

  $settings = switch ($id) {
    'SAFE_8GB' { @{ Batch = 1; AvatarWidth = 720; AvatarHeight = 1280; Prebuffer = 0; ReleaseVoiceGpu = '1'; Description = '8 GB stable mode: one GPU task at a time' } }
    'STANDARD_12GB' { @{ Batch = 2; AvatarWidth = 900; AvatarHeight = 1600; Prebuffer = 1; ReleaseVoiceGpu = '1'; Description = '12 GB standard mode: one prepared future segment' } }
    'ENHANCED_16GB' { @{ Batch = 4; AvatarWidth = 1080; AvatarHeight = 1920; Prebuffer = 2; ReleaseVoiceGpu = '1'; Description = '16 GB enhanced mode: buffered, still serialized inference' } }
    default { @{ Batch = 1; AvatarWidth = 540; AvatarHeight = 960; Prebuffer = 0; ReleaseVoiceGpu = '0'; Description = 'CPU compatibility mode: serialized low-resolution rendering' } }
  }

  $resolvedVram = if ($vram) { [int]$vram } else { 0 }
  [pscustomobject]@{
    Id = $id
    GpuName = $gpuName
    VramMb = $resolvedVram
    FreeVramMb = $freeVram
    MuseTalkBatchSize = [int]$settings.Batch
    AvatarMaxWidth = [int]$settings.AvatarWidth
    AvatarMaxHeight = [int]$settings.AvatarHeight
    PrebufferSegments = [int]$settings.Prebuffer
    ReleaseVoiceGpu = [string]$settings.ReleaseVoiceGpu
    Description = [string]$settings.Description
  }
}

function Set-MeihuaGpuRuntimeEnvironment {
  $profile = Get-MeihuaGpuRuntimeProfile
  $env:MEIHUA_GPU_PROFILE = $profile.Id
  $env:MEIHUA_GPU_VRAM_MB = [string]$profile.VramMb
  if ($profile.GpuName) { $env:MEIHUA_GPU_NAME = $profile.GpuName }
  if ($profile.FreeVramMb) { $env:MEIHUA_GPU_FREE_MB = [string]$profile.FreeVramMb }
  $env:MUSETALK_BATCH_SIZE = [string]$profile.MuseTalkBatchSize
  $env:MEIHUA_AVATAR_MAX_WIDTH = [string]$profile.AvatarMaxWidth
  $env:MEIHUA_AVATAR_MAX_HEIGHT = [string]$profile.AvatarMaxHeight
  $env:MEIHUA_DIGITAL_HUMAN_PREBUFFER_SEGMENTS = [string]$profile.PrebufferSegments
  $env:MEIHUA_RELEASE_GPU_AFTER_TTS = $profile.ReleaseVoiceGpu
  return $profile
}
