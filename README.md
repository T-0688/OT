# OT

OT 是一个把 [oh-my-pi](https://github.com/can1357/oh-my-pi)（`omp`）包装成桌面客户端的 Electron 应用，顺带一个手机端。

## 组成

| 目录 | 说明 |
|---|---|
| `omp-desktop/` | Electron 应用（React 19 + electron-vite），主进程通过 ACP 协议驱动 `omp acp` |
| `omp-mobile/` | Android 壳（纯 Java，WebView），本地 `assets/index.html` 秒开，数据走 `wss://` |
| `mobile/index.html` | 手机页面单一源，桌面端 serve 同一份，APK 构建前复制进 assets |
| `omp-desktop-plan.md` | 设计与踩坑记录（M0–M6 + 后续 40 节） |

## 功能

- 会话：工作区分组、文件搜索、右键菜单（重命名/打开/复制/移除）
- 对话：流式输出、工具调用与 diff、每轮用时/token 统计 + 回退（含文件快照还原）
- 产出文件卡片：单击用系统程序打开，右键「打开方式 / 所在文件夹 / 复制路径」
- 外观：深浅主题（DSH 设计令牌）、壁纸（桌面壁纸 / 自选图片 / Wallpaper Engine，支持视频）
- 手机访问：内置 HTTP + WebSocket 服务，token 鉴权；Cloudflare 隧道（快速 / token / 本地凭据）
- 设置：模型/模式/Agent 默认值、通知、数据目录、隧道配置

## 开发

```bash
cd omp-desktop
npm install
npm run dev        # 开发
npm run build      # 构建
npm run dist       # 打 NSIS 安装包（release/）
```

手机端：

```bash
cd omp-mobile
gradle assembleDebug    # 需要 Android SDK + JDK 17+
```

## 数据

- 会话/设置：`%APPDATA%\omp-desktop\`
- 文件快照：`%APPDATA%\omp-desktop\checkpoints\`
- 隧道二进制：`%APPDATA%\omp-desktop\bin\cloudflared.exe`

## 许可

MIT

