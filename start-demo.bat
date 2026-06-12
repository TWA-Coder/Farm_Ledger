@echo off
REM Starts the whole local demo: chain, contracts + seed data, notifier, web app.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist web\node_modules call npm run web:install
start "FarmLedger chain" cmd /k npm run node
timeout /t 10 /nobreak >nul
call npm run deploy:local
call npm run seed
start "FarmLedger notifier" cmd /k npm run notify
start "FarmLedger USSD" cmd /k npm run ussd
start "FarmLedger web" cmd /k npm run web
echo.
echo Open http://localhost:3000   (USSD phone: http://localhost:3000/ussd, oracle: npm run oracle -- scenario drought 1)
