mod fmt;
mod render;

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use ot_core::calls;
use ot_core::ccswitch;
use ot_core::providers;
use ot_core::config;
use ot_core::sessions::{Ev, ScanOpts, Session};
use ot_core::source::{self, Source};
use ot_core::usage;
use ot_core::watch;

#[derive(Parser)]
#[command(
    name = "ot",
    version,
    about = "终端 agent 的旁挂工具：会话、调用、花费、模型",
    long_about = "读 Claude Code / omp 自己写的会话文件，只读。\n默认 --source auto：本机有哪个就用哪个。",
    subcommand_help_heading = "子命令",
    next_help_heading = "选项"
)]
struct Cli {
    /// 读哪个 agent 的会话：auto|omp|claude|codex|all
    #[arg(long, global = true, default_value = "auto")]
    source: String,

    /// 覆盖 omp 转录目录（默认 ~/.omp/agent/sessions）
    #[arg(long, global = true)]
    root: Option<PathBuf>,

    /// 覆盖 Claude Code 转录目录（默认 ~/.claude/projects）
    #[arg(long, global = true)]
    claude_dir: Option<PathBuf>,

    /// 覆盖 Codex CLI 转录目录（默认 ~/.codex/sessions）
    #[arg(long, global = true)]
    codex_dir: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 列出会话（跨项目）
    Ls {
        /// 只看某个项目
        #[arg(long)]
        project: Option<String>,
        /// 只看最近 N 小时/天，例如 12h、7d
        #[arg(long)]
        since: Option<String>,
        #[arg(long, default_value_t = 25)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// 逐轮展开一个会话
    Show {
        /// 会话 id 或唯一前缀
        id: String,
        /// 只看第 N 轮
        #[arg(long)]
        turn: Option<usize>,
    },
    /// 跟随正在跑的会话
    Tail {
        id: String,
        #[arg(long, default_value_t = 700)]
        interval_ms: u64,
    },
    /// 在所有会话里搜文字（--tools 连工具输出一起搜）
    Grep {
        query: String,
        #[arg(long)]
        tools: bool,
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    /// 花费报表
    Cost {
        /// day|project|model|purpose
        #[arg(long, default_value = "day")]
        by: String,
        /// 只看最近 N 天
        #[arg(long)]
        days: Option<i64>,
        #[arg(long)]
        json: bool,
    },
    /// 最贵的轮次、最慢的调用、失败、被反复改的文件
    Top {
        #[arg(long, default_value_t = 8)]
        n: usize,
    },
    /// 为什么在跑这个模型（含静默降级）
    Why { id: Option<String> },
    /// 看/改模型配置
    Model {
        /// 角色=模型，例如 --set smol=deepseek/deepseek-flash
        #[arg(long)]
        set: Option<String>,
        /// 删掉某个角色
        #[arg(long)]
        unset: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 环境自检
    Doctor,
    /// 导出 markdown
    Export {
        id: String,
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// 生成交接简报
    Handoff { id: String },
    /// 看/改守卫阈值
    Guard {
        #[arg(long)]
        set: Option<String>,
        #[arg(long)]
        pause: bool,
        #[arg(long)]
        resume: bool,
        #[arg(long)]
        reset: bool,
    },
    /// 打印恢复该会话的命令
    Open {
        id: String,
        /// 直接在新终端窗口里打开，而不是只打印命令
        #[arg(long)]
        run: bool,
    },
    /// 供应商：列 / 导入 / 切换 / 增删 / 改模型映射
    Provider {
        /// ls（默认）| import | use | add | rm | show | models
        action: Option<String>,
        /// 供应商名字或 id
        name: Option<String>,
        /// claude | codex
        #[arg(long)]
        app: Option<String>,
        #[arg(long)]
        base_url: Option<String>,
        #[arg(long)]
        key: Option<String>,
        /// 角色=模型，可重复：--set sonnet=claude-sonnet-5
        #[arg(long = "set")]
        set: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// 额度与用量（读 CC Switch 的日汇总）
    Quota {
        /// 统计最近 N 天，默认 30
        #[arg(long)]
        days: Option<i64>,
        /// 顺便查 DeepSeek 余额（联网）
        #[arg(long)]
        live: bool,
        #[arg(long)]
        json: bool,
    },
    /// 最近的代理请求，用来看 4xx/5xx
    Requests {
        #[arg(long, default_value_t = 15)]
        limit: usize,
        /// 只看失败
        #[arg(long)]
        failed: bool,
    },
}

struct Ctx {
    source: Source,
}

impl Ctx {
    fn load(&self) -> Result<(Vec<Session>, usize)> {
        let (all, unreadable, roots_used) = source::load(self.source, ScanOpts { keep_events: false, text_cap: 0 });
        if all.is_empty() {
            let where_ = source::roots(self.source)
                .into_iter()
                .map(|(_, p)| p.display().to_string())
                .collect::<Vec<_>>()
                .join("、");
            bail!("没有找到任何会话（已看：{where_}）。检查 --source，或用 --root / --claude-dir 指定目录");
        }
        let _ = roots_used;
        Ok((all, unreadable))
    }

    /// 按 id 找会话。auto 只认自动判定的那个源，所以这里再兜底试一遍全部来源，
    /// 免得 `ot show <codex-id>` 在 claude 源下找不到。
    fn one(&self, id: &str) -> Result<Session> {
        let mut candidates = vec![self.source];
        if self.source != Source::All {
            candidates.push(Source::All);
        }
        if self.source != Source::Codex {
            candidates.push(Source::Codex);
        }
        let mut tried = Vec::new();
        for cand in candidates {
            match source::find(cand, id)? {
                Some(s) => return Ok(s),
                None => tried.push(cand.label()),
            }
        }
        bail!("没有匹配 '{id}' 的会话（找过 {}）", tried.join("、"))
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("ot：{e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Some(root) = &cli.root {
        std::env::set_var("OT_SESSION_DIR", root);
    }
    if let Some(dir) = &cli.claude_dir {
        std::env::set_var("OT_CLAUDE_DIR", dir);
    }
    if let Some(dir) = &cli.codex_dir {
        std::env::set_var("OT_CODEX_DIR", dir);
    }
    let ctx = Ctx { source: source::parse(&cli.source)? };

    match cli.cmd {
        Cmd::Ls { project, since, limit, json } => cmd_ls(&ctx, project, since, limit, json),
        Cmd::Show { id, turn } => cmd_show(&ctx, &id, turn),
        Cmd::Tail { id, interval_ms } => cmd_tail(&ctx, &id, interval_ms),
        Cmd::Grep { query, tools, limit } => cmd_grep(&ctx, &query, tools, limit),
        Cmd::Cost { by, days, json } => cmd_cost(&ctx, &by, days, json),
        Cmd::Top { n } => cmd_top(&ctx, n),
        Cmd::Why { id } => cmd_why(&ctx, id.as_deref()),
        Cmd::Model { set, unset, json } => cmd_model(&ctx, set, unset, json),
        Cmd::Doctor => cmd_doctor(&ctx),
        Cmd::Export { id, out } => cmd_export(&ctx, &id, out),
        Cmd::Handoff { id } => cmd_handoff(&ctx, &id),
        Cmd::Guard { set, pause, resume, reset } => cmd_guard(set, pause, resume, reset),
        Cmd::Open { id, run } => cmd_open(&ctx, &id, run),
        Cmd::Provider { action, name, app, base_url, key, set, json } => {
            cmd_provider(action, name, app, base_url, key, set, json)
        }
        Cmd::Quota { days, live, json } => cmd_quota(days, live, json),
        Cmd::Requests { limit, failed } => cmd_requests(limit, failed),
    }
}

fn cut(sessions: Vec<Session>, since: Option<String>) -> Result<Vec<Session>> {
    let Some(spec) = since else { return Ok(sessions) };
    let hours = match spec.chars().last() {
        Some('h') => spec[..spec.len() - 1].parse::<i64>()?,
        Some('d') => spec[..spec.len() - 1].parse::<i64>()? * 24,
        _ => spec.parse::<i64>()?,
    };
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(hours);
    Ok(sessions
        .into_iter()
        .filter(|s| s.end.map(|e| e >= cutoff).unwrap_or(false))
        .collect())
}

fn cmd_ls(ctx: &Ctx, project: Option<String>, since: Option<String>, limit: usize, json: bool) -> Result<()> {
    let (mut all, _bad) = ctx.load()?;
    all = cut(all, since)?;
    if let Some(p) = &project {
        let p_lc = p.to_lowercase();
        all.retain(|s| s.project().to_lowercase().contains(&p_lc));
    }
    let mixed = {
        let mut kinds: Vec<&str> = all.iter().map(|s| s.source.as_str()).collect();
        kinds.sort();
        kinds.dedup();
        kinds.len() > 1
    };
    all.truncate(limit);

    if json {
        let rows: Vec<_> = all
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "source": s.source,
                    "title": s.title,
                    "cwd": s.cwd,
                    "project": s.project(),
                    "turns": s.turns,
                    "tools": s.tool_count(),
                    "tokens": s.tokens(),
                    "cost": s.cost(),
                    "cost_exact": s.cost_exact(),
                    "model": s.last_model().unwrap_or(""),
                    "fallbacks": s.fallbacks(),
                    "compactions": s.compactions,
                    "last": s.end.map(|e| e.to_rfc3339()),
                    "file": s.path.to_string_lossy(),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }

    let cur = watch::load().settings.currency;
    let mut rows = Vec::new();
    for s in &all {
        let cost = ot_core::fmt_money(s.cost(), s.cost_exact(), &cur);
        let mut row = vec![s.id.chars().take(8).collect::<String>()];
        if mixed {
            row.push(s.source.clone());
        }
        row.extend(vec![
            ot_core::truncate(&s.project(), 16),
            ot_core::rel_time(s.end),
            s.turns.to_string(),
            s.tool_count().to_string(),
            ot_core::fmt_tokens(s.tokens()),
            cost,
            ot_core::truncate(&s.title, 46),
        ]);
        rows.push(row);
    }

    let total_cost: f64 = all.iter().map(|s| s.cost()).sum();
    let total_tokens: u64 = all.iter().map(|s| s.tokens()).sum();
    let total_exact = all.iter().all(|s| s.cost_exact());
    println!(
        "{} 个会话 · {} token · {}",
        all.len(),
        ot_core::fmt_tokens(total_tokens),
        ot_core::fmt_money(total_cost, total_exact, &cur)
    );
    let mut headers = vec!["会话"];
    if mixed {
        headers.push("来源");
    }
    headers.extend(vec!["项目", "最后活动", "轮次", "工具", "TOKEN", "花费", "标题"]);
    fmt::print_table(&headers, &rows);
    Ok(())
}

fn cmd_show(ctx: &Ctx, id: &str, only_turn: Option<usize>) -> Result<()> {
    let s = ctx.one(id)?;
    let cur = watch::load().settings.currency;
    render::session_header(&s, &cur);

    struct TurnView {
        index: usize,
        start: Option<chrono::DateTime<chrono::Utc>>,
        user: String,
        replies: Vec<String>,
        tools: Vec<(String, Option<i64>, bool, Option<String>)>,
        cost: f64,
        tokens: u64,
        compactions: usize,
    }

    let mut turns: Vec<TurnView> = Vec::new();
    for ev in &s.events {
        match ev {
            Ev::User { ts, text } => turns.push(TurnView {
                index: turns.len() + 1,
                start: Some(*ts),
                user: text.clone(),
                replies: Vec::new(),
                tools: Vec::new(),
                cost: 0.0,
                tokens: 0,
                compactions: 0,
            }),
            Ev::Assistant { text, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.replies.push(text.clone());
                }
            }
            Ev::Tool { name, target, duration_ms, ok, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.tools.push((name.clone(), *duration_ms, *ok, target.clone()));
                }
            }
            Ev::Usage { cost, tokens, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.cost += *cost;
                    t.tokens += *tokens;
                }
            }
            Ev::Compact { .. } => {
                if let Some(t) = turns.last_mut() {
                    t.compactions += 1;
                }
            }
            _ => {}
        }
    }

    if turns.is_empty() {
        println!("\n（这份转录里没有用户消息）");
    }

    for t in &turns {
        if let Some(only) = only_turn {
            if only != t.index {
                continue;
            }
        }
        println!(
            "\n── 第 {} 轮 ── {} ── {} 次调用 · {} · {} token",
            t.index,
            t.start.map(ot_core::local_time).unwrap_or_default(),
            t.tools.len(),
            ot_core::fmt_money(t.cost, s.cost_exact(), &cur),
            ot_core::fmt_tokens(t.tokens)
        );
        println!("你    {}", ot_core::truncate(&t.user, 400));
        for r in &t.replies {
            println!("AI    {}", ot_core::truncate(r, 500));
        }
        for (name, dur, ok, target) in &t.tools {
            let dur = dur.map(ot_core::fmt_dur).unwrap_or_else(|| "?".into());
            let mark = if *ok { "ok" } else { "失败" };
            let tgt = target.as_deref().map(|x| ot_core::truncate(x, 70)).unwrap_or_default();
            println!("  · {name:<10} {dur:>7}  {mark:<4} {tgt}");
        }
        if t.compactions > 0 {
            println!("  ~ 上下文压缩 {} 次", t.compactions);
        }
    }

    if let Some(reason) = &s.exit {
        println!("\n  会话结束（{reason}）");
    }
    println!();
    Ok(())
}

fn cmd_tail(ctx: &Ctx, id: &str, interval_ms: u64) -> Result<()> {
    let s = ctx.one(id)?;
    let path = s.path.clone();
    println!("# {}（{}）{}", s.project(), s.source, s.title);
    println!("# 跟随 {}", path.display());

    let mut offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    loop {
        match ot_core::sessions::read_new_lines(&path, &mut offset) {
            Ok(lines) => {
                for ev in source::events_in(&s.source, &lines, 400) {
                    let ts = match &ev {
                        Ev::User { ts, .. }
                        | Ev::Assistant { ts, .. }
                        | Ev::Tool { ts, .. }
                        | Ev::ToolFail { ts, .. }
                        | Ev::Usage { ts, .. }
                        | Ev::Model { ts, .. }
                        | Ev::Compact { ts }
                        | Ev::Exit { ts, .. }
                        | Ev::Note { ts, .. } => *ts,
                    };
                    let stamp = ot_core::local_time(ts);
                    match ev {
                        Ev::User { text, .. } => println!("{stamp} 你   {}", ot_core::truncate(&text, 300)),
                        Ev::Assistant { text, .. } => println!("{stamp} AI   {}", ot_core::truncate(&text, 300)),
                        Ev::Tool { name, duration_ms, ok, .. } => println!(
                            "{stamp} 工具 {name} {} {}",
                            duration_ms.map(ot_core::fmt_dur).unwrap_or_default(),
                            if ok { "ok" } else { "失败" }
                        ),
                        Ev::ToolFail { name, text, .. } => println!("{stamp} 失败 {name} {}", ot_core::truncate(&text, 120)),
                        Ev::Usage { model, cost, tokens, .. } => println!(
                            "{stamp} 调用 {model} {} {} token",
                            ot_core::fmt_cost(cost, "USD"),
                            ot_core::fmt_tokens(tokens)
                        ),
                        Ev::Model { model, role, fallback, .. } => println!(
                            "{stamp} 模型 {role} → {model}{}",
                            if fallback { "（降级）" } else { "" }
                        ),
                        Ev::Compact { .. } => println!("{stamp} 上下文已压缩"),
                        Ev::Exit { reason, .. } => println!("{stamp} 结束 {reason}"),
                        Ev::Note { text, .. } => println!("{stamp} 备注 {}", ot_core::truncate(&text, 120)),
                    }
                }
                let _ = std::io::stdout().flush();
            }
            Err(e) => eprintln!("等待中：{e}"),
        }
        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}

fn cmd_grep(ctx: &Ctx, query: &str, tools: bool, limit: usize) -> Result<()> {
    let mut all = Vec::new();
    for (label, root) in source::roots(ctx.source) {
        if !root.exists() {
            continue;
        }
        for mut hit in calls::grep_root(&root, label, query, tools, limit) {
            hit.source = label.to_string();
            all.push(hit);
            if all.len() >= limit {
                break;
            }
        }
        if all.len() >= limit {
            break;
        }
    }

    if all.is_empty() {
        println!("没搜到「{query}」{}", if tools { "" } else { "（试试 --tools）" });
        return Ok(());
    }
    println!("「{}」命中 {} 处", query, all.len());
    let mut rows = Vec::new();
    for h in all {
        rows.push(vec![
            h.session_id.chars().take(8).collect::<String>(),
            h.source.clone(),
            ot_core::truncate(&h.project, 14),
            h.ts.map(ot_core::local_time).unwrap_or_default(),
            h.role,
            ot_core::truncate(&h.snippet, 90),
        ]);
    }
    fmt::print_table(&["会话", "来源", "项目", "时间", "谁", "命中"], &rows);
    Ok(())
}

fn cmd_cost(ctx: &Ctx, by: &str, days: Option<i64>, json: bool) -> Result<()> {
    let (sessions, _) = ctx.load()?;
    let cur = watch::load().settings.currency;
    let (cost, tokens, call_count, exact) = usage::total(&sessions);
    let cache = usage::cache_stats(&sessions, days);

    let buckets = match by {
        "project" | "项目" => usage::by_project(&sessions, days),
        "model" | "模型" => usage::by_model(&sessions, days),
        "purpose" | "用途" => usage::by_purpose(&sessions, days),
        "day" | "日" => usage::by_day(&sessions, days),
        other => bail!("--by 只能是 day|project|model|purpose（收到 {other}）"),
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "total": cost,
                "tokens": tokens,
                "calls": call_count,
                "exact": exact,
                "cache_hit_rate": cache.hit_rate(),
                "buckets": buckets.iter().map(|b| serde_json::json!({
                    "key": b.key, "cost": b.cost, "tokens": b.tokens, "calls": b.calls, "exact": b.exact
                })).collect::<Vec<_>>(),
            }))?
        );
        return Ok(());
    }

