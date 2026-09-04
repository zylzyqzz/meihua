@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0MeihuaInstaller.ps1"
if errorlevel 1 (
  echo.
  echo Installer failed to start. Open the logs folder for details.
  pause
)
endlocal
