# Registers a Windows scheduled task so the dashboard starts at boot (no login needed)
# and keeps running. Also opens the firewall port when HOST=0.0.0.0.
# Run via install-autostart.bat (right-click > Run as administrator).
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "NSE News"

if (-not (Test-Path "$dir\.venv\Scripts\python.exe")) { throw "Run setup.bat first." }

# read HOST / PORT from settings.bat
$hostSetting = "127.0.0.1"; $port = 8000
if (Test-Path "$dir\settings.bat") {
    foreach ($line in Get-Content "$dir\settings.bat") {
        if ($line -match '^\s*set\s+"?HOST=([^"]+)"?') { $hostSetting = $Matches[1].Trim() }
        if ($line -match '^\s*set\s+"?PORT=(\d+)') { $port = [int]$Matches[1] }
    }
}

$action    = New-ScheduledTaskAction -Execute "$dir\autostart.bat" -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Get-NetFirewallRule -DisplayName $taskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($hostSetting -eq "0.0.0.0") {
    New-NetFirewallRule -DisplayName $taskName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    Write-Host "Firewall: opened TCP port $port." -ForegroundColor Yellow
    Write-Host "Also open port $port in your VPS provider's control panel (security group / cloud firewall) if it has one."
}

Start-ScheduledTask -TaskName $taskName
Write-Host ""
Write-Host "Installed. The dashboard now starts automatically when the VPS boots." -ForegroundColor Green
if ($hostSetting -eq "0.0.0.0") {
    Write-Host "Open: http://<your-VPS-public-IP>:$port"
} else {
    Write-Host "Open on the VPS (via Remote Desktop): http://localhost:$port"
}
Write-Host "Logs: $dir\data\server.log"
