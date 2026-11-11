@echo off
setlocal
cd /d "%~dp0"
title Live Trading Simulator - close this window to stop
where node >nul 2>nul || (echo Node.js 22.12 or newer is required: https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
if not exist dist\server\main.js (
  echo Building the app...
  call npm run build || (echo Build failed & pause & exit /b 1)
)
if "%LTS_PORT%"=="" set LTS_PORT=5180
echo.
echo  Live Trading Simulator - FICTIONAL MONEY ONLY
echo  Opening http://localhost:%LTS_PORT% in your browser.
echo  Closing the browser is fine: the engine keeps monitoring orders.
echo  Closing THIS window, or sleeping the computer, stops it.
echo.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%LTS_PORT%/"
node dist\server\main.js %*
echo.
echo The simulator service has stopped.
pause