    println!(
        "合计 {}  ·  {} token  ·  {} 次调用{}  ·  缓存命中 {:.0}%",
        ot_core::fmt_money(cost, exact, &cur),
        ot_core::fmt_tokens(tokens),
        call_count,
        if exact { "" } else { "（没有价目表的来源只算 token）" },
        cache.hit_rate() * 100.0
    );
    if let Some(d) = days {
        println!("范围：最近 {d} 天");
    }

    let max = buckets.iter().map(|b| b.cost).fold(0.0f64, f64::max);
    let mut rows = Vec::new();
    for b in &buckets {
        let bar_len = if max > 0.0 { ((b.cost / max) * 24.0).round() as usize } else { 0 };
        rows.push(vec![
            ot_core::truncate(&b.key, 26),
            ot_core::fmt_money(b.cost, b.exact, &cur),
            ot_core::fmt_tokens(b.tokens),
            b.calls.to_string(),
            "▁".repeat(bar_len.max(1)),
        ]);
    }
    let head = match by {
        "project" | "项目" => "项目",
        "model" | "模型" => "模型",
        "purpose" | "用途" => "用途",
        _ => "日期",
    };
    fmt::print_table(&[head, "花费", "TOKEN", "调用", ""], &rows);
    Ok(())
}

fn cmd_top(ctx: &Ctx, n: usize) -> Result<()> {
    let (sessions, _) = ctx.load()?;
    let cur = watch::load().settings.currency;

    println!("最贵的轮次");
    let mut rows = Vec::new();
    for (id, title, turn, cost) in calls::expensive_turns(&sessions, n) {
        rows.push(vec![
            id.chars().take(8).collect::<String>(),
            format!("第 {turn} 轮"),
            ot_core::fmt_cost(cost, &cur),
            ot_core::truncate(&title, 52),
        ]);
    }
    fmt::print_table(&["会话", "轮次", "花费", "标题"], &rows);

    println!("\n最慢的工具调用");
    let mut rows = Vec::new();
    for hit in calls::slowest(&sessions, n) {
        rows.push(vec![
            hit.session_id.chars().take(8).collect::<String>(),
            hit.call.name.clone(),
            hit.call.duration_ms.map(ot_core::fmt_dur).unwrap_or_default(),
            {
                let what = if hit.call.intent.is_empty() {
                    hit.call.target.clone().unwrap_or_default()
                } else {
                    hit.call.intent.clone()
                };
                ot_core::truncate(&what, 60)
            }
        ]);
    }
    fmt::print_table(&["会话", "工具", "耗时", "做什么"], &rows);

    println!("\n最慢的模型调用");
    let mut rows = Vec::new();
    for l in usage::slowest_calls(&sessions, n) {
        rows.push(vec![
            l.session_id.chars().take(8).collect::<String>(),
            ot_core::truncate(&l.model, 28),
            ot_core::fmt_dur(l.duration_ms),
            ot_core::fmt_dur(l.ttft_ms),
            ot_core::fmt_tokens(l.tokens),
            ot_core::fmt_cost(l.cost, &cur),
        ]);
    }
    if rows.is_empty() {
        println!("  （没有记录单次耗时；Claude Code 的转录不存 duration）");
    } else {
        fmt::print_table(&["会话", "模型", "耗时", "首字", "输出", "花费"], &rows);
    }

    println!("\n各模型平均延迟");
    let mut rows = Vec::new();
    for (model, ttft, dur, count) in usage::ttft_by_model(&sessions) {
        rows.push(vec![
            ot_core::truncate(&model, 30),
            ot_core::fmt_dur(ttft as i64),
            ot_core::fmt_dur(dur as i64),
            count.to_string(),
        ]);
    }
    if rows.is_empty() {
        println!("  （没有延迟数据）");
    } else {
        fmt::print_table(&["模型", "平均首字", "平均总耗时", "调用"], &rows);
    }

    println!("\n失败的调用");
    let mut rows = Vec::new();
    for hit in calls::failures(&sessions, n) {
        rows.push(vec![
            hit.session_id.chars().take(8).collect::<String>(),
            hit.call.name.clone(),
            ot_core::truncate(&hit.call.result_head, 72),
            ot_core::rel_time(Some(hit.call.ts)),
        ]);
    }
    if rows.is_empty() {
        println!("  没有");
    } else {
        fmt::print_table(&["会话", "工具", "结果", "时间"], &rows);
    }

    println!("\n被反复改的同一个目标（≥3 次）");
    let mut rows = Vec::new();
    for (target, count) in calls::repeated_targets(&sessions, 3).into_iter().take(n) {
        rows.push(vec![count.to_string(), ot_core::truncate(&target, 86)]);
    }
    if rows.is_empty() {
        println!("  没有");
    } else {
        fmt::print_table(&["次数", "目标"], &rows);
    }
    Ok(())
}

