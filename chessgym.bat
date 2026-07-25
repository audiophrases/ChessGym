@echo off
setlocal
title ChessGym - yourlines suite
rem ChessGym is part of the yourlines chess suite. Starting it here launches
rem the whole suite (all apps, one origin, shared storage) and opens this
rem app's page. The suite lives in the sibling "yourlines" folder.

set "SUITE_DIR=%~dp0..\yourlines"
set "APP_PATH=/gym/"

if not exist "%SUITE_DIR%\package.json" (
  echo.
  echo   Could not find the yourlines suite at "%SUITE_DIR%".
  echo   Clone https://github.com/audiophrases/yourlines next to this folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install it from https://nodejs.org/ ^(LTS^) and run this again.
  echo.
  pause
  exit /b 1
)

cd /d "%SUITE_DIR%"

echo   Checking for a previous suite instance on port 5173...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Write-Host ('   Stopping previous instance (PID ' + $_ + ')'); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

if not exist "node_modules\" (
  echo.
  echo   First run - installing suite dependencies. This can take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. See the errors above.
    echo.
    pause
    exit /b 1
  )
)

echo   Syncing the latest app versions into the suite...
call npm run sync-apps

echo.
echo   Starting the yourlines chess suite:
echo     Lines   http://localhost:5173/
echo     Play    http://localhost:5173/play/
echo     Gym     http://localhost:5173/gym/   ^<- opening this app
echo     Review  http://localhost:5173/review/
echo     Puzzles http://localhost:5173/puzzles/
echo   Leave this window open while using the suite; press Ctrl+C to stop.
echo.

call npm run dev -- --open %APP_PATH%

if errorlevel 1 pause
endlocal
