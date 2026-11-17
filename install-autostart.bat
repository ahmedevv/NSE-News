@echo off
REM Right-click > "Run as administrator"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause
