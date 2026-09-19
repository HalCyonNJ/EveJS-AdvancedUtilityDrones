@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Alternate Mining Drones - Uninstall / Rollback
echo ============================================================
echo.
echo   Usage:
echo     uninstall.bat                                (EveJS found automatically)
echo     uninstall.bat --server "C:\path\to\EveJS"
echo     uninstall.bat --server "C:\path\to\EveJS" --keep-files
echo     uninstall.bat --server "C:\path\to\EveJS" --dry-run
echo.
echo   With no arguments EveJS is located the same way the installer
echo   locates it: beside this folder, above it, then the local drives.
echo.
echo   Removes the preload from every deployment and archives the mod
echo   folder under ^<EveJS root^>\_alternateminingdrones-backup\.
echo.
echo ------------------------------------------------------------
echo.

node "uninstall.js" %*
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo   Exit code: %RC%
echo.
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
