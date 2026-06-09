@echo off
REM Restarts the Leyble Hub app (server + client) under PM2.
REM If a process isn't registered yet it is created instead of erroring.
echo Restarting Leyble Hub...
cd /d "%~dp0"

pm2 describe leyble-server >nul 2>&1
if %errorlevel%==0 (
  pm2 restart leyble-server
) else (
  pm2 start server/src/index.js --name leyble-server
)

pm2 describe leyble-client >nul 2>&1
if %errorlevel%==0 (
  pm2 restart leyble-client
) else (
  pm2 start npm --name leyble-client --cwd "%~dp0client" -- run dev
)

pm2 save

echo.
echo Done. Open http://localhost:5173
pause
