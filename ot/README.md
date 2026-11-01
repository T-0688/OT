# OT

一个桌面应用，只跟 **Claude Code** 打交道：**会话、花费、供应商与守卫**放在一个窗口里。
终端仍然是你的原生 Claude Code —— OT 不接管终端、不做聊天客户端，只读它自己写的转录。

```
OT.exe        窗口 + 托盘，只有这一个程序
数据目录      %LOCALAPPDATA%\ot\
              providers.json   供应商表（明文 key）
              state.json       守卫阈值 + tail 游标
              backup\          每次改配置前的备份
```

## 安装 / 启动

```powershell
cd "D:\.Daily\DeepSeek Harness\ot"
.\install.ps1            # 装到 %LOCALAPPDATA%\ot\bin，建开始菜单「OT」
.\install.ps1 -Startup   # 另外开机自启
```

装完只有 `OT.exe` 一个文件（约 5.3 MB）。开始菜单「OT」启动；关窗口后仍驻留托盘，
左键托盘图标重新打开，右键有花费 / 供应商 / 暂停守卫 / 退出。

## 五个页签

| 页 | 内容 |
|---|---|
| **会话** | Claude Code 的会话列表（项目、标题、花费、token、工具数、最后活动、降级标记）；点一行看逐轮详情；勾选多个 →「删除选中」= **彻底删除**（转录 + file-history + session-env + todos + 全局历史里对应行，不可恢复）；一键在新终端里 `claude --resume` |
| **花费** | 按天 / 按模型 / 按项目三种聚合 + 缓存命中率。金额优先用转录里记录的 usage |
| **供应商** | 自己的 provider 表（只有 claude）：切换、增删、改角色模型、**给每个供应商填价目**（模型 → 输入/输出/缓存读，$/百万 token，`*` 表示兜底）。顶部横幅对比「实际生效」的 base_url，指向 `127.0.0.1` 会提醒 |
| **额度** | 按供应商聚合：今日 / 本月花费、价目条数、日 / 月限额、实时余额（进页面就查，查不到的不显示） |
| **守卫** | 单轮预算、缓存下限、上下文提醒、连败阈值、通知开关、暂停。后台每 3 秒读新事件，命中就发系统通知 |

## 供应商切换到底改了什么

切换不是"记个状态"，而是直接写 agent 自己的配置文件：

| 应用 | 写哪 | 保留什么 |
|---|---|---|
| claude | `~/.claude/settings.json` 的 `env` | 只合并 `ANTHROPIC_*`；`statusLine`、`permissions`、`enabledPlugins` 原样保留 |

写前备份到 `%LOCALAPPDATA%\ot\backup\`，写后读回校验。agent 正在跑的会话需要重开才会读到新配置
——这也是为什么 OT 不跑本地代理：代理能在不重启时切换，但那是另一个量级的工程，而且你本来就要重开会话。

## 价目表：给没有金额的来源算钱

Claude Code 的转录自带 `cost-state`，这是真实金额，OT 直接采信。
只有转录里没记金额的调用才需要自己在 `供应商` 页填价目：

```
计价模型  gpt-6-astra        输入 $/M  1.0    输出 $/M  4.0    缓存读 $/M  0.1
计价模型  *                  输入 $/M  2.0    输出 $/M  8.0    缓存读 $/M  0
```

- key 是模型名，匹配时忽略大小写、允许后缀（`gpt-6-astra[1m]` 也算命中 `gpt-6-astra`）
- `*` 是这个供应商的兜底价，没单独定价的模型走它
- 填完之后，所有**没记金额**的调用按这张表估算，界面上一律带 `≈`；真实金额不会被覆盖
- 缓存读留 0 就按输入价算，不额外折价

### 按用量自动估价

选中供应商后会自动请求它的 `/v1/usage`，把 `model_stats` 里「每个模型用了多少 token、
实际扣了多少钱」折算成一档单价，直接列出来：

```
模型              请求   TOKEN   实际扣款   建议输入 $/M   建议输出 $/M
claude-opus-5-5    29   5.2M    $4.33      0.837          3.347
claude-sonnet-5    11   339.1k  $0.09      0.264          1.056
```

折算方式：只有一个总金额、两个未知量，所以按**输出 ≈ 4 × 输入**求解
`charged = (input + cache_read + cache_write) × p + output × 4p`，
再把 `p` 和 `4p` 填进两档。代回去总额与供应商扣款一致，不是拍脑袋。

- 每行有「填入」，右上角有「全部填入」（一次把这家所有模型都写进价目）
- 在「计价模型」下拉里选中某个模型时，会自动把它的建议价填进两个输入框，不用手敲
- 没有 `/v1/usage` 的供应商（DeepSeek 官方、部分中转）会明确写出来，仍可手动填

## 余额探针

`额度` 页勾上「查实时余额」后，OT 对每个供应商发一次只读查询：

| 供应商类型 | 请求 | 取值 |
|---|---|---|
| 中转站（多数） | `GET {base}/v1/usage` + `Authorization: Bearer <key>` | `remaining` / `balance` / `quota.remaining`，单位取 `unit` |
| DeepSeek 官方 | `GET {origin}/user/balance` | `balance_infos[0].total_balance` |

`base` 结尾已有 `/v1` 就不再重复拼。返回里如果带 `usage.today.actual_cost`，会顺带显示"今日"。

**key 兜底**：同一家配了多把 key 时，自己那把被 401/403 就换另一把再试，
OT 会拿同 origin 下另一把再试一次，成功就标 `（借 … 的 key 查的）`——余额是账户级的，用哪把查不影响结果。

## 和 CC Switch 的关系

OT 现在**不读 CC Switch 的库**，provider 表存在 `%LOCALAPPDATA%\ot\providers.json`，与它无关。
早期做了一次性导入（9 个 provider 已经在表里），所以它可以直接卸载。

**卸载之前**先看 `供应商` 页的横幅：两个应用的「实际生效」都是 `https://…` 直连才安全；
只要有一个还是 `127.0.0.1`，就说明配置还指着某个本地代理，那个进程一停，对应的 CLI 立刻断。

