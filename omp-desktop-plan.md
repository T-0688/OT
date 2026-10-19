# OMP Desktop —— 自用、可换 Agent 的助手型桌面端

> 目标：一个"像我（DeepSeek Harness）这样"的单窗口助手界面 —— 聊天为主、工具调用可视化、权限审批、会话管理 ——
> 但它不绑定 omp：**今天跑 omp，明天想换 Claude Code / Codex / 别的 CLI，换个适配器就行。**
> 定位：自用工具，不上架、不商业化，所以一切选型以"最快跑起来 + 以后好改"为最高优先级。

---

## 0. 一句话结论

**Electron + React + ACP（Agent Client Protocol）**。
UI 只认 ACP 的内部事件模型，Agent 能力差异全部收敛在适配器里 —— 这就是"随心换"的全部秘密。

---

## 1. 选型：为什么是这三个

| 决策 | 选择 | 理由 | 被否掉的方案 |
|---|---|---|---|
| 壳 | **Electron 43+** | Windows 上 node-pty / xterm / 子进程管理开箱即用；Orca、gooey-pi、pi-desktop 全是 Electron，遇到坑能直接对照 | Tauri：包体小、内存低，但要写 Rust，PTY 与终端嵌入选型成本高，对"自用 + 业余时间"不划算 |
| 协议 | **ACP v1** | 已经是事实标准（Zed 生态），omp 原生支持；结构化 tool call / 权限请求 / 流式增量全都现成，不用解析 ANSI | ① 裸 PTY 套壳：拿不到结构化事件，天花板极低 ② 直接嵌 omp SDK：等于重写它的产品层，换 agent 时全部作废 |
| 前端 | React 19 + Vite + Tailwind + shadcn/ui + zustand | 生态最厚，且与参考实现同构，抄 UI 快 | Vue/Svelte：自己熟就用，无硬性理由 |

**关键判断**：你做的是"助手窗口"，不是 IDE。所以不需要 Monaco / LSP / 多 worktree —— 这些是 B 类（Orca）的活。
MVP 只做：**说话 → 看它干活 → 该拦的拦一下 → 下次还能接着聊。**

---

## 2. 架构

```
┌─────────────────────────────────────────────────────┐
│ Renderer (React)                                    │
│   会话列表 │ 消息流 │ 工具卡片 │ 审批弹窗 │ 输入框   │
└──────────────────────┬──────────────────────────────┘
                       │ IPC (typed, 事件流)
┌──────────────────────▼──────────────────────────────┐
│ Main (Node)                                         │
│  ┌───────────────────────────────────────────────┐  │
│  │ Session Manager   ← JSONL 追加写 + 重放        │  │
│  ├───────────────────────────────────────────────┤  │
│  │ Agent Runtime（一个 session 一个子进程）        │  │
│  │   Adapter:  ACP  ──►  omp / claude / codex ... │  │
│  │             RPC  ──►  omp 原生协议（可选增强）  │  │
│  │             PTY  ──►  兜底：只有终端的 agent    │  │
│  └───────────────────────────────────────────────┘  │
│  AgentRegistry（谁装在哪、怎么起、有什么能力）       │
└─────────────────────────────────────────────────────┘
```

### 2.1 内部事件模型（整个项目的核心资产）

UI **不认识任何 agent**，只认这几种事件。适配器负责把各家协议翻译成它们：

```ts
type AgentEvent =
  | { t: "session_started"; sessionId: string; agentId: string; cwd: string }
  | { t: "text_delta";     text: string }
  | { t: "thinking_delta"; text: string }
  | { t: "tool_call";      id: string; name: string; input: unknown; kind?: string }
  | { t: "tool_update";    id: string; status: "running"|"ok"|"error"; output?: string }
  | { t: "permission_ask"; id: string; title: string; options: PermOption[] }
  | { t: "permission_done";id: string; choice: string }
  | { t: "plan";           steps: { title: string; status: string }[] }
  | { t: "usage";          tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { t: "turn_end";       stopReason: string }
  | { t: "error";          message: string; fatal?: boolean };
```

**这条约束比任何框架选择都重要**：只要 UI 只消费 `AgentEvent`，换 agent 就是"加一个 adapter 文件"，
而不是"改 30 个组件"。做反了，第二个月就会推翻重来。

### 2.2 适配器接口

```ts
interface AgentAdapter {
  readonly id: string;                        // "omp" | "claude-code" | ...
  detect(): Promise<{ ok: boolean; version?: string; path?: string }>;
  capabilities(): Promise<AgentCaps>;          // 支持图片？支持 plan？支持取消？
  start(opts: StartOpts): Promise<{
    sessionId: string;
    events: AsyncIterable<AgentEvent>;
    send(text: string, images?: ImagePart[]): Promise<void>;
    cancel(): Promise<void>;
    respondPermission(id: string, choice: string): Promise<void>;
    resume?(sessionRef: string): Promise<void>;
    dispose(): Promise<void>;
  }>;
}
```

`AgentCaps` 决定 UI 哪些按钮亮：
```ts
type AgentCaps = {
  images: boolean; plan: boolean; cancel: boolean;
  resume: boolean; usage: boolean; permissions: "acp" | "none";
};
```

---

## 3. 接 omp 的具体路径

omp（`can1357/oh-my-pi`，MIT，35.8k★）已经把这三种入口都准备好了：

| 入口 | 用途 | 说明 |
|---|---|---|
| **ACP** | **主路径** | 文档 `omp.sh/docs/acp`；包里有 `./modes/acp` 导出。标准 JSON-RPC over stdio |
| **RPC** | 增强路径 | 文档 `omp.sh/docs/rpc`（约 90KB 规格），能力比 ACP 全（用量、plan、会话树等）。ACP 表达不了的东西再从这里补 |
| **SDK** | 想深度定制时才用 | `@oh-my-pi/pi-coding-agent`（18.x，Bun ≥1.3）、`@oh-my-pi/pi-agent-core`、`pi-wire` |
| 会话文件 | 历史/导入 | `docs/session.md`、`docs/session-format`；JSONL 落盘，可直接读 |

> 启动命令以 `omp --help` 为准（ACP 模式很可能就是 `omp acp`）；别把这行硬编码，写进 AgentRegistry 的配置里。

**ACP 最小握手（示意，签名以 `@agentclientprotocol/sdk` 实际为准）：**

```ts
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const child = spawn(ompPath, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = ndJsonStream(
  new WritableStream({ write: (c) => child.stdin.write(c) }),
  new ReadableStream({ start(c) { child.stdout.on("data", (d) => c.enqueue(d)); } })
);

const conn = new ClientSideConnection(
  () => ({
    async sessionUpdate(n) { /* → AgentEvent：text_delta / tool_call / plan */ },
    async requestPermission(req) { /* → permission_ask，等 UI 回包 */ },
    async readTextFile(req) { /* 若你把 fs 能力授给 agent */ },
  }),
  stream
);

const init = await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
});

const { sessionId } = await conn.newSession({ cwd, mcpServers: [] });
await conn.prompt({ sessionId, prompt: [{ type: "text", text: "帮我看下这个报错" }] });
```

**降级策略**：`detect()` 时先试 ACP；失败则退到 PTY（把 TUI 塞进 xterm，仍可用但无结构化事件），
UI 用 `capabilities()` 自动降级（工具卡片变成"原始输出版本"，审批按钮变灰）。

---

## 4. 数据与状态

