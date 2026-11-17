@echo off
REM Starts the dashboard in this window (Ctrl+C to stop). For permanent running use install-autostart.bat.
cd /d "%~dp0"
set "HOST=127.0.0.1"
set "PORT=8000"
if exist "%~dp0settings.bat" call "%~dp0settings.bat"

if not exist "%~dp0.venv\Scripts\python.exe" (
    echo [ERROR] Run setup.bat first.
    exit /b 1
)
if "%HOST%"=="0.0.0.0" if "%DASH_PASS%"=="" (
    echo [WARNING] HOST=0.0.0.0 with no DASH_PASS: anyone on the internet can open the dashboard.
)

echo Starting NSE News Impact on http://%HOST%:%PORT%  ^(first refresh takes about 1 minute^)
"%~dp0.venv\Scripts\python.exe" -m uvicorn app.main:app --host %HOST% --port %PORT%
