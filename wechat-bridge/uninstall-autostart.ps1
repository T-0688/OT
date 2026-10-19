# 移除 OT 微信桥接的开机自启
$taskName = "OT-WeChat-Bridge"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "已移除计划任务：$taskName"
} else {
  Write-Host "没有找到计划任务：$taskName"
}
