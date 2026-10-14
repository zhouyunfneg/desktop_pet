@echo off
rem ============================================================
rem  One-click run: build, then launch the pet and close this
rem  console window so only the dog stays on the desktop.
rem  Keep this file ASCII-only: cmd.exe reads .bat in the OEM
rem  codepage, UTF-8 Chinese here would print as mojibake.
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" goto :no_electron

echo building...
call npm run build
if errorlevel 1 goto :build_failed

start "" "node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
exit /b 0

:build_failed
echo.
echo build failed, fix the errors above and try again.
pause
exit /b 1

:no_electron
echo.
echo electron binary is missing. run these once:
echo     npm install
echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo     node node_modules\electron\install.js
echo.
pause
exit /b 1
