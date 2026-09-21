@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "build-package.js" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo   (non-zero = failed, see messages above)
pause
exit /b %RC%

:nonode
echo.
echo [ERROR] Node.js was not found in PATH.
echo         This package needs Node.js 18 or newer.
echo         Download: https://nodejs.org/
echo.
pause
exit /b 1
