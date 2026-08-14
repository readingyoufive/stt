@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js est requis: https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (
  echo Installation des dependances frontend...
  call npm install || (pause & exit /b 1)
)
echo.
echo Ouvre http://localhost:5173
start "" http://localhost:5173
call npm run dev
