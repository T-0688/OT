param(
    [switch]$Startup,
    [switch]$KeepCli
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $root 'target\release'
$dest = Join-Path $env:LOCALAPPDATA 'ot\bin'

$app = Join-Path $bin 'OT.exe'
if (-not (Test-Path -LiteralPath $app)) {
    throw "missing $app - run: cargo build --release"
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $app $dest -Force
Write-Host "installed -> $(Join-Path $dest 'OT.exe')"

# 状态栏渲染器：Claude Code 的 statusLine 指向它
$status = Join-Path $bin 'ot-statusline.exe'
if (Test-Path -LiteralPath $status) {
    Copy-Item $status $dest -Force
    Write-Host "installed -> $(Join-Path $dest 'ot-statusline.exe')"
}

# 只留 OT：清掉旧的两个命令行/托盘产物。
# 注意 Windows 文件名不区分大小写，'ot.exe' 会匹配到刚拷进去的 'OT.exe'，
# 必须按原名逐字比较（-ceq）再删。
$oldNames = @('ot.exe', 'ot-tray.exe')
Get-ChildItem -LiteralPath $dest -File | ForEach-Object {
    $n = $_.Name
    $hit = $false
    foreach ($cand in $oldNames) { if ($n -ceq $cand) { $hit = $true } }
    if ($hit) {
        Remove-Item -LiteralPath $_.FullName -Force
        Write-Host "removed old $n"
    }
}

# 不再需要 PATH 里的 bin（OT 从开始菜单/托盘启动）
if (-not $KeepCli) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and ($_ -ne $dest) })
    $new = $parts -join ';'
    if ($new -ne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $new, 'User')
        Write-Host "removed $dest from user PATH"
    }
}

function New-Shortcut([string]$linkPath, [string]$target, [string]$workdir) {
    $dir = Split-Path -Parent $linkPath
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($linkPath)
    $sc.TargetPath = $target
    $sc.WorkingDirectory = $workdir
    $sc.IconLocation = "$target,0"
    $sc.Description = 'OT - Claude Code / Codex session viewer'
    $sc.Save()
}

$exe = Join-Path $dest 'OT.exe'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Shortcut (Join-Path $startMenu 'OT.lnk') $exe (Split-Path -Parent $exe)

# 老的托盘快捷方式已经没用了
$oldLink = Join-Path $startMenu 'ot tray.lnk'
if (Test-Path -LiteralPath $oldLink) { Remove-Item -LiteralPath $oldLink -Force; Write-Host "removed old 'ot tray' shortcut" }

if ($Startup) {
    New-Shortcut (Join-Path $startMenu 'Startup\OT.lnk') $exe (Split-Path -Parent $exe)
    Write-Host "OT will start at login"
}

Write-Host ""
Write-Host "start: $exe"
Write-Host "data : $env:LOCALAPPDATA\ot  (providers.json / state.json / backup)"
