#!/usr/bin/env bash
# OT frp server 一键安装（Ubuntu 24.04）
# 用法：上传到服务器后执行  bash frps-setup.sh
set -euo pipefail

TOKEN="${TOKEN:-$(head -c 32 /dev/urandom | tr -dc 'a-f0-9' | head -c 24)}"
BIND_PORT=7000
VERSION="0.71.1"
DIR="/usr/local/frp"

say() { printf '\n\033[36m[frps]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[frps] 失败: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（网页终端默认就是 root）"

say "1/6 准备目录"
mkdir -p "$DIR"
cd /tmp

say "2/6 下载 frp $VERSION"
URL="https://github.com/fatedier/frp/releases/download/v${VERSION}/frp_${VERSION}_linux_amd64.tar.gz"
if ! curl -fL --retry 2 --connect-timeout 15 -o frp.tgz "$URL"; then
  say "GitHub 直连失败，改用镜像"
  curl -fL --retry 2 --connect-timeout 15 -o frp.tgz "https://gh-proxy.com/${URL}" || die "下载失败，服务器可能连不上 GitHub，把这段报错发我"
fi
[ -s frp.tgz ] || die "下载的文件是空的"

say "3/6 解压并安装"
tar -xzf frp.tgz
install -m 755 "frp_${VERSION}_linux_amd64/frps" "$DIR/frps"
"$DIR/frps" -v

say "4/6 写配置"
cat > "$DIR/frps.toml" <<EOF
bindPort = ${BIND_PORT}
auth.method = "token"
auth.token = "${TOKEN}"
EOF
cat "$DIR/frps.toml"

say "5/6 注册 systemd 服务"
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server
After=network.target

[Service]
ExecStart=/usr/local/frp/frps -c /usr/local/frp/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1 || true
systemctl restart frps || die "frps 启动失败，查看 journalctl -u frps -n 30"

say "6/6 检查状态"
sleep 1
systemctl is-active frps || true
ss -lntp | grep ":${BIND_PORT}" || die "没有监听 ${BIND_PORT}"

printf '\n\033[32m完成。\033[0m\n'
printf '  服务器: 120.26.20.154:%s\n' "$BIND_PORT"
printf '  token : %s\n' "$TOKEN"
printf '  下一步: 告诉我一声，我在电脑上连过来\n\n'