fn cmd_why(ctx: &Ctx, id: Option<&str>) -> Result<()> {
    let models = config::load_models();

    if ctx.source != Source::Claude {
        if let Ok(r) = config::read_roles() {
            println!("omp 配置  {}", r.path.display());
            for role in config::ROLES {
                match r.get(role) {
                    Some(v) => println!("  {role:<8} {v:<34} {}", config::describe(&models, v)),
                    None => println!("  {role:<8} （未设置）"),
                }
            }
        }
    }
    if ctx.source != Source::Omp {
        match config::read_claude() {
            Ok(c) => {
                println!("claude 配置  {}", c.path.display());
                println!(
                    "  default  {}",
                    c.model.clone().unwrap_or_else(|| "（账号默认）".into())
                );
                for alias in config::CLAUDE_ALIASES {
                    match c.env_models.get(alias) {
                        Some(v) => println!("  {alias:<8} → {v}"),
                        None => println!("  {alias:<8} → （未映射）"),
                    }
                }
            }
            Err(e) => println!("claude 配置读取失败：{e:#}"),
        }
    }

    let (sessions, _) = ctx.load()?;
    match id {
        None => {
            let today = chrono::Utc::now() - chrono::Duration::hours(24);
            let mut rows = Vec::new();
            for s in &sessions {
                for m in &s.models {
                    let is_fb = m.fallback || m.role.eq_ignore_ascii_case("fallback");
                    if is_fb && m.ts >= today {
                        rows.push(vec![
                            s.id.chars().take(8).collect::<String>(),
                            s.source.clone(),
                            ot_core::local_time(m.ts),
                            m.role.clone(),
                            m.model.clone(),
                        ]);
                    }
                }
            }
            println!("\n最近 24 小时的模型降级：{} 次", rows.len());
            if !rows.is_empty() {
                fmt::print_table(&["会话", "来源", "时间", "角色", "最终模型"], &rows);
            }
        }
        Some(id) => {
            let s = ctx.one(id)?;
            render::session_header(&s, &watch::load().settings.currency);

            println!("\n模型切换");
            let mut rows = Vec::new();
            for m in &s.models {
                rows.push(vec![
                    ot_core::local_time(m.ts),
                    m.role.clone(),
                    m.model.clone(),
                    if m.fallback || m.role.eq_ignore_ascii_case("fallback") { "降级" } else { "" }.to_string(),
                ]);
            }
            fmt::print_table(&["时间", "角色", "模型", "标记"], &rows);

            println!("\n每轮用的模型与花费");
            let mut rows = Vec::new();
            let mut turn = 0usize;
            let mut per: std::collections::BTreeMap<usize, (std::collections::BTreeMap<String, usize>, f64)> =
                std::collections::BTreeMap::new();
            for ev in &s.events {
                match ev {
                    Ev::User { .. } => turn += 1,
                    Ev::Usage { model, cost, .. } => {
                        let e = per.entry(turn.max(1)).or_default();
                        *e.0.entry(model.clone()).or_default() += 1;
                        e.1 += *cost;
                    }
                    _ => {}
                }
            }
            for (t, (models, cost)) in per {
                let mut list: Vec<String> = models.iter().map(|(m, n)| format!("{m}×{n}")).collect();
                list.truncate(2);
                rows.push(vec![
                    format!("第 {t} 轮"),
                    list.join(", "),
                    ot_core::fmt_cost(cost, &watch::load().settings.currency),
                ]);
            }
            fmt::print_table(&["轮次", "模型", "花费"], &rows);
        }
    }
    Ok(())
}

