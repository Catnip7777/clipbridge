@echo off
rem ===========================================================
rem  ClipBridge launcher (ASCII only on purpose!)
rem  cmd.exe parses .cmd with the OEM codepage, so non-ASCII
rem  text here can break the script. All Chinese output comes
rem  from start.js instead.
rem
rem  Double-click this file, or run:  start.cmd --check
rem ===========================================================
setlocal
cd /d "%~dp0"
set "NEED=18"

rem --- prevent the window from closing no matter what ---
if /i "%~1"=="nopause" goto run
set "CLIPBRIDGE_PAUSE=1"

:run
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found / Node.js not installed
  echo       Install Node.js 18+ :  https://nodejs.org/
  echo.
  goto done
)

rem --- check Node major version ---
set "NODEMAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODEMAJOR=%%v"
set "NODEMAJOR=%NODEMAJOR:v=%"
if not defined NODEMAJOR goto runnode
if %NODEMAJOR% LSS %NEED% (
  echo.
  echo   [X] Node.js is too old: v%NODEMAJOR%  ^(need v%NEED% or newer^)
  echo       Download: https://nodejs.org/
  echo.
  goto done
)

:runnode
node start.js %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo   [X] launcher exited with code %CODE%
if "%CODE%"=="0" echo   ClipBridge stopped.

:done
if defined CLIPBRIDGE_PAUSE (
  echo.
  echo   Press any key to close this window...
  pause >nul
)
endlocal
