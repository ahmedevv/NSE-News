@echo off
REM ===== NSE Wire settings =====
REM setup.bat copies this file to settings.bat. Edit settings.bat, not this one.

REM Who can open the dashboard:
REM   127.0.0.1 = only from inside the VPS (open it in the browser over Remote Desktop) - safest
REM   0.0.0.0   = from anywhere on the internet at http://YOUR-VPS-IP:PORT  (set a password below!)
set "HOST=127.0.0.1"
set "PORT=8000"

REM Login for the dashboard. Leave DASH_PASS empty to disable the login (only OK with HOST=127.0.0.1).
set "DASH_USER=admin"
set "DASH_PASS="

REM ---- How often sources are checked (weekdays 07:30-20:00 IST; every 10 minutes outside those hours)
REM Exchange filings, in seconds (minimum 30)
set "FILINGS_SECONDS=60"
REM News headlines and prices, in minutes
set "NEWS_MINUTES=3"
set "PRICE_MINUTES=3"

REM Weekday of the weekly Nifty expiry: MON TUE WED THU FRI. The last one in the month is the monthly expiry.
set "EXPIRY_WEEKDAY=TUE"

REM ---- Alerts
REM Market-wide headlines (RBI, Fed, crude, war ...) with impact at or above ALERT_MACRO_IMPACT (0-10)
REM raise a "Market-wide" alert; at or above ALERT_CRITICAL_IMPACT a "Critical" one.
set "ALERT_MACRO_IMPACT=7"
set "ALERT_CRITICAL_IMPACT=8"
REM Warn this many minutes before a high-impact data release or expiry
set "EVENT_ALERT_MINUTES=15"
REM India VIX up this many % on the day
set "VIX_ALERT_PCT=8"
REM How alerts are shown (pop-up, sound, desktop) is set per browser on the dashboard's Notifications page.
