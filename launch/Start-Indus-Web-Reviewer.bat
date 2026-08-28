@echo off
setlocal EnableExtensions
title Indus Web Reviewer
cd /d "%~dp0.."

echo.
echo  Indus Web Reviewer
echo  ==================
echo  Starting dashboard...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo Install from https://nodejs.org then try again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo Installing project dependencies ^(first run^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "web\node_modules\vite\package.json" (
  echo Installing dashboard dependencies ^(first run^)...
  call npm --prefix web install
  if errorlevel 1 (
    echo [ERROR] web npm install failed.
    pause
    exit /b 1
  )
)

if not exist "web\dist\index.html" (
  echo Building dashboard ^(first run^)...
  call npm run build:web
  if errorlevel 1 (
    echo [ERROR] web build failed.
    pause
    exit /b 1
  )
)

REM Prefer local electron binary
set "ELECTRON=node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [ERROR] Electron binary missing. Run: npm install
  pause
  exit /b 1
)

echo Compiling automation (keeps RAM low — plain Node, not ts-node)...
call npm run build
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  pause
  exit /b 1
)

echo Launching Electron dashboard on http://127.0.0.1:3847 ...
start "Indus Web Reviewer" /D "%CD%" "%ELECTRON%" .
exit /b 0
