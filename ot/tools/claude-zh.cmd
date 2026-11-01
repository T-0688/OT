@echo off
chcp 65001 >nul
rem claude-zh —— Claude Code 中文速查壳（Windows 版）
rem 无参数或 --help：打印中文速查；其它参数原样转给 claude。

if "%~1"=="" goto help
if /I "%~1"=="-h" goto help
if /I "%~1"=="--help" goto help
if /I "%~1"=="help" goto help
if /I "%~1"=="zh" goto help
claude %*
exit /b %errorlevel%

:help
echo Claude Code 中文速查
echo ============================================================
echo.
echo [启动]
echo   claude                     在当前目录开一个交互式会话
echo   claude "问题"               开一个会话并直接问一句
echo   claude -c                  继续上一次会话
echo   claude -r ^<会话ID^>          恢复指定会话（不带 ID 会弹选择器）
echo   claude -p "问题"            非交互：输出完就退出
echo.
echo [模型与工作范围]
echo   --model ^<名字^>              指定模型，如 sonnet / opus / haiku
echo   --add-dir ^<目录...^>         额外授权一个目录
echo   --allowedTools ^<工具...^>    白名单，如 "Bash(git *) Edit"
echo   --append-system-prompt ^<文本^>  追加一段系统提示
echo.
echo [权限]
echo   --permission-mode ^<模式^>    如 auto：不再逐步询问
echo   --allow-dangerously-skip-permissions  允许"跳过全部权限"这个选项
echo.
echo [后台]
echo   --bg / --background         后台跑并返回会话 id
echo   claude attach ^<id^>          接回后台会话
echo   claude logs ^<id^>            看后台日志
echo   claude stop ^<id^>            停掉后台会话
echo.
echo [设置与调试]
echo   --settings ^<文件^>           额外加载一份设置
echo   --mcp-config ^<文件^>         加载 MCP 配置
echo   --bare                      极简模式（跳过 hooks/LSP/插件/CLAUDE.md）
echo   --verbose / --debug         详细输出 / 调试日志
echo   --help                      官方英文完整帮助
echo.
echo [会话里的斜杠命令（按 / 弹出的那一列）]
echo   /help 全部命令        /model 换模型         /status 会话状态
echo   /cost 本次花费        /compact 压缩上下文    /clear 清空上下文重开
echo   /update-config 改设置 /doctor 体检          /autocompact 自动压缩阈值
echo   /color 输入框颜色     /cd 换工作目录         /add-dir 加工作目录
echo   /branch 分叉会话      /background 转后台     /btw 插句题外话
echo   /init 生成 CLAUDE.md  /agents 管理 agent     /mcp 管理 MCP
echo   /code-review 审改动   /claude-api 用 API 开发 /bug 报 bug
echo   注：名字和说明编译在 claude 里，改不了；本壳只给中文对照。
echo.
echo [配置文件]
echo   %%USERPROFILE%%\.claude\settings.json   全局设置
echo   %%USERPROFILE%%\.claude\CLAUDE.md       全局记忆（写"始终用中文回答"放这）
echo   %%USERPROFILE%%\.claude\projects\       会话记录（OT 读这份）
echo.
echo ============================================================
echo 本壳只提供中文速查；其余参数一律原样转给 claude。
