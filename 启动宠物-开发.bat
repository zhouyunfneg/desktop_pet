@echo off
rem ============================================================
rem  Dev launcher: tsc watch + vite HMR + electron, console kept
rem  open for logs. Stop with Ctrl+C (it tears the whole tree
rem  down once the electron window closes).
rem  Usage:
rem      启动宠物-开发.bat            normal dev
rem      启动宠物-开发.bat debug      show hotspot box + forward
rem                                   renderer logs to this console
rem      启动宠物-开发.bat adult      preview a growth stage
rem ============================================================
setlocal
cd /d "%~dp0"

if "%~1"=="debug" set DPET_DEBUG=1
if not "%~1"=="" set DPET_STAGE=%~1

if not exist "node_modules\electron\dist\electron.exe" (
  echo electron binary is missing. run: npm install
  pause
  exit /b 1
)

npm run dev
pause
