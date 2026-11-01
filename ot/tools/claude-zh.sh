#!/usr/bin/env bash
# claude-zh —— Claude Code 的中文速查壳。
#
# 它只做两件事：
#   1) 无参数 / --help / help  → 打印中文速查
#   2) 其它参数               → 原样交给真正的 claude
#
# 之所以只能做到这一步：Claude Code 是 Bun 编译的原生二进制，界面文案烘在里面，
# 没有语言开关。改二进制扛不住一次升级，所以这里只包一层中文入口。

set -u

show_help() {
cat <<'EOF'
Claude Code 中文速查
════════════════════════════════════════════════════════════

【启动】
  claude                     在当前目录开一个交互式会话
  claude "问题"               开一个会话并直接问一句
  claude -c                  继续上一次会话
  claude -r <会话ID>          恢复指定会话（不带 ID 会弹选择器）
  claude -p "问题"            非交互：输出完就退出（适合脚本/管道）
  claude -p "问题" --output-format json    非交互 + JSON 输出

【模型与思考】
  --model <名字>              指定模型，如 sonnet / opus / haiku
  --agent <名字>              用哪个自定义 agent
  --agents <json或文件>       临时定义自定义 agent

【工作范围】
  --add-dir <目录...>         额外授权一个目录（可多个）
  --allowedTools <工具...>    白名单，如 "Bash(git *) Edit"
  --append-system-prompt <文本>  追加一段系统提示（不覆盖默认的）
  --system-prompt <文本>      整体替换系统提示

【权限】
  --permission-mode <模式>    如 auto：不再逐步询问
  --allow-dangerously-skip-permissions   允许"跳过全部权限"这个选项（仍不默认开）
  （默认每步问一次；也可以在 ~/.claude/settings.json 里写 defaultMode）

【后台与批处理】
  --bg / --background         后台跑，立刻返回会话 id
  claude attach <id>          接回后台会话
  claude logs <id>            看后台会话日志
  claude stop <id>            停掉后台会话

【设置与调试】
  --settings <文件>           额外加载一份设置
  --mcp-config <文件>         加载 MCP 服务器配置
  --bare                      极简模式：跳过 hooks / LSP / 插件 / 自动记忆 / CLAUDE.md
  --verbose                   详细输出
  --debug                     调试日志
  --help                      官方英文完整帮助（本壳不翻译它）
  --version                   版本号

【会话里的斜杠命令（按 / 弹出的那一列）】
  常用
    /help            列出全部命令
    /model           换模型
    /status          会话状态
    /cost            本次会话花费
    /compact         压缩上下文
    /clear           清空上下文重开（旧会话仍留在磁盘）
    /exit            退出

  配置与环境
    /update-config   改设置：hooks、权限、环境变量
    /doctor          体检：安装、无用扩展、重复记忆文件、慢钩子、更新、权限
    /autocompact     设置上下文自动压缩的阈值
    /color           设置输入框颜色
    /cd              把当前会话换到另一个工作目录
    /add-dir         再加一个工作目录

  会话操作
    /branch          从当前这一轮分叉出一个新会话
    /background      把会话转到后台并释放终端
    /btw             插一句题外话，不打断主线
    /init            生成 CLAUDE.md
    /agents          管理自定义 agent
    /mcp             管理 MCP 服务器

  排错与反馈
    /code-review     审当前改动或 PR，找 bug 和可清理的地方
    /claude-api      用 Claude API 构建和调试应用
    /bug             报 bug / 分享会话

  ★ 这些是编译进 claude 二进制的，名字和说明改不了；
    本壳只能给中文对照，想按中文名敲，得自己建自定义命令。

【配置文件】
  ~/.claude/settings.json     全局设置（权限、模型、状态栏…）
  ~/.claude/CLAUDE.md         全局记忆：想让它"始终用中文回答"就写这里
  ~/.claude/projects/         会话记录（OT 读的就是这份）

════════════════════════════════════════════════════════════
本壳只提供中文速查；其余参数一律原样转给 claude。
EOF
}

case "${1:-}" in
  "")
    show_help
    echo
    echo "（下面进入交互式会话；/exit 或 Ctrl+D 退出）"
    exec claude
    ;;
  -h|--help|help|zh|--zh)
    show_help
    ;;
  *)
    exec claude "$@"
    ;;
esac