fn cmd_model(ctx: &Ctx, set: Option<String>, unset: Option<String>, json: bool) -> Result<()> {
    if ctx.source == Source::All {
        bail!("改模型时请指明 --source omp 或 --source claude");
    }

    if ctx.source == Source::Claude {
        let cfg = config::read_claude()?;
        if let Some(spec) = set.or(unset.clone()) {
            let (key, value) = match spec.split_once('=') {
                Some((k, v)) => (k.trim().to_string(), Some(v.trim().to_string())),
                None => (spec.trim().to_string(), None),
            };
            if unset.is_some() && value.is_some() {
                bail!("--unset 只接一个键名（例如 --unset default）");
            }
            let backup = config::set_claude_model_at(&cfg.path, &key, value.as_deref(), Some(cfg.hash))?;
            println!("已写入 settings.json：{key} = {}", value.as_deref().unwrap_or("（删除）"));
            println!("备份：{}", backup.display());
            println!("提示：对下一个 Claude Code 会话生效；正在跑的会话用 /model 切换。");
            return Ok(());
        }

        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "config": cfg.path,
                    "model": cfg.model,
                    "env_models": cfg.env_models,
                }))?
            );
            return Ok(());
        }

        println!("claude 配置  {}", cfg.path.display());
        let mut rows = vec![vec![
            "default".to_string(),
            cfg.model.clone().unwrap_or_else(|| "（账号默认）".into()),
            "settings.json 的 model".into(),
        ]];
        for alias in config::CLAUDE_ALIASES {
            rows.push(vec![
                alias.to_string(),
                cfg.env_models.get(alias).cloned().unwrap_or_else(|| "（未映射）".into()),
                format!("env.ANTHROPIC_DEFAULT_{}_MODEL", alias.to_uppercase()),
            ]);
        }
        fmt::print_table(&["键", "模型", "写在哪"], &rows);
        println!("\n改：ot model --source claude --set default=opus");
        println!("    ot model --source claude --set opus=claude-opus-5[1M]");
        return Ok(());
    }

    if let Some(spec) = set.or(unset.clone()) {
        let (role, value) = match spec.split_once('=') {
            Some((r, v)) => (r.trim().to_string(), Some(v.trim().to_string())),
            None => (spec.trim().to_string(), None),
        };
        if unset.is_some() && value.is_some() {
            bail!("--unset 只接一个角色名（例如 --unset plan）");
        }
        let roles = config::read_roles()?;
        let backup = config::set_role_at(&roles.path, &role, value.as_deref(), Some(roles.hash))?;
        println!("已写入 config.yml：modelRoles.{role} = {}", value.as_deref().unwrap_or("（删除）"));
        println!("备份：{}", backup.display());
        println!("提示：对下一个会话生效；正在跑的会话用 Ctrl+P 切换。");
        return Ok(());
    }

    let roles = config::read_roles()?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "config": roles.path,
                "roles": roles.map,
            }))?
        );
        return Ok(());
    }
    let models = config::load_models();
    println!("omp 配置  {}", roles.path.display());
    let mut rows = Vec::new();
    for role in config::ROLES {
        match roles.get(role) {
            Some(v) => rows.push(vec![role.to_string(), v.to_string(), config::describe(&models, v)]),
            None => rows.push(vec![role.to_string(), "（未设置）".into(), "用 omp 自己的默认".into()]),
        }
    }
    fmt::print_table(&["角色", "值", "解析到"], &rows);
    println!("\n改：ot model --set smol=deepseek/deepseek-flash:high");
    println!("    ot model --unset plan");
    Ok(())
}

