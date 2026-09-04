@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0MeihuaInstaller.ps1"
if errorlevel 1 (
  echo.
  echo 安装器启动失败。请查看 installer\logs 目录。
  pause
)
endlocal