- **每会话一个 JSONL**：`%APPDATA%/<App>/sessions/<sessionId>.jsonl`，一行一个 `AgentEvent`，只追加不改写
- **会话元数据**：`index.json`（id / 标题 / agentId / cwd / 更新时间），几百个会话足够，不用上 SQLite
- **恢复**：打开会话 = 重放 JSONL 重建 UI 状态；`resume` 时把 `sessionRef` 交给适配器（支持才用）
- **状态管理**：zustand 里只存"当前会话的事件数组 + 派生视图"，避免组件各自维护流式中状态
- **流式渲染**：`text_delta` 用 16ms 节流合并后再 setState，否则长回答会掉帧

---

## 5. 里程碑（按业余时间算，2–3 周）

| # | 里程碑 | 内容 | 验收标准 | 估时 |
|---|---|---|---|---|
| M0 | 骨架 | Electron + Vite + React + TS；主窗口；IPC 通道打通 | `npm run dev` 出窗口，主进程能 spawn 子进程并回显 stdout | 半天 |
| M1 | **ACP 跑通** | initialize / newSession / prompt；`sessionUpdate` 全部打到控制台 | 终端里能看到 omp 的完整事件流 JSON | 1–2 天 |
| M2 | 聊天渲染 | 消息列表、markdown + 代码高亮、流式增量、自动滚动 | 能像正常聊天一样读完一次回答 | 2–3 天 |
| M3 | **工具卡片 + 审批** | `tool_call` 卡片（折叠/展开、命令输出、diff）、`requestPermission` 弹窗 | "要跑命令了""要改文件了"都能看见并拦住 —— 这一步才像 DSH | 3 天 |
| M4 | 会话管理 | JSONL 落盘、侧栏列表、重开重放 | 关掉软件再打开，历史都在，能接着聊 | 2 天 |
| M5 | **Agent 注册表** | 多 agent 配置、`detect()`、能力探测、每会话绑定 agent | 界面里能加第二个 agent，新会话用它跑起来 | 1–2 天 |
| M6 | 打磨 | diff 视图、会话搜索、快捷键/命令面板、深色主题、完成通知、失败重试 | 自己用一周不别扭 | 持续 |

**建议顺序的取舍**：M3 是分水岭。M1–M2 只算"能聊天"，M3 之后才是"能干活"。所以不要先去抠 UI 细节。

---

## 6. 明确不做（v1）

- 多 agent 并行 / worktree 分叉（那是 Orca 的活）
- 内嵌编辑器、LSP、代码索引
- 手机端、远程 SSH、多人协作
- 云同步、账号体系、计费

想加，等 M6 用完一个月再判断 —— 大概率你会发现"自用"根本不需要。

---

## 7. 已知的坑

1. **ACP 版本/能力差异**：不同 agent 的 ACP 实现成熟度差很多，`initialize` 返回的 `agentCapabilities` 必须当运行时事实用，不能假设
2. **权限语义各家不同**：ACP 的 `requestPermission` 选项集合是 agent 给的，UI 不能硬编码"允许/拒绝/总是允许"三种
3. **Windows 子进程**：stdio 需显式 UTF-8（`chcp 65001` 不管用，要走 Buffer + TextDecoder）；路径别拼反斜杠进 JSON
4. **进程回收**：app 退出、崩溃、HMR 重载都要 kill 子进程，否则 omp 变僵尸占内存 —— 用 `app.on("before-quit")` + pid 文件
5. **流式节流**：不节流必掉帧；节流过头会显得"卡"。16ms 起步，实测再调
6. **别过早抽象**：先写死一个 ACP adapter 跑通，等 M5 再加第二个 —— 只有见过两个实现，抽象才是对的

---

## 8. 参考实现（MIT / Apache-2.0，可直接读代码）

