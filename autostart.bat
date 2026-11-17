@echo off
REM Used by the "NSE News" scheduled task. Runs the server in the background and restarts it if it crashes.
REM Logs: data\server.log
cd /d "%~dp0"
if not exist "%~dp0data" mkdir "%~dp0data"
:loop
echo ===== starting %date% %time% ===== >> "%~dp0data\server.log"
call "%~dp0start-server.bat" >> "%~dp0data\server.log" 2>&1
echo ===== server exited, restarting in 15s ===== >> "%~dp0data\server.log"
REM ping is used as a sleep because "timeout" fails when there is no console (scheduled tasks)
ping -n 16 127.0.0.1 >nul
goto loop
