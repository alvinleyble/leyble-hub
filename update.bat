@echo off
echo Updating Leyble Hub...

git pull origin main
if %errorlevel% neq 0 ( echo ERROR: git pull failed & pause & exit /b 1 )

cd server
npm install --silent
if %errorlevel% neq 0 ( echo ERROR: server npm install failed & pause & exit /b 1 )

node db/migrate.js
if %errorlevel% neq 0 ( echo ERROR: migrations failed & pause & exit /b 1 )

cd ..\client
npm install --silent
if %errorlevel% neq 0 ( echo ERROR: client npm install failed & pause & exit /b 1 )

cd ..
pm2 restart all
if %errorlevel% neq 0 ( echo ERROR: pm2 restart failed & pause & exit /b 1 )

echo.
echo Done! App is updated and running.
pause
