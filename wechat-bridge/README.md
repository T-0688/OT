# OT ⇄ 微信桥接

在微信里直接跟 OT 的 agent 对话。全程**只发出站请求**，不开公网端口、不需要服务器、不需要隧道。

```
手机微信 ──► 微信 ClawBot（腾讯 iLink）──► 本机 bridge.mjs ──► OT（ws://127.0.0.1:7788）
```

## 原理

腾讯的 ClawBot 插件走 iLink 接口（`https://ilinkai.weixin.qq.com`）：

| 接口 | 作用 |
|---|---|
| `POST ilink/bot/get_bot_qrcode?bot_type=3` | 取绑定二维码 |
| `GET ilink/bot/get_qrcode_status?qrcode=…` | 轮询扫码结果，confirmed 时返回 `bot_token` |
| `POST ilink/bot/getupdates` | 长轮询收消息（35s 超时，带 `get_updates_buf` 游标） |
| `POST ilink/bot/sendmessage` | 发消息（必须带该条消息的 `context_token`） |

桥接把收到的文本转发给本机 OT 的 WebSocket（`{type:"prompt"}`），把流式 `text` 拼成回复，去掉 Markdown 后用 `sendmessage` 发回微信。

## 使用

```powershell
cd wechat-bridge
npm install

# 1. 绑定（生成 %APPDATA%\ot-wechat\qr.png，用手机微信扫）
node bridge.mjs login

# 2. 开始转发（保持运行）
node bridge.mjs run

# 3. 看状态
node bridge.mjs status
```

绑定成功后，**在微信里发第一条消息**，桥接会把发送者记为唯一用户；之后其他人的消息一律忽略。

## 开机自启

```powershell
# 安装计划任务（登录时自动启动，隐藏窗口）
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1

# 移除
powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
```

任务名：`OT-WeChat-Bridge`。手动启动/停止：

```powershell
Start-ScheduledTask -TaskName "OT-WeChat-Bridge"
Stop-ScheduledTask  -TaskName "OT-WeChat-Bridge"
```

## 日志与数据

| 路径 | 内容 |
|---|---|
| `%APPDATA%\ot-wechat\account.json` | bot_token / bot_id / 绑定用户 |
| `%APPDATA%\ot-wechat\seen.json` | 已处理消息 ID（防重复回复） |
| `%APPDATA%\ot-wechat\bridge.log` | 运行日志（超过 2MB 自动轮转） |
| `%APPDATA%\ot-wechat\qr.png` | 最近一次绑定二维码 |

## 故障排查

| 现象 | 处理 |
|---|---|
| 微信发消息没回复 | 看 `bridge.log`；确认电脑开着、OT 在运行（7788 端口） |
| 日志出现 `-14` / 凭证过期 | 重新 `node bridge.mjs login` 扫码 |
| `读不到 OT 的 remoteToken` | 先启动一次 OT，让它写入 settings.json |
| 回复很慢 | agent 思考时间，桥接会等满 240 秒 |
| 想换绑定的微信用户 | 删掉 `account.json` 里的 `boundUser` 字段并重启 |

## 安全说明

- 只有**出站** HTTPS，不监听任何端口
- 凭证只存在本机 `%APPDATA%`，不写进仓库
- 只处理绑定用户的文本消息，机器人自己发的消息（`message_type: 2`）忽略
- 微信端无法点授权按钮，桥接遇到 permission 请求会**自动拒绝**，避免 agent 卡住
- 回复一律纯文本（微信不渲染 Markdown）

## 限制

- 电脑关机/休眠就收不到
- 只支持文本；图片/语音/文件暂不转发
- 依赖腾讯 iLink 私有接口，接口变更可能导致失效
- 个人微信自动化有一定账号风险，请自行评估
