@echo off
REM Starts the Leyble Hub app (server + client) under PM2.
REM Safe to run anytime: if a process is already registered it is (re)started,
REM otherwise it is created from scratch.
echo Starting Leyble Hub...
cd /d "%~dp0"

pm2 describe leyble-server >nul 2>&1
if %errorlevel%==0 (
  pm2 start leyble-server
) else (
  pm2 start server/src/index.js --name leyble-server
)

pm2 describe leyble-client >nul 2>&1
if %errorlevel%==0 (
  pm2 start leyble-client
) else (
  pm2 start npm --name leyble-client --cwd "%~dp0client" -- run dev
)

pm2 save

echo.
echo Done. Open http://localhost:5173
pause
