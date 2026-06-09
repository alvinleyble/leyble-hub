@echo off
REM Stops (kills) all running Leyble Hub sessions managed by PM2.
REM The app stops serving; the processes stay registered so start.bat /
REM restart.bat can bring them back. To wipe them from PM2 entirely,
REM use:  pm2 delete leyble-server leyble-client
echo Stopping Leyble Hub...
cd /d "%~dp0"

pm2 stop leyble-server leyble-client
pm2 save

echo.
echo Leyble Hub stopped. The app is no longer running.
echo (Run start.bat or restart.bat to bring it back.)
pause