fn cmd_doctor(ctx: &Ctx) -> Result<()> {
    let mut problems = 0usize;
    println!("ot {}", env!("CARGO_PKG_VERSION"));
    println!("当前数据源  {}（--source auto 时自动判断）", ctx.source.label());

    for (label, root) in [
        ("claude", ot_core::claude::root()),
        ("omp", ot_core::sessions_root()),
        ("codex", ot_core::codex::root()),
    ] {
        println!("\n{label} 转录  {}", root.display());
        if !root.exists() {
            println!("  目录不存在（这台机器没装/没跑过 {label}）");
            continue;
        }
        let files = source::files_in(label, &root);
        let total: u64 = files.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum();
        println!("  ✓ {} 个转录 · {:.1} MB", files.len(), total as f64 / 1_048_576.0);
        let quick = ScanOpts { keep_events: false, text_cap: 0 };
        let (sessions, bad) = match label {
            "claude" => ot_core::claude::load_all(&root, quick),
            "codex" => ot_core::codex::load_all(&root, quick),
            _ => ot_core::sessions::load_all_from(&root, quick),
        };
        let bad_lines: usize = sessions.iter().map(|s| s.bad_lines).sum();
        println!(
            "  ✓ {} 个会话可解析 · {} 个文件读不了 · {} 行损坏",
            sessions.len(),
            bad,
            bad_lines
        );
        if bad_lines > 0 {
            problems += 1;
        }
        if let Some(latest) = sessions.first() {
            println!(
                "  ✓ 最后活动 {}（{}）",
                ot_core::rel_time(latest.end),
                ot_core::truncate(&latest.title, 40)
            );
        }
    }

    println!("\n模型配置");
    match config::read_roles() {
        Ok(r) => {
            println!("  omp     {}（{} 个角色）", r.path.display(), r.map.len());
            let models = config::load_models();
            for role in config::ROLES {
                if let Some(v) = r.get(role) {
                    if config::resolve(&models, v).is_none() {
                        println!("    · {role} = {v}（models.yml 里没找到，会走 provider 默认）");
                    }
                }
            }
        }
        Err(e) => {
            println!("  omp     ✗ {e:#}");
            problems += 1;
        }
    }
    match config::read_claude() {
        Ok(c) => println!(
            "  claude  {}（default={}）",
            c.path.display(),
            c.model.clone().unwrap_or_else(|| "账号默认".into())
        ),
        Err(e) => {
            println!("  claude  ✗ {e:#}");
            problems += 1;
        }
    }

    println!("\n供应商");
    let store = providers::load();
    if store.profiles.is_empty() {
        println!("  自己的表还是空的（ot provider import 或 add）");
    } else {
        for app in providers::APPS {
            let rec = store.current_for(app).map(|p| p.name.clone()).unwrap_or_else(|| "（未选）".into());
            let live = providers::live_base_url(app);
            let note = if live.is_empty() {
                "（读不到配置）".to_string()
            } else if providers::is_local(&live) {
                format!("{live}  ← 本机代理，代理一停就断")
            } else {
                live
            };
            println!("  {app:<6} 记录 {rec:<12} 实际 {note}");
        }
    }

    let state = watch::load();
    println!("\n状态  {}", ot_core::state_path().display());
    println!(
        "  {} 个游标 · 守卫 {} · 单轮预算 {}",
        state.cursors.len(),
        if state.settings.paused { "暂停" } else { "开启" },
        ot_core::fmt_cost(state.settings.budget_per_turn, &state.settings.currency)
    );

    println!();
    if problems == 0 {
        println!("一切正常");
    } else {
        println!("{problems} 处需要处理");
    }
    Ok(())
}

