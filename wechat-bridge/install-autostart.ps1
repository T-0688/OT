# Install OT WeChat bridge autostart (Startup folder, no admin needed).
# Creates a VBS launcher in the user's Startup folder that runs run-loop.cmd hidden.
$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$loop = Join-Path $dir "run-loop.cmd"
if (-not (Test-Path $loop)) { throw "run-loop.cmd not found in $dir" }

$startup = [Environment]::GetFolderPath("Startup")
$vbsPath = Join-Path $startup "OT-WeChat-Bridge.vbs"

$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$dir"
sh.Run """$loop""", 0, False
"@

Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII
Write-Host "Installed autostart: $vbsPath"

# Start it right now
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`""
Start-Sleep -Seconds 3

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bridge.mjs*" }
if ($procs) {
  Write-Host "Bridge running (PID: $($procs.ProcessId -join ', '))"
} else {
  Write-Host "Bridge did not start; check log at $env:APPDATA\ot-wechat\bridge.log"
}
Write-Host "Log: $env:APPDATA\ot-wechat\bridge.log"
