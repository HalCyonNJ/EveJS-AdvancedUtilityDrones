@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Advanced Utility Drones - Installer
echo ============================================================
echo.
echo   Usage:
echo     install.bat                                  (EveJS found automatically)
echo     install.bat --server "C:\path\to\EveJS"
echo     install.bat --server "C:\path\to\EveJS" --docker-only
echo     install.bat --server "C:\path\to\EveJS" --native-only
echo     install.bat --server "C:\path\to\EveJS" --dry-run
echo.
echo   With no arguments this assumes EveJS is installed on this computer
echo   and looks for it: beside this folder, above it, and failing that
echo   anywhere on the local drives. Pass --server only to override that.
echo.
echo   Registers the preload for every deployment it finds:
echo     Docker  docker/entrypoint.sh
echo     Native  StartServer.bat  (NODE_OPTIONS, read by both npm start paths)
echo.
echo   Files that are about to change are backed up under
echo   ^<EveJS root^>\_advancedutilitydrones-backup\ by default.
echo.
echo ------------------------------------------------------------
echo.

node "install.js" %*
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo   Exit code: %RC%
if not "%RC%"=="0" echo   (non-zero = failed, see messages above)
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
