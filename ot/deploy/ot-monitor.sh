#!/usr/bin/env bash
# OT 服务器健康检查：手机端隧道、frps 客户端、磁盘、内存
# 由 cron 每 5 分钟跑一次；异常写日志，配了 FEISHU_WEBHOOK 就推飞书。
set -uo pipefail

LOG=/var/log/ot-monitor.log
STATE=/var/lib/ot-monitor.state
TOKEN_FILE=/etc/ot-monitor.token      # OT 手机端的 token，一行
WEBHOOK_FILE=/etc/ot-monitor.webhook  # 飞书机器人 webhook（可选）

TOKEN=""
[ -f "$TOKEN_FILE" ] && TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
WEBHOOK=""
[ -f "$WEBHOOK_FILE" ] && WEBHOOK=$(tr -d '\r\n' < "$WEBHOOK_FILE")

problems=()

say() {
    echo "[$(date '+%F %T')] $*" >> "$LOG"
}

push() {
    local text="$1"
    say "ALERT $text"
    if [ -n "$WEBHOOK" ]; then
        curl -s -m 10 -H 'Content-Type: application/json' \
            -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$text\"}}" \
            "$WEBHOOK" >/dev/null 2>&1 || true
    fi
}

# 1) 手机端隧道：17788 上的 OT 服务是否还活着
if [ -n "$TOKEN" ]; then
    code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:17788/api/sessions?limit=1&token=$TOKEN" || echo 000)
    [ "$code" = "200" ] || problems+=("OT 手机端返回 $code（可能是电脑关机或 OT 没开）")
else
    problems+=("没有 $TOKEN_FILE，跳过手机端检查")
fi

# 2) frps 有没有客户端连着（7000 是控制端口）
if ! ss -tn 2>/dev/null | grep -q ':7000'; then
    problems+=("frps 没有客户端连接（家里那台 frpc 掉了）")
fi

# 3) 磁盘
use=$(df -P / | awk 'NR==2{print $5}' | tr -d '%')
[ "${use:-0}" -gt 85 ] && problems+=("磁盘用到 ${use}%")

# 4) 内存
avail=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
[ "${avail:-9999}" -lt 100 ] && problems+=("内存只剩 ${avail}MB")

# 只在"状态变化"时推送，避免每 5 分钟刷屏
if [ ${#problems[@]} -eq 0 ]; then
    now_state=""
else
    now_state=$(printf '%s\n' "${problems[@]}" | sort | tr '\n' '|')
fi
prev_state=""
[ -f "$STATE" ] && prev_state=$(cat "$STATE")

if [ ${#problems[@]} -gt 0 ]; then
    if [ "$now_state" != "$prev_state" ]; then
        push "OT 服务器告警：$(IFS='；'; echo "${problems[*]}")"
    fi
else
    if [ -n "$prev_state" ]; then
        push "OT 服务器已恢复正常"
    fi
fi
printf '%s' "$now_state" > "$STATE"
