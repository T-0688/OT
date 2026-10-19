# Remove OT WeChat bridge autostart (Startup folder entry).
$startup = [Environment]::GetFolderPath("Startup")
$vbsPath = Join-Path $startup "OT-WeChat-Bridge.vbs"
if (Test-Path $vbsPath) {
  Remove-Item $vbsPath -Force
  Write-Host "Removed: $vbsPath"
} else {
  Write-Host "Not installed."
}

# Stop running bridge processes
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bridge.mjs*" } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped bridge processes."
