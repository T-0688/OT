# OMP Desktop

自用、可换 Agent 的助手型桌面端。默认接 [omp](https://github.com/can1357/oh-my-pi)（oh-my-pi）的 ACP 模式。

> 设计文档见上一级的 [`omp-desktop-plan.md`](../omp-desktop-plan.md)。

## 安装（成品）

安装包：`release/OMP-Desktop-Setup-1.0.0.exe`（约 108 MB，NSIS，按用户安装、不需要管理员）

- 双击安装 → 桌面 / 开始菜单出现 **OMP Desktop**
- 安装位置：`%LOCALAPPDATA%\Programs\OMP Desktop\`
- 卸载：设置 → 应用 → OMP Desktop（或安装目录里的 `Uninstall OMP Desktop.exe`）
- 卸载不删数据；要清干净就同时删 `%APPDATA%\omp-desktop\`

> 安装包**没有代码签名**，Windows 可能提示"未知发布者"，选择"仍要运行"即可（自用场景可接受）。

重新打包：

```bash
npm run dist       # 构建 + 出 NSIS 安装包
npm run dist:dir   # 只出免安装目录 release/win-unpacked/
```

## 现在能干什么

- 单窗口聊天：流式输出（16ms 合并节流）、思考过程折叠、Markdown 渲染
- **工具调用卡片**：命令、状态（待执行/执行中/完成/失败）、输出
- **diff 视图**：行级对比、± 着色、行号、上下文折叠、+/− 统计
- **权限审批弹窗**：选项由 agent 提供（Allow once / Always allow / Reject / Always reject），不写死
- 模型 / 模式切换（直接来自 agent 的 `configOptions`）
- 上下文用量与花费显示
- **会话落盘**：每轮对话写 JSONL，关掉再开历史都在；点历史会话可**接着聊**（`session/load` 恢复上下文，实测有效）
- **工作区**：可手动添加（`settings.json`）；每行右侧 `＋` 直接在该目录新建对话；当前工作区文件夹图标高亮；**右键菜单**：重命名（别名存 `workspaceNames`）、在资源管理器中打开、复制路径、移除工作区（自动出现的分组会被记进 `hiddenWorkspaces`）
- **文件搜索**：搜索框同时搜会话标题/正文和**当前工作区的文件名**，点结果把绝对路径插进输入框
- **分组**：每组默认 4 条、其余「展开」；时间显示为「刚刚 / N 分钟 / N 小时 / N 天」
- **会话搜索**：侧栏按标题 / 目录 / agent 过滤，并**搜消息正文与工具输出**（显示命中条数与片段）
- **会话管理**：双击重命名，悬停出现 ✎ / ✕（删除只删本地记录）
- **图片**：输入框粘贴或拖入图片，落成本地文件并把路径附在消息里交给 agent
- **产出文件**：每轮改过/写过的文件在消息下方以卡片列出（46px 类型徽标 / 图片直接显示缩略图）；**单击用系统默认程序打开**，右键可「打开方式… / 打开所在文件夹 / 复制路径」
- **每轮统计**：结尾显示「已完成 · 用时 · tok」，附「回退」按钮（**恢复该轮改过的文件** + 把输入放回输入框 + 截断本地记录 + 重开会话清上下文）
- **左右分栏**：你的消息靠右、agent 靠左
- **轮次导航条**：右侧一列刻度对应每个用户消息，当前可见的高亮加粗，点击平滑跳转
- **代码高亮**：Markdown 代码块按语言着色，深浅主题各一套配色
- **技能面板**：列出 agent 的技能包（`omp skill list`），搜索、查看目录、一键填进输入框
- **设置页**：默认模型/模式/Agent/目录、主题、背景、缩放、通知、数据与版本
- **整体两栏**：左栏是整块侧栏（品牌 + `＋ 新会话` + 会话/技能 + 工作区分组列表 + 底部 `v0.1.0`/`⚙ 设置`），占满窗口高度；右栏是顶栏 + 对话 + 输入卡片 + 状态栏
- **输入区**：卡片上方是「工作区」「模式」两个下拉（模式即 omp 的 Default/Plan，显示为 标准模式/计划模式）；卡片内上为输入区、下为控件行（左 `＋` 与权限，右 模型/上下文/速率/发送）；状态栏在卡片下方
- **命令面板**：`Ctrl+K`，含新会话、切目录、切主题、切背景、看日志、复制对话、切 Agent、技能、打开最近会话、重试
- **状态栏**：模型名、本回合 tok/s、缓存命中率、上下文占用 / 上限（含百分比）、本会话花费
- **背景**：纯色 / 桌面壁纸 / 自选图片 / **Wallpaper Engine 壁纸**（扫描 Steam 创意工坊 431960，视频壁纸静音循环播放，场景壁纸用预览图）；壁纸模式下顶栏、侧栏、输入框自动变磨砂半透明
- **深浅主题**：顶栏一键切换并记住
- **完成通知**：窗口失焦时跑完会弹系统通知 + 任务栏闪烁
- **失败重试**：报错后可一键重发上一条
- **Agent 注册表**：`agents.ts` 里一行一个 agent，自动探测是否安装；换 agent 不用改 UI

验收记录：创建会话 → 记暗号 → 关掉应用 → 重开 → 点历史 → 追问 → 正确答出暗号（详见上级文档「实现进度」）。

## 手机访问

设置 → 手机访问，打开「开启远程服务」即可：

- 本机地址：`http://127.0.0.1:7788/?token=…`（手机与电脑同一 Wi‑Fi 时用局域网 IP 替换 127.0.0.1）
- 再开「Cloudflare 隧道」，软件会自己在后台拉起 cloudflared（首次自动下载到 `%APPDATA%\omp-desktop\bin\cloudflared.exe`），几秒后得到 `https://xxx.trycloudflare.com/?token=…`，任何网络下都能打开
- **固定域名**：隧道类型选「命名（自有域名）」，填 Cloudflare 后台隧道 token 和 `omp.你的域名.com`，地址就固定不变了（见下方步骤）
- 手机上能看会话、收流式回复、回消息、批权限；关掉软件服务即停
- 两种用法：浏览器打开（可「添加到主屏幕」变成 PWA），或安装 `release\OMP-Mobile-1.0.0.apk`
- **APK 是本地壳**：`assets/index.html` 内置，打开秒出界面；只有数据走 `wss://` 连电脑，地址已预填，无需配置

## 视觉令牌

配色、圆角、字体、状态色全部来自 DeepSeek Harness 的设计令牌（MIT）：

- `src/renderer/src/dsh-tokens.css` 由脚本从已安装的 DSH 客户端 `app.asar` 中提取（646 个 `--dsw-static-*` 调色板变量 + 211 个 `--dsw-alias-*` 语义变量，含 light/dark 两套）
- 我们的语义变量（`--bg` / `--panel` / `--text` …）在 `styles.css` 末尾映射到这些令牌
- 重新生成：`node tools/build-tokens3.mjs`（需要本机装有 DSH 桌面端）

## 跑起来

```bash
npm install
npm run dev
```

打包构建：

```bash
npm run build      # out/main, out/preload, out/renderer
npm run start      # 预览构建产物
```

### 注意：`ELECTRON_RUN_AS_NODE`

如果启动时报：

```
SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
```

说明环境里带着 `ELECTRON_RUN_AS_NODE=1`（某些 Agent/IDE 运行时会注入），Electron 被当成 Node 跑。启动前清掉：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

## 设置

底部输入区左侧的「⚙ 设置」按钮，或 `Ctrl+K` → 打开设置。改动即时生效，写入 `%APPDATA%\omp-desktop\settings.json`。

| 分组 | 项 | 说明 |
|---|---|---|
| 模型与 Agent | 默认模型 / 默认模式 / 默认 Agent / 默认工作目录 | 新建会话时自动套用；模型与模式来自 agent 的 `configOptions` |
| 外观 | 主题（深/浅）、背景（纯色 / 桌面壁纸 / 自选图片）、界面缩放（90/100/110%） | 与顶栏、`Ctrl+K` 的命令是同一套状态 |
| 通知 | 回合完成时通知 | 关掉后不再弹系统通知 / 闪任务栏 |
| 数据 | 打开数据目录、清空会话记录 | 清空只删本地 JSONL，不动 agent 自己的会话文件 |
| 关于 | 版本、已探测到的 agent 及版本 | |

**默认值怎么生效**：`agent:start` 拿到会话后，主进程会把 `defaultModel` / `defaultMode` 通过 `session/set_config_option` 套上去，再补发一次 `ready` 事件让顶栏和状态栏同步。agent 不认的值会被静默跳过。

## 技能（skills）

侧栏「技能」页 = agent 的技能清单，数据直接来自 `omp skill list --json`，和 agent 自己看到的一致。

- 显示：名称、来源（user/project）、描述、所在目录
- **用这个**：把 `使用「<技能名>」技能：` 填进输入框，你补完任务再发送
- **目录 / 文件**：在资源管理器里打开技能目录或 `SKILL.md`
- 支持按名称/描述搜索；`Ctrl+K` 里也能直接搜到前 20 个技能
- 刷新按钮会重新执行一次 `omp skill list`

> 技能目录由 agent 决定（本机是 `C:\Users\Kepler\.agents\skills\`），客户端只读不写；装/卸技能请用 `omp skill install` 或相应工具。

## 数据在哪

```
%APPDATA%\omp-desktop\
  sessions\                  # 会话 JSONL + index.json
  settings.json              # 设置
```

```
%APPDATA%\omp-desktop\sessions\
  index.json                 # 会话索引（标题/目录/agent/时间）
  01a14e8b-....jsonl         # 每个会话一个，一行一个事件，只追加
```

删掉对应 `.jsonl` 与索引条目即可清历史。**注意**：`session/load` 恢复上下文依赖 agent 自己的会话文件（omp 在 `~/.omp/agent/sessions/`），只删本地 JSONL 不会丢 agent 侧的上下文。

## 结构

```
src/
  shared/types.ts         # AgentEvent —— UI 只认这个
  main/
    index.ts              # 窗口、IPC、事件落盘
    store.ts              # JSONL + index.json
    agents.ts             # ★ Agent 注册表（换 agent 改这里）
    agent/session.ts      # spawn + ACP↔AgentEvent 映射（唯一懂协议的地方）
  preload/index.ts        # contextBridge 暴露 window.api
  renderer/src/
    App.tsx               # 聊天、工具卡片、审批弹窗、会话列表
    styles.css
tools/
  verify.mjs              # CDP：发 prompt + 截图
  ui-send.mjs             # CDP：模拟输入并点发送
  approve.mjs             # CDP：点掉授权弹窗
  session-test.mjs        # CDP：点开历史会话并追问（M4 验收）
probe.mjs                 # 不经过 UI、直接验证 ACP 协议
```

## 换 Agent

`src/main/agents.ts`：

```ts
export const AGENTS: AgentDef[] = [
  { id: "omp", name: "Oh My Pi", command: "omp", args: ["acp"] },
  { id: "claude", name: "Claude Code (ACP)", command: "claude-code-acp", args: [] },
  // 任何说 ACP 的 CLI 都能加进来
];
```

要求：该 agent 能作为 **ACP server over stdio** 启动。加完重启应用，顶栏就会出现（只显示探测到的）。

## 调试

CDP 端口默认 9333（9222 可能被别的程序占用）：

```powershell
.\node_modules\electron\dist\electron.exe --remote-debugging-port=9333 .
$env:CDP_PORT='9333'; node tools\ui-send.mjs "你好"
$env:CDP_PORT='9333'; node tools\approve.mjs
$env:CDP_PORT='9333'; node tools\session-test.mjs "暗号是什么？"
```

## 已知问题 / 下一步

- 安装包未签名（SmartScreen 会提示）。签名需要一张 Windows 代码签名证书，**自签名证书不会消除警告**，所以这里没做假签名
- 图片走"落盘 + 路径"而不是 ACP 内联图片：omp 会把内联图片转成 `local://image-*.png` 再去读，实际读不到（实测 `ENOENT`）。任何有文件工具的 agent 都能用路径方式
- 打开旧会话时，历史由本地 JSONL 渲染，`session/load` 的重放被主动吞掉（避免重复）；若某 agent 的 replay 晚于响应返回，可能出现重复气泡
- `fs/read_text_file` / `fs/write_text_file` / terminal 能力尚未实现，agent 会退回自己的工具
- 会话内搜索是逐条扫 JSONL，会话特别多时会慢（当前量级无感）
- **tok/s 是"本回合输出 tokens ÷ 整回合耗时"**，短回复会被首字延迟拉低（长回复更接近真实吞吐）；ACP 暂不提供 TTFT，所以没有做"纯解码速度"
- 缓存命中率按 `cachedReadTokens / (inputTokens + cachedReadTokens)` 计算——ACP 的 `inputTokens` 不含缓存部分，直接相除会得到 >100% 的离谱值
- 壁纸会整张读成 data URL 放在内存里（本机 2.6 MB 的 jpg → 3.6 MB 字符串），换壁纸会重新读一次；壁纸在 Windows 上取自注册表当前值，改完壁纸需要重选一次背景

## 打包踩过的坑

1. **`@agentclientprotocol/sdk` 必须打进主进程包**。它依赖 `zod` 等传递依赖，用 `externalizeDepsPlugin` 外部化后，asar 里只有 SDK 没有 zod，安装版会报
   `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`（开发模式却正常）。现已在 `electron.vite.config.ts` 里 `exclude` 掉它，主进程包从 10 KB 变成 344 KB。
2. **electron-builder 下载 Electron 会走另一条网络**（不是 npm 那条），失败时设 `build.electronDist = node_modules/electron/dist` 直接复用已下载的运行时。
3. **NSIS 工具链下载**同理，用镜像：`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
4. 环境里的 `ELECTRON_RUN_AS_NODE=1` 同样会让**打包后的 exe** 变成 Node 进程（报 `bad option: --enable-logging`），排查时必须先清掉。



























