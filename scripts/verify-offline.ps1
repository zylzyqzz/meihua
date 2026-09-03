$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  & pnpm typecheck
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & pnpm test
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & pnpm build
  exit $LASTEXITCODE
} finally { Pop-Location }
