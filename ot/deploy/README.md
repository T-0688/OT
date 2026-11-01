# 手机端部署（frp）

手机端的链路是：**手机 → 云服务器（frps） → 你家电脑（frpc） → OT 内置服务 :7788**。

OT 本身只监听本机，公网入口全交给 frp，所以不用在路由器上开端口。

## 0. 先确认本机能用

OT 启动时会在控制台打印：

```
手机端已启动：http://192.168.x.x:7788/?token=28f813bf…
```

token 也存在 `%LOCALAPPDATA%\ot\mobile-token.txt`。手机连同一个 wifi 时，直接用这个地址就能打开。

端口想换：启动前设 `OT_PORT=8080`。

## 1. 云服务器（Linux）

```bash
# 下载 frp
wget https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz
tar xzf frp_0.61.1_linux_amd64.tar.gz && cd frp_0.61.1_linux_amd64

# 放配置（把 token 改成自己的）
cp /path/to/frps.toml .
./frps -c frps.toml
```

开机自启（systemd）：

```ini
# /etc/systemd/system/frps.service
[Unit]
Description=frps
After=network.target

[Service]
ExecStart=/opt/frp/frps -c /opt/frp/frps.toml
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now frps
```

安全组/防火墙要放行 **7000**（frp 控制）和 **17788**（手机访问）。

## 2. 你的 Windows 电脑

```powershell
# 下载 windows 版，解压到任意目录
.\frpc.exe -c frpc.toml
```

想开机自启，用 `nssm` 注册成服务，或者把 `frpc.exe -c frpc.toml` 丢进启动项。

## 3. 手机

旧版 APK 默认地址就是 `http://120.26.20.154:17788/?token=…`，**不用重新打包**——
在 App 里把 token 换成 `mobile-token.txt` 里的值即可。

浏览器直接开这个地址也能用，页面是自适应的。

## 安全提醒

- `mobile-token.txt` 就是口令，泄露了别人能看你的会话、还能通过 `/api/send` 让你的 claude 跑指令
- 换口令：删掉 `%LOCALAPPDATA%\ot\mobile-token.txt`，重启 OT，会自动生成新的
- 更稳的做法是在服务器上加一层 nginx + HTTPS，把 17788 藏在后面

## 现在的功能

| 页面 | 能干什么 |
|---|---|
| 会话 | 列表（项目/标题/花费/token/运行状态），点进去看逐轮对话与工具调用 |
| 花费 | 30 天合计、按天柱状、按模型明细 |
| 额度 | 每家供应商的余额（服务端缓存 60 秒） |

会话详情页底部有输入框，发出去会执行 `claude --resume <会话> -p <你写的字>`，
输出回来后刷新即可看到（这个请求是同步的，长任务会等一会儿）。
