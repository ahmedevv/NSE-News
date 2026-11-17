@echo off
REM One-time setup: creates a private Python environment (.venv) and installs dependencies.
REM Usage: setup.bat             (includes the FinBERT sentiment model)
REM        setup.bat nofinbert   (lighter install, rule engine only)
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11+ from https://www.python.org/downloads/windows/
    echo         and tick "Add python.exe to PATH" in the installer, then run setup.bat again.
    pause
    exit /b 1
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 (
    echo [ERROR] Python 3.10 or newer is required.
    python --version
    pause
    exit /b 1
)

if not exist .venv\Scripts\python.exe (
    echo Creating virtual environment...
    python -m venv .venv || (echo [ERROR] venv creation failed & pause & exit /b 1)
)

echo Installing dependencies (this takes a minute)...
.venv\Scripts\python.exe -m pip install --upgrade pip -q
.venv\Scripts\python.exe -m pip install -r requirements.txt -q || (echo [ERROR] pip install failed & pause & exit /b 1)

if /i "%~1"=="nofinbert" (
    echo Skipping FinBERT - rule engine only.
) else (
    echo Installing FinBERT dependencies: CPU PyTorch + transformers, about 1 GB, takes a few minutes...
    .venv\Scripts\python.exe -m pip install -r requirements-finbert.txt -q || echo [WARNING] FinBERT install failed - the app will still run with the rule engine only.
)

if not exist data mkdir data
if not exist settings.bat copy settings.example.bat settings.bat >nul

echo.
echo Setup complete.
echo   1. Edit settings.bat  (password, port, FinBERT on/off)
echo   2. Run start-server.bat to test, or install-autostart.bat (as Administrator) to run it permanently.
pause