fn cmd_export(ctx: &Ctx, id: &str, out: Option<PathBuf>) -> Result<()> {
    let s = ctx.one(id)?;
    let md = render::markdown(&s);
    match out {
        Some(path) => {
            std::fs::write(&path, md)?;
            println!("已写入 {}", path.display());
        }
        None => println!("{md}"),
    }
    Ok(())
}

fn cmd_handoff(ctx: &Ctx, id: &str) -> Result<()> {
    let s = ctx.one(id)?;
    print!("{}", render::handoff(&s));
    Ok(())
}

fn cmd_guard(set: Option<String>, pause: bool, resume: bool, reset: bool) -> Result<()> {
    let mut state = watch::load();
    let mut touched = false;

    if let Some(spec) = set {
        for pair in spec.split(',') {
            let (k, v) = pair.split_once('=').with_context(|| format!("--set 要写成 key=value（收到 {pair}）"))?;
            let k = k.trim();
            let v = v.trim();
            match k {
                "budget" | "budget_per_turn" => state.settings.budget_per_turn = v.parse()?,
                "cache" | "cache_hit_min" => state.settings.cache_hit_min = v.parse()?,
                "failures" | "max_failures" => state.settings.max_failures = v.parse()?,
                "context" | "context_pct" => state.settings.context_pct = v.parse()?,
                "currency" => state.settings.currency = v.to_uppercase(),
                "notify_turn_end" => state.settings.notify_turn_end = v == "1" || v == "true",
                "notify_finish" => state.settings.notify_finish = v == "1" || v == "true",
                other => bail!("未知键 '{other}'"),
            }
            touched = true;
        }
    }
    if pause {
        state.settings.paused = true;
        touched = true;
    }
    if resume {
        state.settings.paused = false;
        touched = true;
    }
    if reset {
        watch::rewind(&mut state);
        touched = true;
    }
    if touched {
        watch::save(&state)?;
    }

    let s = &state.settings;
    println!("守卫      {}", if s.paused { "暂停" } else { "开启" });
    println!("币种      {}", s.currency);
    println!("单轮预算  {} ", ot_core::fmt_cost(s.budget_per_turn, &s.currency));
    println!("缓存下限  {:.0}%", s.cache_hit_min * 100.0);
    println!("连败阈值  {}", s.max_failures);
    println!("上下文    {:.0}% 窗口", s.context_pct * 100.0);
    println!("通知      轮末={} 结束={}", s.notify_turn_end, s.notify_finish);
    println!("游标      {} 个文件", state.cursors.len());
    Ok(())
}

// ---------------------------------------------------------------- CC Switch

fn cc_guard() -> Result<()> {
    if !ccswitch::available() {
        bail!(
            "没找到 CC Switch 的数据库（{}）。装过 CC Switch 并跑过一次才会有。",
            ccswitch::db_path().display()
        );
    }
    Ok(())
}

