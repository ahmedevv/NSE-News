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

REM Minutes between news + price refreshes (minimum 2)
set "REFRESH_MINUTES=5"

REM ---- Alerts ----
REM A story with impact score at or above ALERT_MIN_IMPACT (0-10) raises a "high" alert;
REM at or above ALERT_CRITICAL_IMPACT a "critical" one. Raise them if you get too many alerts.
set "ALERT_MIN_IMPACT=7"
set "ALERT_CRITICAL_IMPACT=8"
REM A stock moving this many % in a day (during market hours) raises a price-move alert
set "MOVE_ALERT_PCT=3"
REM How alerts are shown (pop-up, sound, desktop) is set per browser on the dashboard's Notifications page.

REM FinBERT financial-sentiment model (Hugging Face, runs locally on CPU; ~440 MB download on first run).
REM 1 = use it (if setup installed it), 0 = rule engine only (saves about 1 GB of RAM).
set "USE_FINBERT=1"