| 项目 | 拿什么 |
|---|---|
| [gooey-pi](https://github.com/am-will/gooey-pi) | 功能清单与交互取舍（MIT）；它同时接 Pi / OMP / Prime，正是"多 agent 一套 UI"的现成案例 |
| [pi-desktop](https://github.com/FaqFirebase/pi-desktop) | 最小可用形态：Electron + 聊天 + 终端 + diff（Apache-2.0） |
| [Orca](https://github.com/stablyai/orca) | 事件模型、权限审批、PTY 守护进程的设计；`package.json` 里那堆 `check:*` 脚本的质量门禁 |
| [ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk) | 协议客户端本身 + examples |

---

## 9. 第一步（今天就能做）

```bash
mkdir omp-desktop && cd omp-desktop
npm create @quick-start/electron@latest .   # React + TS 模板
npm i @agentclientprotocol/sdk
# 先不写 UI：在 main 里 spawn `omp acp`，把收到的每一帧打到控制台
```

**当天目标**：`initialize` + `newSession` + 一次 `prompt`，屏幕上能看到 omp 吐回来的原始事件。
只要这一步通了，剩下的都是体力活。

---

## 10. 实现进度（2026-10-18）

代码在 [`omp-desktop/`](omp-desktop/)，运行说明见 [README](omp-desktop/README.md)。

| 里程碑 | 状态 | 实际落地 |
|---|---|---|
| M0 骨架 | ✅ | electron-vite + React 19 + TS；窗口、IPC、preload 全部打通 |
| M1 ACP 跑通 | ✅ | `probe.mjs` 直接验证：`initialize` → `session/new` → `session/prompt` |
| M2 聊天渲染 | ✅ | 流式 delta、思考折叠、Markdown/表格/代码块、自动贴底 |
| M3 工具卡片 + 审批 | ✅ | `tool_call`/`tool_call_update` 卡片、命令输出、diff、授权弹窗（选项来自 agent） |
| M4 会话持久化 | ✅ | 每会话 JSONL + `index.json`；重启后点历史 → `session/load` 恢复上下文，实测"记暗号→重启→追问"答对 |
| M5 Agent 注册表 | ✅ | `src/main/agents.ts` 表驱动 + `--version` 探测；会话绑定 agentId，UI 顶栏可切 |
| M6 打磨 | ✅ | 见下节：diff 视图、会话搜索、命令面板、深浅主题、完成通知、失败重试、流式节流 |

**M6 逐项对照（文档要求 → 实现）**

| 文档要求 | 实现 |
|---|---|
| diff 视图 | 行级 LCS diff（自写 `diff.ts`，无依赖）、±行着色、行号、变化上下文折叠（`⋯ N 行未变`）、+/− 统计、大文件退化保护、"展开全部" |
| 会话搜索 | 侧栏搜索框，按标题 / 目录 / agent 过滤 |
| 快捷键 / 命令面板 | `Ctrl+K` 面板（↑↓ 选择、Enter 执行、Esc 关闭）、`Ctrl+N` 新会话；命令含新会话、切换目录、切主题、日志、复制对话、滚动到底、切 Agent、打开最近会话、失败重试 |
| 深色主题 | 深/浅两套主题，顶栏一键切换并持久化（`localStorage`），浅色下重校了等宽文本/品牌名/空态标题的对比度 |
| 完成通知 | 窗口失焦时 `turn_end` 弹系统通知 + 任务栏闪烁，点击回到窗口 |
| 失败重试 | 报错后底部出现"上一条失败了 / 重试 / 忽略"，重试复用原文 |
| （文档 §7 坑）流式节流 | 16 ms 合并 delta，思考与正文分开缓冲，避免长回答掉帧 |

**锦上添花（v1 边界之外，也做了）**

| 项 | 实现 | 验证 |
|---|---|---|
| 会话重命名 / 删除 | 双击改名、悬停 ✎ / ✕；`store.rename/remove` + 两个 IPC | 改名后侧栏即时更新；删除后会话文件消失、计数 4→3 |
| 会话内全文搜索 | 逐条扫 JSONL（正文 / 思考 / 工具输出），返回命中数与上下文片段，250ms 防抖 | 搜 `scratch-demo` → 1 个会话、`7 条匹配` + 片段 |
| 图片粘贴 / 拖入 | 读成 base64 → **落盘到 `%TEMP%\omp-desktop-images`→ 路径附在消息正文**；缩略图随消息持久化 | 粘贴 1 张 → 发送 → omp 用 read 读到文件并分析（见下） |
| 代码块语法高亮 | `rehype-highlight` + 深/浅两套 token 配色 | 打开含代码的旧会话，`.hljs-keyword` 命中 7 处 |
| exe 版本信息 | electron-builder 自动写入 | `ProductName/FileVersion 0.1.0` 已核对 |
| 状态栏指标 | 模型名 / 本回合 tok/s / 缓存命中率 / 上下文占用与上限 / 花费，全部来自 ACP 的 `usage_update` 与 `prompt` 返回的 `usage` | 实测一条回复后显示 `63 tok/s · 缓存 95% · 12.3k / 1.00M（1.2%）· $0.0007` |
| 壁纸背景 | 读注册表当前壁纸 → data URL → `body` 背景 + 深/浅遮罩；顶栏/侧栏/输入框/卡片切换为磨砂半透明；支持自选图片（记忆路径） | 本机 `c:\windows\version.jpg` 正常透出 |

**状态栏两个坑**：① ACP 的 `inputTokens` **不含**缓存命中部分，缓存率要按 `cached/(input+cached)` 算，
否则会算出 12495% 这种值；② ACP 不给 TTFT，所以 tok/s 只能按"整回合输出 ÷ 整回合耗时"算，短回复偏低。

**图片为什么不用 ACP 内联格式**：实测把 `{type:"image", data, mimeType}` 发给 omp，它会转成 `local://image-<hash>.png` 再由自己的 fs 层去读，
结果是 `ENOENT: no such file or directory, open 'local://image-….png'`。改成"落成本地文件 + 把绝对路径写进正文"后，
任何带文件读取工具的 agent 都能看图，且不绑定 omp 的实现细节。

**代码签名没有做**：需要一张真实的 Windows 代码签名证书（EV/OV），自签名不会消除 SmartScreen 的"未知发布者"。
如果以后要分发，`electron-builder` 加 `win.certificateFile/certificatePassword`（或 Azure Trusted Signing）即可，配置位置已经清楚。

**实测得到的环境事实**（比文档更可靠）：

- `omp acp` 存在，协议版本 1；`agentCapabilities` = `loadSession` + `sessionCapabilities{list,fork,resume,close}` + `promptCapabilities{image,embeddedContext}`
- `session/new` 直接返回 `configOptions`：`mode`（default/plan）与 `model`（带 10+ 个模型），UI 因此不需要自己维护模型列表
- 事件实测序列：`available_commands_update` → `session_info_update` → **`request_permission`（先于 tool_call）** → `tool_call` → `tool_call_update`×N → `agent_message_chunk` → `usage_update` → prompt 返回 `stopReason: "end_turn"`
- `tool_call_update.content` 是**累积**数组且会重复回显同一段输出，落 UI 前必须做相邻去重
- 授权选项实测为 `allow_once / allow_always / reject_once / reject_always`，但**不要写死**，按传入的 `options` 渲染

**环境坑**：DSH 的运行环境里有 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以 Node 模式启动并报
`does not provide an export named 'BrowserWindow'`；启动前 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 即可。
另外 9222 端口被别的程序占用，CDP 改用了 9333。

**M4 / M5 实现时踩到的点**：

- `session/load` 会先把历史用 `session/update` 重放一遍；我们已经有本地 JSONL，所以在 load 期间**吞掉**所有 update，
  否则每条历史都会渲染两遍
- 会话元数据要**懒创建**：只有真正产生内容（user/text/tool…）才写进 index，否则每启动一次应用就多一个空会话
- `agent_exit` 与 `log` 不落盘，避免重放时弹出已结束进程的提示
- Agent 探测用 `<cmd> --version`，4 秒超时；探测失败的 agent 不出现在顶栏，但会话仍按记录的 agentId 恢复

---

## 11. 插件与自动化（2026-10-18 追加）

侧栏新增两个分区，接口按"能被脚本扩展"来设计。

### 插件

`src/main/plugins.ts`。插件 = 主进程里的 ESM 模块：

```js
export default { id, name, description, commands: [{ id, title, run(ctx) }] }
```

`ctx` 提供 `prompt/notify/log/storage` 四件事。注册的命令同时进入插件页与 `Ctrl+K` 面板。

- 目录：`%APPDATA%\omp-desktop\plugins\`（单文件或 `<name>/plugin.mjs`）
- 首次运行自动写 `demo.mjs`
- 每次打开插件页都会重新 `loadAll()`，改完代码点「重新加载」即可
- 取舍：**插件拥有完整 Node 权限**，没有沙箱 —— 自用工具，安全靠"自己只装自己写的"

### 自动化

`src/main/automations.ts`。调度器每 20s 扫一次，到点用**独立 headless 会话**跑一条 prompt：

- 独立 `AgentSession(..., { autoApprove: true })`：工具调用自动批准，不弹授权框、不干扰当前窗口
- 记录 `nextRunAt / lastRunAt / lastStatus / lastOutput`，完成后发系统通知
- 重启时不补跑：`load()` 会把过期的 `nextRunAt` 直接推到下一个周期

**两个实现坑**：

1. 自动化草稿状态最初也叫 `draft`，与输入框的 `draft` 撞名，`saveDraft` 里读到的其实是输入框字符串，导致"点保存没反应"。改名为 `autoDraft` 后正常。
2. 重启后 `nextRunAt` 留着旧值，调度器一启动就会把错过的任务全部立即补跑；改为加载时前推。

验证：插件页显示 `示例插件` 与两个命令（通知命令点一次即通）；自动化建了"立即运行"任务，20s 后卡片出现 `上次 19:12:31` 与输出 `OK`。

---

## 12. 修正：插件 = skills，自动化移除（2026-10-18）

上一版的「插件（主进程 ESM 模块）」和「自动化任务」都删掉了 —— 前者是我理解偏了：用户说的"插件"其实是 **skills**（SKILL.md 能力包）。

现在侧栏是 **会话 / 技能**：

- 技能清单直接跑 `omp skill list --json`，与 agent 自己看到的同源（本机 40 个，来自 `C:\Users\Kepler\.agents\skills\`）
- 客户端只读：搜索、看目录、打开 `SKILL.md`、一键把 `使用「X」技能：` 填进输入框
- 没有"启用/禁用"——omp 的技能加载规则不在客户端侧，客户端不应该假装能控制它
- 删除的文件：`src/main/plugins.ts`、`src/main/automations.ts`；同时清掉了 `%APPDATA%` 下的 `plugins\`、`automations.json`、`plugin-storage.json`

**教训**：需求里的"插件"在 agent 生态里有明确所指（skills / MCP / extension），先对齐再动手，比先写一套自己的 API 再删便宜得多。

---

## 13. 设置页（2026-10-18）

参照 Codex 桌面端的设置组织方式，做成分组页面而不是弹窗：

| 分组 | 项 |
|---|---|
| 模型与 Agent | 默认模型、默认模式、默认 Agent、默认工作目录 |
| 外观 | 主题、背景（纯色/壁纸/自选）、界面缩放 |
| 通知 | 回合完成通知开关 |
| 数据 | 打开数据目录、清空会话 |
| 关于 | 应用版本 + 已探测 agent 版本 |

实现：`src/main/settings.ts`（JSON + 默认值补齐）、`settings:get/save` IPC、`AppSettings` 类型在 shared 里共享。

**默认值怎么落地**：`agent:start` 之后调 `applyDefaults()`，用 `session/set_config_option` 套 `defaultModel/defaultMode`，再把 `currentValue` 改到本地 `lastConfig` 上，补发一次 `ready` 让渲染层同步（否则顶栏仍显示 agent 默认值）。

**踩的坑**：`lastConfig` 的赋值一开始没插进 `emit()` 的 ready 分支（PowerShell 替换静默失败），`applyDefaults` 拿到的永远是空数组，表现就是"设置里改了默认模型，重启后又回到 agent 默认"。加了行日志才定位到。

顺带发现 omp 的 `configOptions` 里还有第三项 `thought_level`（thinking 档位），当前设置页没暴露；要加的话就是再一个 select。

---

## 14. 布局调整（2026-10-18）

按反馈改了三处：

1. **去掉侧栏的"查看日志"**：它和会话记录确实重复，日志改到底部左侧的按钮里，点开是输入框上方的一条浮层
2. **设置挪到左下角**：和日志并排放在输入框左侧的按钮列（`日志` / `⚙ 设置`），侧栏不再有底部按钮
3. **输入框右移**：底部改成 `[按钮列] [输入框……]` 的横向布局，输入框占据右侧剩余宽度（最大 980px 居中），状态栏同步对齐

顺带把 `sidebar-foot` 整块删掉，侧栏现在只有会话列表/技能说明。

---

## 15. 输入条改成 DSH 式（2026-10-18）

按截图对齐：`[＋] [权限] [输入框……] [模型] [上下文徽标] [速率档位] [发送]`，状态栏保持原样不动。

- **`＋` 菜单**：上传文件 / 上传图片 / 切换工作目录 / 技能 / 命令面板 / 日志 / 设置
- **权限**：`询问权限` / `完全权限`，走 `agent:approval` → `session.setAutoApprove()`，同时写进 settings
- **模型 / 速率**：都从 `configOptions` 来，放在输入条右侧；速率就是 omp 的 thinking 档位
- **文件**：`pickFiles` 选路径，发送时以 `[附带的文件]` 列表附在正文后（和图片走同一套"落路径"的思路）
- **状态栏不动**：仍然是我最早那版（模型 / tok/s / 缓存 / 上下文 / 花费 / ACP）

**踩的坑**：omp 的 thinking 选项 `id = "thinking"` 而 `category = "thought_level"`，和直觉相反；按 `id === "thought_level"` 去找永远匹配不到，选择器是空的。改成两个字段任一匹配后正常（5 个档位：off / minimal / low / medium / high）。

---

## 16. 底部左右分栏（2026-10-18）

按手绘的竖线改成两栏：`.bottom-split` = `[左栏 104px | 1px 竖线 | 右栏]`。

- 左栏：`＋` 菜单按钮 + 权限下拉（询问 / 完全权限）
- 右栏：输入框（模型、上下文徽标、速率档位、发送都在框内右侧）+ 状态栏
- 竖线用 `border-right`，从输入区顶部一直贯穿到状态栏底部
- 顺带把左边的 `＋` 和权限从输入框里搬出来，输入框因此更宽

状态栏内容仍然没动，只是被放进右栏。

---

## 16. 底部左右分栏（改版）

按手绘修正：**左半边是一个整体**，不是把按钮竖着排进输入框左边。

- 左栏（150px）：`⚙ 设置` + 权限下拉，作为一个块，右侧一条 1px 竖线到底
- 右栏：输入框（`＋` 在框内最左，模型/上下文/速率/发送在框内最右）+ 状态栏
- 竖线是左栏的 `border-right`，与右栏等高（输入区顶端 → 状态栏底部）

第一版理解错成"左侧是按钮列、右侧是输入框"，把 `＋` 和权限都塞进了左栏；修正后 `＋` 回到输入框内，权限归左栏。

### 16b. 再修正：左半边是整块侧栏

参考用户给的另一个应用截图，最终形态是：

- **左栏 = 整块侧栏**：顶部「会话 / 技能」切换、搜索、列表，底部固定 `v0.1.0` + `⚙ 设置`
- **分界线 = 侧栏的右边框**，从窗口顶一直到底
- **右栏 = 对话 + 输入条**：`＋`、权限、输入框、模型、上下文、速率、发送；状态栏在输入条下方

之前两版把「左半边」理解成了输入框左侧的一块，所以来回折腾了两次。教训：布局类需求先让对方确认"左半边指的是侧栏还是输入条的一部分"，比猜三次便宜。

### 16c. 真正做成两栏（修结构）

问题出在结构上：`footer` 是 `.app` 的直接子元素，所以输入条横跨整个窗口宽度，看起来"跑到侧栏下面"。

改成：

```
.app (row)
├─ aside.sidebar   品牌 / 会话·技能 / 列表 / 底部版本+设置
└─ div.right (column)
   ├─ header.topbar
   ├─ main.main
   └─ footer.composer-wrap  输入条 + 状态栏
```

实测几何：sidebar x=0..220 全高；main x=220..1224；composer x=246..1198 —— 输入条完全落在右栏内，分界线从窗口顶贯到底。

### 17. 视觉打磨（2026-10-18）

反馈"每个按钮和选项都很生硬，没有图标或者圆角"，做了一轮统一：

- **图标**：新增内联 SVG `Icon` 组件（chat / sparkle / gear / moon / sun / plus / arrow-up / stop / folder / image / command / terminal / chevron），替换掉 `＋`、`↑`、`■`、`⚙`、`☾` 这些字符
- **圆角**：按钮/下拉 8–9px、输入条 14px、卡片与气泡 12px、菜单 12px
- **形状**：下拉去掉系统箭头，改 `appearance:none` + 自绘 chevron；模型/速率/权限变成带底色的 pill；`新会话` 变主色 pill；主题按钮变 icon-only pill
- **过渡**：统一 0.16s 缓动（背景/边框/颜色/阴影），发送按钮 hover 上浮 1px，`:focus-visible` 有强调色描边
- **细节**：工作目录加文件夹图标、空态加渐变 logo 方块、搜索框 focus 光晕、会话项 hover 高亮

原则：不引入 UI 框架，全部内联 SVG + CSS 变量，打包体积不变。

### 18. 会话按工作区分组（2026-10-18）

参考 DSH 的侧栏：会话不再平铺，按 `cwd` 分组。

- 组头：折叠箭头 + 文件夹图标 + 目录名（basename）+ 条数徽标；点击折叠/展开
- 组内默认显示 4 条，其余折叠为「展开其余 N 个会话」
- 时间从绝对时间改成相对时间（刚刚 / N 分钟 / N 小时 / N 天）
- 搜索时分组自动收敛为命中的组

踩坑：给组内 `.session-item` 加 `margin-left` 后出现横向滚动条（`width:100%` + margin 溢出），改成 `width:auto` 后消失。

### 19. 输入卡片化 + 自绘下拉 + 新会话上移（2026-10-18）

- **输入框**：从"一行控件 + 输入"改成**一个圆角卡片**：上半是 textarea，下半是 toolbar（左 `＋`/权限，右 模型/上下文/速率/发送），占位文案对齐 DSH
- **下拉**：新增 `Select` 组件（button + 圆角菜单 + 点击外部关闭），替换 composer 里的原生 `<select>`；菜单向上弹、右侧两个右对齐，`:hover`/选中态有底色
- **新会话**：从顶栏移到侧栏最上方（品牌下面、工作区上面），整宽按钮
- 顶栏只留目录、Agent、模式、主题

没动的：状态栏、会话分组逻辑、消息区。

### 20. 输入区上方的「工作区 / 模式」（2026-10-18）

照 DSH 新会话的样子，在输入卡片上方加一行：

- **工作区**：文件夹图标 + 当前目录名 + chevron，点击打开目录选择
- **模式**：从顶栏挪下来的 Default/Plan，用同一套 `Select` 组件；显示时本地化为「标准模式 / 计划模式」
- 顶栏因此只剩：会话标题（左）、Agent 下拉、主题按钮（右）

### 21. Wallpaper Engine 壁纸（2026-10-18）

「桌面壁纸」原本读的是 Windows 注册表，用户要的是 Wallpaper Engine 的壁纸。改成：

- **扫描**：从 `HKCU\Software\Valve\Steam\SteamPath` + `libraryfolders.vdf` 收集 Steam 库，扫 `steamapps\workshop\content\431960\*\project.json`
- **解析**：`title / type / file / preview`；`video`、`image` 类型可直接播放，`scene`/`web` 用 `preview` 图代替
- **选择器**：设置 → 背景 →「Wallpaper Engine…」打开网格，显示预览图、标题、类型徽标
- **自定义协议**：`ompmedia://local/?path=<绝对路径>`，主进程用 `protocol.handle` 读文件并返回（带 Range 支持，视频可拖进度），CSP 放行 `img-src/media-src ompmedia:`
- **渲染**：`.bg-layer` 固定层，视频 `<video autoplay muted loop playsinline>`，图片 `<img>`；上层 `bg-shade` 按主题遮罩
- 选择结果写进 `settings.json` 的 `weWallpaper`

**踩的坑**：`protocol.handle` 那段最初没有真正插进 `whenReady`（PowerShell 替换里的 `\n` 是字面量），表现为所有 `ompmedia://` 请求都 `Failed to fetch`；`net.fetch(file://)` 也不可靠，改成直接 `readFileSync` + 手写 206 Range 响应后正常。

### 22. A 方案执行：接入 DSH 设计令牌（2026-10-18）

不再手搓配色。做法：

1. 用 `@electron/asar` 定位到本机 DSH 桌面端的 `resources/app.asar`（174 MB）
2. 在二进制里搜 `--dsw-alias-`，定位到 `design-platform.css` + `ui-theme` 的内联样式
3. 抽出三块规则：`body`（light，302 声明）、`body[data-ds-dark-theme]`（dark，192 声明）、调色板规则（`--dsw-static-*`）
4. 生成 `dsh-tokens.css`：`:root` 放调色板，`:root,:root[data-theme=light]` 放 light alias，`:root[data-theme=dark]` 放 dark alias
5. 在 `styles.css` 末尾加适配层：`--bg → bg-base`、`--panel → bg-layer-1`、`--text → label-primary`、`--accent → button-info-fill` …；并把 sidebar/topbar/composer/菜单/气泡换成对应 surface 令牌与 8/12/16px 圆角

**踩坑**：

- 规则拼接时少了分号，`--dsw-static-red-900` 把后面的 `--dsw-alias-bg-base` 吞掉，导致整块 dark 令牌算出来是空值
- 调色板原本只在 light 规则里，dark 主题下引用就失效 → 调色板改为全局 `:root`
- `[data-bg="image"] body` 里硬编码的 `#0a0c10` 覆盖了主题背景，浅色主题下聊天区全黑 → 改成 `var(--dsw-alias-bg-base)`
- 直接改 `dataset.theme` 不触发 React 重渲染，backdrop-filter 图层会残留旧颜色；切换主题应走设置页（写入 settings.json 后生效）

**已知问题**：主题切换瞬间个别磨砂层可能不重绘，刷新即恢复；后续可把 `backdrop-filter` 换成纯色 surface 解决。

### 23. 工作区工具：文件搜索 / 添加工作区 / 展示方式（2026-10-18）

按 DSH 侧栏补齐三件事：

- **添加工作区**：`＋` → 选目录 → 写进 `settings.workspaces`，即使没有会话也会出现在列表里（置顶）
- **进入工作区**：组头 hover 出现 `→`，点一下就在该目录开新会话
- **展示方式**：`工作区`（分组）/ `按时间`（平铺）二选一，存进 `settings.sessionView`
- **文件搜索**：同一个搜索框，除会话外还搜当前工作区文件名（主进程递归扫描，跳过 node_modules/.git/dist 等，深度 6、上限 200，返回 60）；点结果把绝对路径插到输入框

实现：`fs:search` IPC + `searchFiles()`；渲染侧 300ms 防抖；工作区状态落在 `settings.json`。

**注意**：文件搜索是同步递归（在主进程里），大仓库会卡一下；后续可以换成异步流式 + ripgrep。

### 24. 工作区交互收敛（2026-10-18）

按要求删掉「按时间」平铺，只保留工作区分组：

- 每个工作区行：`v` 折叠 / 文件夹图标 / 名称 / 会话数 / `＋`（在该目录新建对话）
- **当前工作区高亮**：`g.cwd === cwd` 时文件夹图标用品牌色（实测 `rgb(65,118,230)`），名称用主文字色；`＋` 常驻可见，其余工作区 hover 才出现
- 顶部「工作区」行只保留一个 `＋`（添加工作区）
- `settings.sessionView` 字段保留但不再使用（向后兼容旧配置）

### 25. 工作区右键菜单（2026-10-18）

右键工作区行：

| 项 | 行为 |
|---|---|
| 重命名… | 行内变输入框，Enter/blur 提交，别名写进 `settings.workspaceNames[path]`；清空则恢复目录名 |
| 在资源管理器中打开 | `shell.openPath(path)`（复用 skills 的 open IPC） |
| 复制路径 | `navigator.clipboard.writeText` |
| 移除工作区 | 手动添加的从 `workspaces` 删除；会话自动带出来的写进 `hiddenWorkspaces`（重新添加同一目录会自动解除隐藏） |

实现：`onContextMenu` → 记录坐标 → 固定定位菜单 + 全屏 backdrop 点击关闭；菜单用 `--dsw-specific-menu` 令牌 + backdrop blur。

### 26. 产出文件卡片 + 右侧预览（2026-10-18）

- **文件卡片**：从 `tool_update` 的 `diff.path` 收集每轮的改动文件，在该轮最后一条消息下方渲染卡片（扩展名徽标、文件名、目录、预览/打开）
- **右侧预览面板**：与左栏并列的第三列（420px，最小 320）
  - 图片 → `ompmedia://` 直出
  - Markdown → 复用消息渲染器
  - 文本/代码 → `fs:read` 读入 `<pre>`（2MB 上限）
  - PDF → iframe 走 Chromium 内置阅读器
  - 其他 → 提示用系统程序打开
- 新增 IPC `fs:read`（带大小上限），复用 `shell.openPath`

**注意**：产出文件目前只认 diff（编辑/新建文件）；通过 shell 重定向产生的文件不会被识别。状态栏在窄栏下加了 `nowrap` 防止换行。

### 27. 产出文件交互修正（2026-10-18）

去掉右侧预览面板，交互改成"文件管理器"直觉：

- **单击卡片** → `shell.openPath`（系统默认程序打开）
- **右键** → 打开 / 打开方式…（`rundll32 shell32.dll,OpenAs_RunDLL`）/ 打开所在文件夹（`shell.showItemInFolder`）/ 复制路径
- **图标放大**：类型徽标 34→46px、圆角 12px、字号 11.5；图片类型直接渲染 46px 缩略图（`ompmedia://`）
- 卡片整块可点、hover 有底色和 `↗` 提示；移除了原来的「预览/打开」小按钮

新增 IPC：`fs:reveal`、`fs:openWith`。`fs:read` 保留（暂时没界面用，留给以后）。

### 28. 去掉输入框蓝色焦点框（2026-10-18）

两处来源都去掉了：

- 全局 `textarea:focus-visible { outline: 2px solid rgba(124,156,255,.55) }` 把 `<textarea>` 从选择器里移除，并给 `.composer textarea` 强制 `outline/box-shadow/border: none`
- `.composer:focus-within` 的蓝色描边与光晕改成中性边框（`--dsw-alias-border-l3`），`box-shadow: none`

现在聚焦时只有整张输入卡片的一圈细边，不再有内层蓝框。

### 29. 每轮统计 + 左右分栏（2026-10-18）

- `turn_end` 里已经有 `usage`（input/cached/output）与 `turnStart` 时间戳，直接算出「用时 N 秒」和「N tok」，追加一条 `kind: "turn"` 的条目渲染在每轮最后
- **回退**：找该 turn 之前最后一条 user，把 items 截断到那里、文本回填输入框、`window.api.start()` 重开会话（agent 上下文清空，界面历史保留）
- **左右分栏**：`.msg.user` 用 flex 列、`align-items: flex-end`，气泡 `max-width: 78%`；agent 侧 `flex-start`

**已知**：回退只回滚对话与上下文，不回滚已改的文件（ACP 没有文件快照能力）。

### 30. 右侧轮次导航条（2026-10-18）

- 每条用户消息渲染时带 `id="turn-<itemId>"` 锚点
- `turnList` = 所有 user 条目（label 取前 40 字作 tooltip）
- `.turn-rail` 绝对定位在 `.right` 右侧，垂直居中；`turn-tick` 10-12px 细线，`on` 状态 24px + 主文字色
- 滚动时用 `scrollTop + 90` 找最后一个进入视口的轮次作为 active；点击平滑滚到该轮
- 只有 1 轮时不显示；超过 70vh 的部分裁掉

**限制**：只按用户轮次分刻度，不按每条消息；超长会话的刻度会压缩（后续可做 hover 放大的迷你地图）。

### 31. 去掉消息角色标签（2026-10-18）

`<div className="msg-role">你</div>` 与 `agent` 两个标签删除，靠左右分栏区分说话人（你右、agent 左）。

### 32. 文件快照与真回退（2026-10-18）

之前回退只回滚对话，文件改了就回不去。现在加了快照：

- **快照时机**：`tool_update` 带 `diff` 时，把 `diff.oldText` 存到 `%APPDATA%\omp-desktop\checkpoints\<sessionId>\<turnId>\<sha1(path)>.json`；同一轮同一路径只记第一次（那就是这轮开始前的状态）
- **新文件**：`oldText: null` → 记为 `existed: false`，回退时删掉
- **不可快照**：`oldText === undefined`（协议没给旧内容）直接跳过，避免把文件误删
- **回退**：先 `restoreCheckpoint(session, turnId)` 写回/删除，再截断 items、回填输入框、重开会话；最后插一条 note「已回退：恢复 N 个文件（、删除 M 个新建文件）」
- 删除会话时 `dropCheckpoints` 清掉对应目录

**验证**：VERSION 2 → 让 agent 改成 3 → 点回退 → 文件回到 2，输入框回填原话，提示「已回退：恢复 1 个文件」。

**限制**：只覆盖 `diff` 能看到的文件改动；shell 重定向、脚本批量生成的文件不在快照范围。

### 33. 版本号跟对话轮次（2026-10-18）

版本改为 `0.<用户发言轮数>.0`：

- 轮数来源：当前 DSH 会话日志 `~/.dsh/sessions/.../session.v4.jsonl.zstd`，用 `fzstd` 解压后统计 `turn/start` 事件
- 本次统计 39 轮 → `package.json` 与侧栏显示都改成 `0.39.0`，产物为 `OMP-Desktop-Setup-0.39.0.exe`
- 旧的 0.1.0 安装包已删除

### 34. 手机访问：内置远程服务 + Cloudflare 隧道（2026-10-18）

一个软件搞定，不需要另装任何东西：

- **RemoteServer**（`src/main/remote.ts`）：`http` + `ws`，监听 `127.0.0.1:7788`，token 鉴权（`?token=`，错 token 401）
  - `/` 返回单文件手机页面（深色、流式文本、权限按钮、composer）
  - `/ws` 订阅事件流；手机发 `prompt`/`permission`/`cancel` 直接打到当前 ACP 会话
  - `ingest()` 把 `AgentEvent` 转成手机可读的行，维护最近 300 行历史，新连接先发 `hello` + 历史
- **Tunnel**（`src/main/tunnel.ts`）：懒加载 cloudflared（PATH 里找 → 否则下载，多个镜像兜底），`tunnel --url http://127.0.0.1:7788`，从输出里正则抠 `https://*.trycloudflare.com`
- **设置页**：开关、本机地址、隧道开关、公网地址，都能一键复制
- 打包：`ws` 加进 `externalizeDepsPlugin.exclude`，否则打进安装包会缺依赖

**踩坑**：

- cloudflared 走 GitHub 直连 SSL 失败、走代理 180s 超时只下了 24.7MB（总 55.3MB），`curl -C -` 续传后才完整；进度条还没做
- 手机页面最初用 `chrome --headless --screenshot --window-size=390,844` 截图，实际按 800 宽布局再裁切，导致按钮"消失"；改用 CDP `Emulation.setDeviceMetricsOverride` 才正确

**验证**：公网 URL 返回 200、错 token 401；手机端发「只回复两个字：在的」收到流式 `text` → `turn_end`；安装版隧道 3 秒拿到地址。

### 35. 壁纸模式为什么不生效（2026-10-18）

用户反馈「切换背景没用」。排查后发现壁纸图其实已经加载（`naturalWidth = 4721`、铺满视口），但被**不透明的 `body` 背景盖住了**：

- `.bg-layer` 是 `position: fixed; z-index: -1`，绘制在负层
- `body { background: var(--bg) }` 属于普通块背景，绘制顺序在负 z-index 之后 → 直接把壁纸遮住
- 浅色主题下 body 是 `#fff`，所以看起来"什么都没发生"；深色主题偶尔因为别处背景透明才偶然可见

修复：

- 底色移到 `html`，`[data-bg="image"] body { background: transparent }`
- 浅色遮罩 0.84 → 0.55、深色 0.74 → 0.62（不然壁纸被洗白）
- 壁纸模式下 `.panel` 透明、`.set-group` / 技能卡改成 78% 磨砂，设置页和技能页也能看到背景

**回答用户的问题**：背景是全局的，不是只有对话才有；之前是设置页里被白底挡住看不出来。

### 36. 手机端：会话列表 / 切换 / 可安装（2026-10-18）

- **会话列表**：`GET /api/sessions?token=` 返回 `store.list()`；手机页右上角「会话」打开全屏列表，显示标题、目录、时间，当前会话高亮
- **切换**：点一条 → WS `{type:"open", id}` → 主进程 `disposeSession()` + `session.resume(id, cwd)`，成功后把该会话的**历史事件回放**成 `hello.history` 发给手机；桌面端同时也跟着切过去（共享同一个 agent 会话）
- **可安装**：加了 `manifest.webmanifest`（名称、图标 192/512、standalone、主题色）和 `apple-touch-icon`，在 HTTPS（隧道）下 Chrome/Edge 会提示「安装应用 / 添加到主屏幕」，图标点开就是全屏无地址栏
- 图标由 `tools/make-pwa-icons.py` 从 `build/icon.png` 生成，已打进安装包

**为什么不直接给 APK**：本机只有 JDK 19 + adb，没有 Android SDK（`platforms`/`build-tools` 缺失）。打 APK 需要装 commandline-tools + platform + build-tools + Gradle（约 1–2 GB 下载），PWA 先用着体验一致。

### 37. 真 APK：OMP Mobile（2026-10-18）

用户指出本机其实有 Android Studio（`C:\Program Files\Android\Android Studio`），SDK 在 `D:\Android\Sdk`（platforms 33 / 36.1，build-tools 34/36/37），Gradle 9.0 与 AGP 8.9.2 已有缓存。

于是建了 `omp-mobile/`（独立 Android 工程，纯 Java、零 AndroidX 依赖）：

- `MainActivity`：WebView 壳；首次启动是「粘贴地址」界面，之后从 SharedPreferences 直连；支持 `omp://open?url=...` 深链
- 配置：`compileSdk 33 / minSdk 24 / targetSdk 33 / versionName 0.39.0`
- 构建：`gradle assembleDebug`（AGP 8.9.2 + Gradle 9.0 + JBR 25，自动装了 build-tools 35）
- 产物：`omp-mobile/app/build/outputs/apk/debug/app-debug.apk`（40 KB），复制到 `omp-desktop/release/OMP-Mobile-0.39.0.apk`

**踩坑**：

- `JAVA_HOME` 带空格（`C:\Program Files\...`）时 Gradle 启动脚本把路径切成了 `C`，改用 8.3 短路径 `C:\PROGRA~1\Android\Android Studio\jbr` 才过
- `plugins { id "com.android.application" version ... }` 在离线模式下解析不到 plugin marker，改成 `buildscript { classpath ... }` + `apply plugin` 才能走缓存；最终仍需联网下载 AGP 与 build-tools 35
- adb 当前没有连接设备，未能实机验证安装

### 38. 命名隧道（自有域名）（2026-10-18）

设置 → 手机访问 → 隧道类型：

- **快速**：`cloudflared tunnel --url ...`，随机 `*.trycloudflare.com`，重启就变
- **命名**：`cloudflared tunnel run --token <token>`，公网域名由用户在 Cloudflare 后台配好，软件只照着填

字段：`tunnelMode`、`tunnelToken`、`tunnelHostname`（都存 settings.json）。命名模式下地址显示为 `https://<hostname>`，等日志出现 `Registered tunnel connection` 才算 running。

配置步骤（给用户）：

1. 买域名 → 加到 Cloudflare（免费套餐）→ 改 NS
2. Zero Trust → Networks → Tunnels → Create a tunnel → 选 cloudflared → 复制 token
3. 该隧道 → Public Hostname → `omp.你的域名.com` → service `HTTP` → `localhost:7788`
4. 软件里填 token + 域名 → 开隧道

**注意**：`tunnel run --token` 不能同时带 `--url`（ingress 由后台配置决定）。

### 39. 1.0.0：手机端本地壳 + 全量版本号（2026-10-19）

用户反馈 APK 冷启动白屏久。改成**本地壳 + 远程数据**：

- 页面抽出成单一源文件 `mobile/index.html`（`tools/gen-mobile-page.mjs` 生成 `src/main/mobile-page.ts`，桌面端 serve 同一份；APK 构建前复制进 `app/src/main/assets/index.html`）
- APK 打开即 `file:///android_asset/index.html?host=…&token=…`，界面 0 网络等待；WS 再异步连 `wss://host/ws`
- 跨域处理：WS 不校验 Origin；`/api/sessions` 加了 `Access-Control-Allow-Origin: *`，同时新增 WS 消息 `{type:"sessions"}` → `{t:"sessions", list, current}`，手机端只走 WS，不再 fetch
- 桌面端启动 3 秒后自动恢复远程服务与隧道；token 持久化到 `settings.json`（`remoteToken`），重启不变
- 版本统一 `1.0.0`：`package.json`、侧栏 `v1.0.0`、APK `versionName 1.0.0 / versionCode 100`、安装包 `OMP-Desktop-Setup-1.0.0.exe`

**坑**：`import PAGE from "../../mobile/index.html?raw"` 在 electron-vite 的 main 构建里不认 `?raw`，改成构建前生成 TS 模块。

### 40. 手机端 Markdown 渲染（2026-10-19）

之前手机页面用 `textContent` 直出，所以 `**加粗**`、反引号、`- 列表` 都是原样文本。

加了 ~50 行轻量渲染器（无依赖）：

- 块级：标题 `#~####`、无序/有序列表、引用、代码围栏、分隔线
- 行内：`代码`、**加粗**、*斜体*、`[文字](链接)`
- 流式：每来一段文本追加到 `curRaw`，用 `md(curRaw)` 整体重渲染，避免半截标记闪烁
- 历史回放同样走渲染器（`hello.history` 里的 agent 行）
- 样式：代码块深底圆角、行内代码胶囊、列表缩进、链接蓝色

同一份 `mobile/index.html` 同时服务 APK 本地壳和浏览器版。

### 41. 改名 OT（2026-10-19）

- 产品名：`productName: "OT"`，窗口标题/通知/侧栏品牌/页面 title 全部 OT
- 安装包：`OT-Setup-1.0.0.exe`（安装到 `%LOCALAPPDATA%\Programs\OT`），旧的 OMP Desktop 已卸载
- 手机端：APK label `OT`，`OT-Mobile-1.0.0.apk`
- **数据目录保持不变**：`app.setPath("userData", appData/omp-desktop)`，所以会话、设置、隧道 token、checkpoints 全部沿用，没丢
- GitHub 仓库改名为 `T-Kepler/ot`，release 资产替换为 OT 版
- 目录名（omp-desktop/omp-mobile）保留，避免破坏构建路径

### 42. 1.1.0：Agent 选择收进设置、主题按钮下移（2026-10-19）

- 顶栏不再放 Agent 下拉，只留会话标题
- 设置 → 模型与 Agent 新增「当前 Agent」，切换即换后端（等价于新开会话）
- 主题切换从顶栏移到左下角，紧挨「设置」：`[v1.1.0] [🌙] [⚙ 设置]`
- 版本策略：每轮对话 +0.1，本轮 1.0.0 → 1.1.0

### 43. 1.2.0：手机端右滑会话 + 上传附件（2026-10-19）

- **右滑打开会话列表**：顶栏「会话」按钮删除，改为从左边缘（<70px）向右滑 >70px 打开；面板内左滑关闭，带 220ms 位移动画
- **上传按钮**：输入框左侧 `＋`，可选多张图片和文件
  - 图片 → base64 直接作为 ACP image 内容块随 prompt 发送
  - 其他文件 → WS `{type:"file"}` 发到电脑，存 `%TEMP%\ot-mobile\<ts>-<name>`，回 `{t:"file_saved", path}`；发送时把路径拼进 prompt（`[附带的文件]`），agent 用 read 工具读
  - 附件以 chip 展示（图片缩略图 + 文件名 + 删除），上传中显示「上传中…」，未完成时发送会提示
- 版本 1.1.0 → 1.2.0

**坑**：`mobile-page.ts` 由 `mobile/index.html` 生成，改页面后必须 `node tools/gen-mobile-page.mjs` 再 `npm run build`，否则桌面端 serve 的还是旧页面。

### 44. 1.3.0：按需求文档的批量改造（2026-10-19）

完成：

- 侧栏改成竖排导航：新建对话 / 技能 / 会话（带图标），会话列表在下方
- 品牌行 OT 右侧加手机连接状态：绿=已连接、灰=未连接（由 WS 客户端数驱动）
- 状态栏重做并常驻：状态、模型、上下文环 + 上限、tok/s、累计 token、第 N 轮、花费、剩余额度（可配初始余额/单价）
- 每轮结束行：回退（含快照）、结束时间、fork（从该轮新开会话并回填输入）
- 设置新增：推理显示（完整/摘要/隐藏）、背景遮罩与模糊滑杆、计费（输入/输出单价、初始余额）
- 技能面板加「技能商店」按钮（链到 omp 仓库 skills 说明）
- 手机端：右滑会话保持；修上传（Android onShowFileChooser）、主题切换、重连按钮、20s 心跳、回前台自动重连
- 版本 1.2.0 → 1.3.0

未做（需确认或较大）：

- 自定义添加模型（当前模型来自 agent 的 configOptions）
- GitHub 连接 + 按需自动上传
- 技能中文简介（omp 返回的是英文描述，需要翻译源）
- 背景材质（玻璃/磨砂）目前用「遮罩 + 模糊」近似

**omp 里值得加的能力**（调研结果）：`--add-dir` 多目录、smol/slow/plan 三种模型角色、prewalk 自动切便宜模型、plan-yolo 自动批计划、--profile 多套配置、--models 快捷循环。

### 45. 1.4.0：多目录、prewalk、技能中文、状态栏打磨（2026-10-19）

- `--add-dir`：设置里可添加多个附加目录，启动时拼进 `omp acp` 参数
- `--prewalk`：设置开关，开启后传给 agent（需配置 smol 模型，否则 omp 会告警但可运行）
- 技能中文简介：40 个技能硬翻成本地 `SKILL_ZH` 表，卡片显示「中文一行 + 原英文 + 路径」
- 状态栏：等距分布（每个指标 flex:1 居中）、字号颜色加深、模型名不再截断、「就绪」改为柔和绿
- 余额常驻显示（初始余额 0 时显示 余 $0.00）
- 版本 1.3.0 → 1.4.0

**未做**：自定义模型、GitHub 连接（等用户给仓库与凭据方案）；玻璃质感按用户要求跳过。

### 46. 1.5.0：模型角色、自定义模型、余额查询、GitHub 自动上传（2026-10-19）

- **模型角色**：设置里填 smol / slow / plan，启动参数 `--smol=/--slow=/--plan=` 传给 `omp acp`
- **自定义模型**：填名称/BaseURL/模型ID/API Key → 追加到 `~/.omp/agent/models.yml` 的 `providers:` 下（写前留 `.bak`），重开会话后在模型下拉出现
- **余额**：设置里填 DeepSeek API Key，主进程调 `https://api.deepseek.com/user/balance`，状态栏显示 `余 X CNY`；没有 key 时回退到「初始余额 - 花费」
- **缓存命中率**：状态栏新增 `缓存 NN%`
- **GitHub 自动上传**：设置开关；会话里出现「上传/推送/提交 + github」意图后，该会话后续每轮结束执行 `git add/commit/push`；没有 origin 时用本机 `git credential` 的 token 通过 API 新建公开仓库并推送
- 新增 `note` 事件类型，用于把「已上传到 xxx」这类提示插进对话
- 版本 1.4.0 → 1.5.0

**注意**：自动上传会真的推代码到 GitHub，首次使用请确认工作区内容适合公开。

### 47. 1.6.0：上传前敏感文件拦截（2026-10-19）

- `autoUpload` 在 `git add -A` 之后检查暂存区文件名，命中规则则 `git reset` 撤销暂存并中止上传
- 规则：`.env` / `.env.*`、`*.pem|key|p12|pfx|keystore|jks|ppk`、`id_rsa|id_dsa|id_ecdsa|id_ed25519`、`.npmrc|.pypirc|.netrc|.git-credentials`、`credentials.*|secrets.*`、`.aws/credentials`、`.ssh/*`
- 命中时插入 note：列出前 8 个文件，提示加入 .gitignore 或移出工作区
- 设置 → GitHub 增加「拦截敏感文件」开关（默认开）和「立即上传一次」按钮（便于手动触发/验证）
- 版本 1.5.0 → 1.6.0

**验证**：临时仓库放入 `.env` 与 `server.key`，触发上传 → 返回 ok、暂存被撤销，对话里出现「已拦截自动上传：检测到敏感文件 · .env · server.key」。

### 48. 1.7.0：一键写入 .gitignore（2026-10-19）

拦截敏感文件时，提示里多一个按钮：

- note 文本带 `[fix-gitignore]` 标记，渲染器识别后去掉标记并渲染「一键写入 .gitignore」按钮
- 点击调用 `github:fixGitignore`：在 git 根目录扫描未跟踪/已修改文件，命中敏感规则后按类型归纳成规则（`.env*`、`*.key`、`id_*`、`.ssh/`、`.aws/` 等），追加到 `.gitignore` 末尾（带「# OT 自动补充（敏感文件）」注释），已存在的规则不重复写
- 写入后再发 note 告知条数，用户可再次点上传

**验证**：临时仓库含 `.env`、`server.key` → 上传被拦截 → 点按钮 → `.gitignore` 得到 `.env*` 和 `*.key`（added=2）。

### 49. 1.8.0：全量改名为 OT（2026-10-19）

改的：

- `package.json` name → `ot`，appId → `com.local.ot`，安装目录 `%LOCALAPPDATA%\Programs\OT`，进程 `OT.exe`
- 应用标识 `app.setAppUserModelId("com.local.ot")`
- 数据目录 → `%APPDATA%\ot`，启动时从旧的 `omp-desktop` 迁移 `settings.json / sessions / checkpoints / bin`（逐项拷贝，避开 Chromium 占用的锁文件）
- Android：`applicationId / namespace` → `dev.ot.app`，Java 包目录同步迁移，label OT
- 旧 `OT 1.7.0` 卸载项已从注册表清理，只留 1.8.0
- 版本 1.7.0 → 1.8.0

没改（规避破坏）：

- 仓库里的目录名 `omp-desktop/`、`omp-mobile/`：被系统进程占用无法重命名，且会打断所有构建路径；对外可见的名字已经全是 OT

### 50. 1.9.0：默认浅色、去掉 ⌘K、余额自动查、峰谷计费（2026-10-19）

- 默认主题改浅色（新装即浅色；老配置通过迁移不再覆盖，并已把当前配置切到浅色）
- 侧栏 ⌘K 按钮删除（命令面板仍可用 Ctrl+K）
- 余额：API Key 改动后 600ms 自动查询，并每 2 分钟刷新；设置里加「查询余额」按钮
- DeepSeek 峰谷计费：设置里可开/关、填缓存命中价、谷时折扣（默认 0.5）；状态栏显示「峰时 / 谷时」，谷时按折扣计价
- 修复：迁移逻辑每次启动都覆盖 settings.json（导致改主题失效），改为仅在目标目录没有 settings.json 时迁移一次
- 清理测试留下的两个临时会话
- 版本 1.8.0 → 1.9.0