/// 同名 provider 可能在 claude 和 codex 下各有一份，这时必须用 --app 指明。
fn pick_profile(store: &providers::Store, target: &str, app: Option<&str>) -> Result<providers::Profile> {
    let key = target.to_lowercase();
    let mut hits: Vec<&providers::Profile> = store
        .profiles
        .iter()
        .filter(|p| app.map(|a| p.app.eq_ignore_ascii_case(a)).unwrap_or(true))
        .filter(|p| p.id.eq_ignore_ascii_case(target) || p.name.to_lowercase() == key)
        .collect();
    if hits.is_empty() {
        hits = store
            .profiles
            .iter()
            .filter(|p| app.map(|a| p.app.eq_ignore_ascii_case(a)).unwrap_or(true))
            .filter(|p| p.name.to_lowercase().contains(&key))
            .collect();
    }
    match hits.len() {
        0 => bail!("没找到供应商 '{target}'"),
        1 => Ok(hits[0].clone()),
        _ => {
            let names: Vec<String> = hits.iter().map(|p| format!("{}/{}", p.app, p.name)).collect();
            bail!("'{target}' 有多个匹配：{}\n用 --app claude 或 --app codex 指明", names.join("、"))
        }
    }
}
fn cmd_provider(
    action: Option<String>,
    name: Option<String>,
    app: Option<String>,
    base_url: Option<String>,
    key: Option<String>,
    set: Vec<String>,
    json: bool,
) -> Result<()> {
    let action = action.unwrap_or_else(|| "ls".to_string());
    let mut store = providers::load();

    match action.as_str() {
        "import" => {
            let n = providers::import_from_ccswitch()?;
            println!("从 CC Switch 导入 {n} 个供应商 → {}", providers::store_path().display());
            println!("提示：导入的是快照，之后 CC Switch 里的改动不会再同步。");
        }
        "add" => {
            let pname = name.context("用法：ot provider add <名字> --app claude --base-url … --key …")?;
            let papp = app.clone().context("--app 必填（claude 或 codex）")?;
            if !providers::APPS.contains(&papp.as_str()) {
                bail!("--app 只支持 claude / codex");
            }
            let url = base_url.clone().context("--base-url 必填")?;
            let pkey = key.clone().unwrap_or_default();
            let mut p = providers::Profile {
                id: providers::new_id(&papp, &pname),
                app: papp.clone(),
                name: pname.clone(),
                base_url: url,
                api_key: pkey,
                ..Default::default()
            };
            for pair in &set {
                let (role, model) = pair
                    .split_once('=')
                    .with_context(|| format!("--set 要写成 role=model（收到 {pair}）"))?;
                p.models.insert(role.trim().to_string(), model.trim().to_string());
            }
            store.profiles.retain(|x| !(x.app == papp && x.name == pname));
            store.profiles.push(p);
            providers::save(&store)?;
            println!("已添加 {papp}/{pname}（用 `ot provider use {pname}` 生效）");
        }
        "rm" => {
            let target = name.context("用法：ot provider rm <名字>")?;
            let before = store.profiles.len();
            let mut removed = Vec::new();
            store.profiles.retain(|p| {
                let hit = p.name == target || p.id == target;
                if hit {
                    removed.push(format!("{}/{}", p.app, p.name));
                }
                !hit
            });
            if store.profiles.len() == before {
                bail!("没找到供应商 '{target}'");
            }
            for (app, id) in store.current.clone() {
                if !store.profiles.iter().any(|p| p.id == id) {
                    store.current.remove(&app);
                }
            }
            providers::save(&store)?;
            println!("已删除 {}", removed.join(", "));
        }
        "use" => {
            let target = name.context("用法：ot provider use <名字>")?;
            let profile = pick_profile(&store, &target, app.as_deref())?;
            let backups = providers::apply(&profile)?;
            store.current.insert(profile.app.clone(), profile.id.clone());
            providers::save(&store)?;
            println!(
                "已切到 {} / {}  →  {}",
                profile.app,
                profile.name,
                match profile.app.as_str() {
                    "claude" => providers::claude_settings_path().display().to_string(),
                    _ => providers::codex_dir().join("config.toml").display().to_string(),
                }
            );
            if providers::is_local(&profile.base_url) {
                println!("注意：地址是本机 {}，需要那个代理活着才有用。", profile.base_url);
            }
            for b in backups {
                println!("备份 {}", b.display());
            }
            println!("提示：agent 正在跑的会话要重开才会读到新配置。");
        }
        "models" => {
            let target = name.context("用法：ot provider models <名字> [--set role=model]")?;
            let mut profile = pick_profile(&store, &target, app.as_deref())?;
            if !set.is_empty() {
                for pair in &set {
                    let (role, model) = pair
                        .split_once('=')
                        .with_context(|| format!("--set 要写成 role=model（收到 {pair}）"))?;
                    let role = role.trim().to_string();
                    if !providers::ROLES.contains(&role.as_str()) {
                        bail!("角色只能是 {}", providers::ROLES.join(" / "));
                    }
                    profile.models.insert(role, model.trim().to_string());
                }
                if let Some(slot) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
                    *slot = profile.clone();
                }
                providers::save(&store)?;
                // 如果它正是当前在用的，立刻重新下发
                if store.current.get(&profile.app) == Some(&profile.id) {
                    providers::apply(&profile)?;
                    println!("已写回，{} 的配置已更新", profile.app);
                }
            }
            let mut rows = Vec::new();
            for role in providers::ROLES {
                rows.push(vec![
                    role.to_string(),
                    profile.models.get(role).cloned().unwrap_or_else(|| "（未设）".into()),
                ]);
            }
            fmt::print_table(&["角色", "模型"], &rows);
            println!("改：ot provider models {} --set sonnet=claude-sonnet-5", profile.name);
        }
        "ls" | "list" => {
            let mut list: Vec<providers::Profile> = store.profiles.clone();
            if let Some(a) = &app {
                list.retain(|p| p.app.eq_ignore_ascii_case(a));
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
                return Ok(());
            }
            if list.is_empty() {
                println!("还没有供应商。先 `ot provider import`（从 CC Switch 搬）或 `ot provider add`。");
                return Ok(());
            }
            list.sort_by(|a, b| a.app.cmp(&b.app).then(a.name.cmp(&b.name)));
            let mut rows = Vec::new();
            for p in &list {
                let is_cur = store.current.get(&p.app) == Some(&p.id);
                rows.push(vec![
                    p.app.clone(),
                    ot_core::truncate(&p.name, 18),
                    if is_cur { "✓" } else { "" }.to_string(),
                    ot_core::truncate(&pretty_host(&p.base_url), 28),
                    ot_core::truncate(p.models.get("default").map(|s| s.as_str()).unwrap_or("-"), 22),
                    providers::mask(&p.api_key),
                ]);
            }
            fmt::print_table(&["应用", "供应商", "当前", "地址", "默认模型", "Key"], &rows);

            println!();
            for app in providers::APPS {
                let live = providers::live_base_url(app);
                let cur = store.current_for(app).map(|p| p.name.clone()).unwrap_or_else(|| "（未设置）".into());
                let warn = if providers::is_local(&live) && !live.is_empty() {
                    "  ← 现在指向本机代理，卸载那个代理就会断"
                } else {
                    ""
                };
                println!("{app:<6} 记录里选中：{cur:<12} 实际生效：{}{warn}", if live.is_empty() { "（读不到）" } else { &live });
            }
        }
        "show" => {
            let target = name.context("用法：ot provider show <名字>")?;
            let p = &pick_profile(&store, &target, app.as_deref())?;
            println!("{} / {}", p.app, p.name);
            println!("  id       {}", p.id);
            println!("  base_url {}", p.base_url);
            println!("  key      {}", providers::mask(&p.api_key));
            for (role, model) in &p.models {
                println!("  {role:<8} {model}");
            }
            let live = providers::live_base_url(&p.app);
            println!("  实际生效 {}", if live.is_empty() { "（读不到）" } else { &live });
        }
        other => bail!("不认识的动作 '{other}'（ls|import|use|add|rm|show|models）"),
    }
    Ok(())
}

fn pretty_host(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    rest.trim_end_matches('/').to_string()
}

