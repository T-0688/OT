//! 会话的可读渲染（终端里看的东西，全部中文）。

use std::fmt::Write as _;

use ot_core::sessions::{Ev, Session};

fn cache_rate(s: &Session) -> f64 {
    let read: u64 = s.usages.iter().map(|u| u.cache_read).sum();
    let input: u64 = s.usages.iter().map(|u| u.input).sum();
    if input + read == 0 {
        0.0
    } else {
        read as f64 / (input + read) as f64
    }
}

fn span(s: &Session) -> String {
    match (s.start, s.end) {
        (Some(a), Some(b)) => {
            let secs = (b - a).num_seconds().max(0);
            if secs >= 86_400 {
                format!("{} 天 {} 小时", secs / 86_400, (secs % 86_400) / 3600)
            } else if secs >= 3600 {
                format!("{} 小时 {:02} 分", secs / 3600, (secs % 3600) / 60)
            } else {
                format!("{} 分钟", secs / 60)
            }
        }
        _ => "-".into(),
    }
}

pub fn session_header(s: &Session, currency: &str) {
    println!("会话    {}  「{}」", s.id, s.title);
    println!("目录    {}", s.cwd);
    println!(
        "项目    {}   来源 {}   agent {}",
        s.project(),
        s.source,
        if s.agent_version.is_empty() { "?" } else { &s.agent_version }
    );
    println!(
        "时间    {} → {}  （{}）",
        s.start.map(ot_core::local_time).unwrap_or_default(),
        s.end.map(ot_core::local_time).unwrap_or_default(),
        span(s)
    );
    println!(
        "统计    {} 轮 · {} 次工具 · {} token · {} · 缓存命中 {:.0}% · 压缩 {} 次",
        s.turns,
        s.tool_count(),
        ot_core::fmt_tokens(s.tokens()),
        ot_core::fmt_money(s.cost(), s.cost_exact(), currency),
        cache_rate(s) * 100.0,
        s.compactions
    );
    if s.fallbacks() > 0 {
        println!("注意    {} 次模型降级 — 用 `ot why {}` 查看", s.fallbacks(), &s.id[..8.min(s.id.len())]);
    }
    println!(
        "文件    {}（{:.1} MB）{}",
        s.path.display(),
        s.size as f64 / 1_048_576.0,
        if s.bad_lines > 0 { format!(" · {} 行损坏", s.bad_lines) } else { String::new() }
    );
}

pub fn markdown(s: &Session) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# {}\n", s.title);
    let _ = writeln!(out, "- 会话：`{}`", s.id);
    let _ = writeln!(out, "- 目录：`{}`", s.cwd);
    let _ = writeln!(out, "- 来源：{}", s.source);
    let _ = writeln!(
        out,
        "- 时间：{} → {}",
        s.start.map(ot_core::local_time).unwrap_or_default(),
        s.end.map(ot_core::local_time).unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "- 统计：{} 轮 · {} 次工具 · {} token · ${:.4}\n",
        s.turns,
        s.tool_count(),
        s.tokens(),
        s.cost()
    );

    let mut turn = 0usize;
    for ev in &s.events {
        match ev {
            Ev::User { ts, text } => {
                turn += 1;
                let _ = write!(out, "\n## 第 {turn} 轮 — {}\n\n", ot_core::local_time(*ts));
                for line in text.lines() {
                    let _ = writeln!(out, "> {line}");
                }
                let _ = writeln!(out);
            }
            Ev::Assistant { text, .. } => {
                let _ = writeln!(out, "{text}\n");
            }
            Ev::Tool { name, target, duration_ms, ok, .. } => {
                let _ = writeln!(
                    out,
                    "- `{name}` {}{} {}",
                    duration_ms.map(ot_core::fmt_dur).unwrap_or_default(),
                    if *ok { "" } else { " **失败**" },
                    target.as_deref().map(|t| format!("`{t}`")).unwrap_or_default()
                );
            }
            Ev::ToolFail { name, text, .. } => {
                let _ = writeln!(out, "- `{name}` 失败：{}", ot_core::truncate(text, 300));
            }
            Ev::Compact { .. } => {
                let _ = writeln!(out, "\n> *上下文已压缩*\n");
            }
            Ev::Exit { reason, .. } => {
                let _ = writeln!(out, "\n> *会话结束（{reason}）*");
            }
            _ => {}
        }
    }
    out
}

pub fn handoff(s: &Session) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# 交接 — {}\n", s.title);
    let _ = writeln!(out, "- 项目：`{}`", s.project());
    let _ = writeln!(out, "- 目录：`{}`", s.cwd);
    let _ = writeln!(out, "- 会话：`{}`（{}）", s.id, s.source);
    let _ = writeln!(
        out,
        "- 时间：{} → {}",
        s.start.map(ot_core::local_time).unwrap_or_default(),
        s.end.map(ot_core::local_time).unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "- 规模：{} 轮 · {} 次工具 · {} token · ${:.4}\n",
        s.turns,
        s.tool_count(),
        s.tokens(),
        s.cost()
    );

    let _ = writeln!(out, "## 最初要做什么");
    for (turn, _, text) in s.prompts.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev() {
        let _ = writeln!(out, "- 第 {turn} 轮：{}", ot_core::truncate(text, 220));
    }

    let _ = writeln!(out, "\n## 现在到哪一步");
    let last_ai = s
        .events
        .iter()
        .rev()
        .find_map(|e| match e {
            Ev::Assistant { text, .. } if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "(没有记录到最终回复)".into());
    let _ = writeln!(out, "{}\n", ot_core::truncate(&last_ai, 900));

    let fails: Vec<_> = s.calls.iter().filter(|c| !c.ok).collect();
    if !fails.is_empty() {
        let _ = writeln!(out, "## 没解决的失败");
        for c in fails.iter().rev().take(5) {
            let _ = writeln!(
                out,
                "- `{}` {} → {}",
                c.name,
                c.target.clone().unwrap_or_default(),
                ot_core::truncate(&c.result_head, 160)
            );
        }
        let _ = writeln!(out);
    }

    let mut targets: Vec<(String, usize)> = Vec::new();
    for c in &s.calls {
        if let Some(t) = &c.target {
            if let Some(slot) = targets.iter_mut().find(|(n, _)| n == t) {
                slot.1 += 1;
            } else {
                targets.push((t.clone(), 1));
            }
        }
    }
    targets.sort_by(|a, b| b.1.cmp(&a.1));
    if !targets.is_empty() {
        let _ = writeln!(out, "## 动过的文件");
        for (t, n) in targets.iter().take(8) {
            let _ = writeln!(out, "- `{t}` ×{n}");
        }
        let _ = writeln!(out);
    }

    let _ = writeln!(out, "## 接着跑");
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "{}", ot_core::resume_command(s));
    let _ = writeln!(out, "```");
    out
}
