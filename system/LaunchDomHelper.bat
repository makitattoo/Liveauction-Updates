@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "HELPER_DIR=%SCRIPT_DIR%"
set "HELPER_JS=%HELPER_DIR%\estimate-reader.js"
set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "DEBUG_URL=http://127.0.0.1:9222/json/version"

if not exist "%HELPER_JS%" exit /b 0
if not exist "%NODE_EXE%" exit /b 0

:: Check if Chrome debug port is available (hidden window)
powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%DEBUG_URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
    echo Chrome debug port not available. Please start Chrome with: --remote-debugging-port=9222
    exit /b 0
)

:: Check if node is already running estimate-reader.js
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | findstr /I "estimate-reader.js" >nul
if %errorlevel% equ 0 exit /b 0

:: Start node completely hidden (no window, no taskbar)
cd /d "%HELPER_DIR%"
start "" /B "%NODE_EXE%" "%HELPER_JS%" >nul 2>&1

endlocal
