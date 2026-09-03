[CmdletBinding()]
param(
  [string]$MuseTalkRoot = 'E:\meihua\MuseTalk'
)
$ErrorActionPreference = 'Stop'
$bat = Join-Path $MuseTalkRoot 'download_weights.bat'
if (-not (Test-Path $bat)) { throw "MuseTalk not found at $MuseTalkRoot" }
Write-Host 'Downloading MuseTalk weights via hf-mirror (multi-GB; be patient).' -ForegroundColor Green
& cmd /c $bat