## 数据安全

`providers.json` 里是明文 key，所以任何一次写入前都会先复制一份到
`%LOCALAPPDATA%\ot\backup\providers-<时间戳>.json`；「删除」也会先弹确认。
真删错了，从 backup 目录里挑一个拷回去就行（文件名带时间）。
同一时刻只开一个 OT 实例，避免两个窗口各存一份互相覆盖。

## 从旧版本迁移

以前是两个 exe（`ot.exe` 命令行 + `ot-tray.exe` 托盘）。现在合并成一个 `OT.exe`，
安装脚本会删掉旧的两个，并把 `%LOCALAPPDATA%\ot\bin` 从用户 PATH 里移除。
CLI 的源码还在 `crates/cli`，只作为开发和测试入口，正常使用不需要。

## 开发

```powershell
cargo build --release      # target\release\OT.exe
cargo test                 # 11 个单测
.\install.ps1
```

```
crates/core/   claude.rs Claude 转录解析（sessions.rs / codex.rs 是早期多来源的实现，保留未用）
               source.rs 多来源选择 · usage.rs 聚合 · calls.rs 调用/检索
               providers.rs 供应商表与配置写入 · ccswitch.rs CC Switch 只读导入
               config.rs 模型配置 · alerts.rs 守卫规则 · watch.rs 游标与 tail
crates/tray/   OT 本体：Tauri v2 + 托盘 + 窗口（ui/index.html，无打包器）
crates/cli/    ot 命令行（开发用）
```

不建数据库：转录全量解析约 200 ms；托盘只吃
`(offset, mtime)` 之后的新行，游标在 `state.json`。

环境变量：`OT_TAB=cost|provider|quota|guard` 启动直接开在某一页（截图 / 排查用），
`OT_CLAUDE_DIR` 覆盖转录目录（默认 `~/.claude/projects`）。

## 附录：Claude Code 的彩色状态栏

终端底部那条彩色状态栏不是 Claude Code 原生画的，是 `~/.claude/settings.json` 里的
`statusLine.command` 指向的外部程序渲染的（本机是 `~/.claude/micucodeline/micucodeline.exe`）。

配置：`~/.claude/micucodeline/config.toml`

```toml
[[segments]]
id = "model"              # model / context_window / usage / cost / session / cwd / directory / git / used / balance / branding
enabled = true            # 显示或隐藏
[segments.colors.background]   # 每段三段颜色：background / text / icon，都是 r g b
r = 42
g = 56
b = 110
[segments.icon]
plain = "🤖"
nerd_font = "󰢹"
```

- 段的**顺序**由数组顺序决定，改完下一次刷新即生效，不用重开 claude
- `[style]` 里的 `mode`（nerd_font / plain）和 `separator` 决定字形与分隔符
- `used` / `balance` / `branding`（MICU 那几段）是它自带的，**颜色能改、内容锁定**
- 只影响 Claude Code 的底栏，跟 OT 无关

## 状态栏（ot-statusline）

Claude Code 的底栏由 `~/.claude/settings.json` 的 `statusLine.command` 拉起，OT 自带一个：

```
模型 · 上下文% · 花费 · 目录 · git 分支 · 余额
```

- 源码 [crates/statusline/src/main.rs](crates/statusline/src/main.rs)，读 Claude Code 从 stdin 喂的 JSON
- 余额走 `ot-core` 的 `/v1/usage` 探针，取**当前 claude 供应商**；结果缓存在
  `%LOCALAPPDATA%\ot\statusline-balance.json`，有效期 5 分钟
- 缓存过期时不阻塞：先用旧值，同时后台起一个 `ot-statusline --refresh-balance` 刷新
- 配色是低饱和深绿，段底色从 (26,46,41) 到 (53,100,85) 逐段变亮；改 `BG` 常量即可

想换回别的渲染器（比如 micucodeline）：改 `statusLine.command` 指过去就行，
原来的程序没有删。

## 峰谷定价与币种

价目的每一项都可以分成**高峰 / 空闲**两档，并指定**币种**：

- 峰谷：北京时间周一至周五 9:00-12:00、14:00-18:00 是高峰，其余（含周末）是空闲；
  节假日没有日历数据，按高峰算（宁可估高）
- 币种：每个供应商一个 `currency`（USD / CNY），价目按该币种填；
  人民币估算单独累计到 `cost_cny`，**不和美元混加**，显示成 `$1.20 + ¥8.00`
- Claude Code 自己记的金额永远是美元真值，不会被换算；币种只影响"按你价目估算"的那部分

DeepSeek 官方价（人民币/百万 token，2026-11 起）：

| 模型 | 输入(缓存未命中) | 输入(缓存命中) | 输出 |
|---|---|---|---|
| deepseek-flash | 2.0 / 谷 1.0 | 0.04 / 谷 0.02 | 8.0 / 谷 4.0 |
| deepseek-v4-pro | 9.0 / 谷 4.5 | 0.30 / 谷 0.15 | 27.0 / 谷 13.5 |
