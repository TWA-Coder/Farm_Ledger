@echo off
REM FarmLedger local demo for Windows: chain, contracts + seed data, bundler, phone services, web portal.
REM Double-click this file (or run start-demo.bat). Each service opens in its own window; close them to stop.
cd /d "%~dp0"
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  echo FarmLedger needs Node.js 22.5 or later. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules call npm install
if not exist web\node_modules call npm run web:install
start "FarmLedger chain" cmd /k npm run node
echo Waiting for the local chain...
timeout /t 12 /nobreak >nul
call npm run deploy:local
call npm run seed
start "FarmLedger bundler" cmd /k npm run bundler
start "FarmLedger phone services" cmd /k npm run phone
start "FarmLedger web" cmd /k npm run web
echo.
echo FarmLedger is starting. In about 20 seconds open:
echo   Portal           http://localhost:3000/app   (sign in: demo people are listed on the page)
echo   Phone simulator  http://localhost:3000/ussd
timeout /t 20 /nobreak >nul
start http://localhost:3000/app
