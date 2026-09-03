[CmdletBinding()]
param(
  [string]$GptSoVitsRoot = ''
)
$ErrorActionPreference = 'Stop'

if (-not $GptSoVitsRoot) {
  $workspaceParent = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $GptSoVitsRoot = Get-ChildItem -LiteralPath $workspaceParent -Directory |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName 'runtime\python.exe')) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName 'api_v3.py'))
    } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $GptSoVitsRoot) { throw 'GPT-SoVITS root was not found. Pass -GptSoVitsRoot explicitly.' }

$python = Join-Path $GptSoVitsRoot 'runtime\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "GPT-SoVITS Python not found: $python" }

Write-Host 'Installing offline voice transcription packages...' -ForegroundColor Cyan
& $python -m pip install --disable-pip-version-check --no-input --no-deps --no-build-isolation `
  'openai-whisper==20240930' 'tiktoken==0.7.0'
if ($LASTEXITCODE -ne 0) { throw 'Failed to install OpenAI Whisper runtime.' }

$modelDirectory = Join-Path $GptSoVitsRoot 'tools\asr\models\openai-whisper'
$modelPath = Join-Path $modelDirectory 'tiny.pt'
$modelUrl = 'https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9/tiny.pt'
$expectedHash = '65147644A518D12F04E32D6F3B26FACC3F8DD46E5390956A9424A650C0CE22B9'
New-Item -ItemType Directory -Force $modelDirectory | Out-Null

$valid = (Test-Path -LiteralPath $modelPath) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $modelPath).Hash -eq $expectedHash)
if (-not $valid) {
  Write-Host 'Downloading bundled Whisper Tiny model (about 76 MB)...' -ForegroundColor Cyan
  & curl.exe -L --fail --retry 3 --output $modelPath $modelUrl
  if ($LASTEXITCODE -ne 0) { throw 'Failed to download the offline Whisper model.' }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $modelPath).Hash -ne $expectedHash) {
  throw 'Offline Whisper model checksum mismatch.'
}

& $python -c "import whisper, tiktoken; print('VOICE_ASR_READY')"
if ($LASTEXITCODE -ne 0) { throw 'Offline voice transcription import check failed.' }
Write-Host 'Offline voice transcription is ready and will be included in the all-in-one bundle.' -ForegroundColor Green