fn cmd_quota(days: Option<i64>, live: bool, json: bool) -> Result<()> {
    let days = days.unwrap_or(30);
    // CC Switch 卸载后就没有它的库了：这时退回到「自己的 provider 表 + 转录统计」。
    if !ccswitch::available() {
        let store = providers::load();
        let (sessions, _) = Ctx { source: Source::All }.load().unwrap_or_default();
        let (cost, tokens, calls, _) = usage::total(&sessions);
        println!(
            "CC Switch 数据库不在了，用量改从转录统计：近 {} 天约 {} · {} token · {} 次调用",
            days,
            ot_core::fmt_money(cost, false, "USD"),
            ot_core::fmt_tokens(tokens),
            calls
        );
        if store.profiles.is_empty() {
            println!("也还没有自己的供应商表（ot provider import / add）。");
            return Ok(());
        }
        let mut rows = Vec::new();
        for p in &store.profiles {
            let cur = store.current.get(&p.app) == Some(&p.id);
            rows.push(vec![
                p.app.clone(),
                ot_core::truncate(&p.name, 18),
                if cur { "✓" } else { "" }.to_string(),
                ot_core::truncate(&pretty_host(&p.base_url), 28),
                p.limit_daily.map(|l| ot_core::fmt_cost(l, "USD")).unwrap_or_else(|| "未设".into()),
                p.limit_monthly.map(|l| ot_core::fmt_cost(l, "USD")).unwrap_or_else(|| "未设".into()),
            ]);
        }
        fmt::print_table(&["应用", "供应商", "当前", "地址", "日限额", "月限额"], &rows);
        return Ok(());
    }
    let mut providers = ccswitch::providers()?;
    let spend = ccswitch::spend_by_provider()?;
    let daily = ccswitch::daily(days)?;
    providers.sort_by(|a, b| {
        let sa = spend.get(&(a.app.clone(), a.id.clone())).map(|s| s.month).unwrap_or(0.0);
        let sb = spend.get(&(b.app.clone(), b.id.clone())).map(|s| s.month).unwrap_or(0.0);
        b.current.cmp(&a.current).then(sb.total_cmp(&sa)).then(a.app.cmp(&b.app))
    });
    let (req_total, req_fail) = ccswitch::today_request_stats().unwrap_or((0, 0));

    let total_today: f64 = spend.values().map(|s| s.today).sum();
    let total_month: f64 = spend.values().map(|s| s.month).sum();
    let total_days: f64 = daily.iter().map(|d| d.cost).sum();

    // 有余额接口的就查一下（目前只有 DeepSeek 有公开的 /user/balance）
    let mut balances: std::collections::HashMap<(String, String), String> = Default::default();
    if live {
        let raws = ccswitch::raw_configs().unwrap_or_default();
        for p in &providers {
            if !p.base_url.to_lowercase().contains("deepseek") {
                continue;
            }
            let key = raws
                .get(&(p.app.clone(), p.id.clone()))
                .map(|r| ccswitch::provider_key(r))
                .unwrap_or_default();
            let text = match ccswitch::deepseek_balance(&p.base_url, &key) {
                Ok((amount, cur)) => format!("{} {amount:.2}", if cur == "CNY" { "￥" } else { "$" }),
                Err(e) => format!("查询失败（{e}）"),
            };
            balances.insert((p.app.clone(), p.id.clone()), text);
        }
    }

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "days": days,
                "today_usd": total_today,
                "month_usd": total_month,
                "window_usd": total_days,
                "requests_today": req_total,
                "failed_today": req_fail,
                "providers": providers.iter().map(|p| {
                    let s = spend.get(&(p.app.clone(), p.id.clone()));
                    serde_json::json!({
                        "app": p.app, "name": p.name, "current": p.current,
                        "today_usd": s.map(|x| x.today).unwrap_or(0.0),
                        "month_usd": s.map(|x| x.month).unwrap_or(0.0),
                        "limit_daily_usd": p.limit_daily,
                        "limit_monthly_usd": p.limit_monthly,
                        "balance": balances.get(&(p.app.clone(), p.id.clone())),
                    })
                }).collect::<Vec<_>>(),
            }))?
        );
        return Ok(());
    }

    println!(
        "今日 {}  ·  本月 {}  ·  近 {} 天 {}",
        ot_core::fmt_cost(total_today, "USD"),
        ot_core::fmt_cost(total_month, "USD"),
        days,
        ot_core::fmt_cost(total_days, "USD")
    );
    println!(
        "今日请求 {} 次，失败 {} 次{}",
        req_total,
        req_fail,
        if req_total > 0 && req_fail * 2 >= req_total {
            "  ← 失败率偏高，看 `ot requests --failed`"
        } else {
            ""
        }
    );

    let fmt_left = |spent: f64, limit: Option<f64>| match limit {
        Some(l) => {
            let left = (l - spent).max(0.0);
            format!("{} / {}", ot_core::fmt_cost(left, "USD"), ot_core::fmt_cost(l, "USD"))
        }
        None => "未设限额".to_string(),
    };

    let mut rows = Vec::new();
    for p in &providers {
        let s = spend.get(&(p.app.clone(), p.id.clone())).cloned().unwrap_or_default();
        let mut row = vec![
            p.app.clone(),
            ot_core::truncate(&p.name, 18),
            if p.current { "✓" } else { "" }.to_string(),
            ot_core::fmt_cost(s.today, "USD"),
            fmt_left(s.today, p.limit_daily),
            ot_core::fmt_cost(s.month, "USD"),
            fmt_left(s.month, p.limit_monthly),
        ];
        if live {
            row.push(
                balances
                    .get(&(p.app.clone(), p.id.clone()))
                    .cloned()
                    .unwrap_or_else(|| "-".into()),
            );
        }
        rows.push(row);
    }
    let mut head = vec!["应用", "供应商", "当前", "今日", "今日剩余/限额", "本月", "本月剩余/限额"];
    if live {
        head.push("余额");
    }
    fmt::print_table(&head, &rows);

    let mut by_model: std::collections::BTreeMap<String, (f64, u64)> = Default::default();
    for d in &daily {
        let e = by_model.entry(d.model.clone()).or_default();
        e.0 += d.cost;
        e.1 += d.requests;
    }
    let mut models: Vec<_> = by_model.into_iter().filter(|(_, v)| v.0 > 0.0).collect();
    models.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0));
    if !models.is_empty() {
        println!("\n近 {days} 天按模型");
        let mut rows = Vec::new();
        for (model, (cost, n)) in models.into_iter().take(10) {
            rows.push(vec![
                ot_core::truncate(&model, 30),
                ot_core::fmt_cost(cost, "USD"),
                n.to_string(),
            ]);
        }
        fmt::print_table(&["模型", "花费", "请求"], &rows);
    }
    Ok(())
}

fn cmd_requests(limit: usize, failed_only: bool) -> Result<()> {
    cc_guard()?;
    let names: std::collections::HashMap<String, String> = ccswitch::providers()
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id, p.name))
        .collect();
    let mut rows_data = ccswitch::recent_requests(limit * 4)?;
    if failed_only {
        rows_data.retain(|r| r.status >= 400);
    }
    rows_data.truncate(limit);
    if rows_data.is_empty() {
        println!("没有匹配的请求记录");
        return Ok(());
    }
    let mut rows = Vec::new();
    for r in &rows_data {
        let ts = chrono::DateTime::from_timestamp(r.ts, 0)
            .map(|d| d.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();
        rows.push(vec![
            ts,
            r.app.clone(),
            ot_core::truncate(&r.model, 24),
            r.status.to_string(),
            format!("{}ms", r.latency_ms),
            ot_core::fmt_cost(r.cost, "USD"),
            ot_core::truncate(names.get(&r.provider_id).map(|s| s.as_str()).unwrap_or(&r.provider_id), 16),
        ]);
    }
    fmt::print_table(&["时间", "应用", "模型", "状态", "延迟", "花费", "供应商"], &rows);
    Ok(())
}

fn cmd_open(ctx: &Ctx, id: &str, run: bool) -> Result<()> {
    let s = ctx.one(id)?;
    if run {
        let (dir, substituted) = ot_core::spawn_resume(&s).context("打开终端失败")?;
        println!("已在新窗口里恢复 {}", &s.id[..8.min(s.id.len())]);
        if substituted {
            println!("注意：原目录已不存在，改在 {} 打开", dir.display());
        }
    } else {
        println!("{}", ot_core::resume_command(&s));
    }
    Ok(())
}
