@echo off
rem One-click push wrapper. All logic lives in push.ps1.
rem Usage: push.cmd [-Proxy http://127.0.0.1:7890] [-DirectFirst:$false] [-WaitSeconds 300]
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [push.cmd] failed with exit code %RC%
)
exit /b %RC%
