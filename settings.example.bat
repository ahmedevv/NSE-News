@echo off
REM ===== NSE News Impact settings =====
REM setup.bat copies this file to settings.bat. Edit settings.bat, not this one.

REM Who can open the dashboard:
REM   127.0.0.1 = only from inside the VPS (open it in the browser over Remote Desktop) - safest
REM   0.0.0.0   = from anywhere on the internet at http://YOUR-VPS-IP:PORT  (set a password below!)
set "HOST=127.0.0.1"
set "PORT=8000"

REM Login for the dashboard. Leave DASH_PASS empty to disable the login (only OK with HOST=127.0.0.1).
set "DASH_USER=admin"
set "DASH_PASS="

REM Minutes between automatic news refreshes
set "REFRESH_MINUTES=30"

REM FinBERT financial-sentiment model (Hugging Face, runs locally on CPU; ~440 MB download on first run).
REM 1 = use it (if setup installed it), 0 = rule engine only (saves about 1 GB of RAM).
set "USE_FINBERT=1"
