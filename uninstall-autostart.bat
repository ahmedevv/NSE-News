@echo off
REM Right-click > "Run as administrator". Stops the background server and removes auto-start + firewall rule.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName 'NSE News' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'NSE News' -Confirm:$false -ErrorAction SilentlyContinue; Get-NetFirewallRule -DisplayName 'NSE News' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*app.main:app*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'Removed.'"
pause
