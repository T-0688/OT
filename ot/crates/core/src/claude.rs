//! Claude Code transcript adapter.
//!
//! Claude Code keeps one JSONL per session under
//! `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Records we care about:
//!
//!   ai-title              generated session title (last one wins)
//!   user                  `message.content` is a string for a human prompt, or an
//!                         array containing `tool_result` blocks for tool output
//!   assistant             `message.{model,usage,stop_reason,content[]}` with
//!                         `text` / `thinking` / `tool_use` blocks
//!   system                subtype `turn_duration` / `away_summary`
//!   cost-state            cumulative `totalCostUSD` + `modelUsage{model:{…,costUSD}}`
//!
//! Per-call cost is not recorded; we derive a blended $/token per model from
//! `cost-state.modelUsage` and attribute it back to each call (marked ≈).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::records;
use crate::sessions::{CallRec, Ev, ModelChangeRec, ScanOpts, Session, UsageRec};

pub const SOURCE: &str = "claude";

pub fn root() -> PathBuf {
    if let Ok(p) = std::env::var("OT_CLAUDE_DIR") {
        return PathBuf::from(p);
    }
    crate::home().join(".claude").join("projects")
}

/// 所有要读的会话目录：Windows 这份 + WSL 里各发行版的 `~/.claude/projects`。
///
/// WSL 的目录通过 `\\wsl.localhost\<发行版>\home\<用户>\...` 访问；只探测一次，
/// 之后缓存。可以用 `OT_WSL_CLAUDE_DIRS`（分号分隔）手动指定，跳过探测。
pub fn roots() -> Vec<PathBuf> {
    let mut out = vec![root()];
    for extra in wsl_roots() {
        if !out.iter().any(|x| x == &extra) {
            out.push(extra);
        }
    }
    out
}

fn wsl_roots() -> Vec<PathBuf> {
    static CACHE: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            if let Ok(list) = std::env::var("OT_WSL_CLAUDE_DIRS") {
                return list
                    .split(';')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .filter(|p| p.is_dir())
                    .collect();
            }
            let mut roots: Vec<PathBuf> = Vec::new();
            let Ok(out) = std::process::Command::new("wsl.exe").args(["-l", "-q"]).output() else {
                return roots;
            };
            let distros = String::from_utf8_lossy(&out.stdout).replace('\0', "");
            for distro in distros.lines().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let Ok(home_out) = std::process::Command::new("wsl.exe")
                    .args(["-d", distro, "--", "bash", "-lc", "echo $HOME"])
                    .output()
                else {
                    continue;
                };
                let home = String::from_utf8_lossy(&home_out.stdout).trim().to_string();
                if home.is_empty() || !home.starts_with('/') {
                    continue;
                }
                let win_path = format!(
                    r"\\wsl.localhost\{}{}\.claude\projects",
                    distro.trim_end_matches('\0'),
                    home.trim_end_matches('/').replace('/', "\\")
                );
                let p = PathBuf::from(win_path);
                if p.is_dir() {
                    roots.push(p);
                }
            }
            roots
        })
        .clone()
}

pub fn discover(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, 0, 3, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, depth + 1, max_depth, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

#[derive(Default)]
struct CostState {
    total: f64,
    model_cost: BTreeMap<String, f64>,
    model_tokens: BTreeMap<String, u64>,
    seen: bool,
}

struct CallRaw {
    turn: usize,
    ts: DateTime<Utc>,
    id: String,
    name: String,
    target: Option<String>,
    input_preview: String,
}

struct CallEnd {
    ts: DateTime<Utc>,
    text: String,
    is_error: bool,
}

struct UsageRaw {
    turn: usize,
    ts: DateTime<Utc>,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
    stop: String,
}

/// `claude-opus-5[1M]` and `claude-opus-5[1m]` must resolve to the same price bucket.
fn norm_model(m: &str) -> String {
    let lower = m.trim().to_lowercase();
    match lower.split_once('[') {
        Some((head, _)) => head.to_string(),
        None => lower,
    }
}

/// 一行说清这次工具调用在干什么（Claude Code 的 input 里通常带 description/command）。
fn call_intent(input: Option<&Value>) -> String {
    let Some(v) = input else { return String::new() };
    for key in ["description", "command", "file_path", "path", "pattern", "url", "query"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return crate::truncate(s, 120);
            }
        }
    }
    crate::truncate(&v.to_string(), 120)
}

fn tokens_of(usage: &Value) -> (u64, u64, u64, u64) {
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    (
        n("input_tokens"),
        n("output_tokens"),
        n("cache_read_input_tokens"),
        n("cache_creation_input_tokens"),
    )
}

pub fn scan_file(path: &Path, opts: ScanOpts) -> std::io::Result<Session> {
    let text = std::fs::read_to_string(path)?;
    let mut s = Session {
        path: path.to_path_buf(),
        size: text.len() as u64,
        id: path
            .file_stem()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string(),
        source: SOURCE.to_string(),
        ..Default::default()
    };

    let mut cost = CostState::default();
    let mut calls: Vec<CallRaw> = Vec::new();
    let mut ends: HashMap<String, CallEnd> = HashMap::new();
    let mut usages: Vec<UsageRaw> = Vec::new();
    let mut models: Vec<ModelChangeRec> = Vec::new();
    let mut last_model = String::new();
    let mut turns = 0usize;
    let mut seen_prompt = HashMap::new();

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(v) = records::parse(line) else {
            s.bad_lines += 1;
            continue;
        };
        let ts_opt = records::ts(&v);
        let ts = ts_opt.unwrap_or_else(|| s.end.unwrap_or_else(Utc::now));
        if let Some(t) = ts_opt {
            s.end = Some(match s.end {
                Some(prev) if prev > t => prev,
                _ => t,
            });
        }

        match records::kind(&v) {
            "ai-title" => {
                if let Some(t) = records::str_at(&v, &["aiTitle"]) {
                    if !t.is_empty() {
                        s.title = t.to_string();
                    }
                }
            }
            "cost-state" => {
                cost.seen = true;
                cost.total = records::f64_at(&v, &["totalCostUSD"]).unwrap_or(cost.total);
                if let Some(map) = v.get("modelUsage").and_then(Value::as_object) {
                    for (model, u) in map {
                        let c = u.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0);
                        let t = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
                            .iter()
                            .map(|k| u.get(*k).and_then(Value::as_u64).unwrap_or(0))
                            .sum::<u64>();
                        cost.model_cost.insert(model.clone(), c);
                        cost.model_tokens.insert(model.clone(), t);
                    }
                }
            }
            "user" => {
                if s.cwd.is_empty() {
                    if let Some(c) = records::str_at(&v, &["cwd"]) {
                        s.cwd = c.to_string();
                    }
                }
                let Some(message) = v.get("message") else { continue };
                let content = message.get("content");
                // a human prompt: string content (or array of plain text blocks)
                let is_prompt = match content {
                    Some(Value::String(_)) => true,
                    Some(Value::Array(items)) => !items
                        .iter()
                        .any(|i| i.get("type").and_then(Value::as_str) == Some("tool_result")),
                    _ => false,
                };
                if is_prompt {
                    let prompt = records::content_text(message);
                    if prompt.trim().is_empty() {
                        continue;
                    }
                    // resumed sessions replay the same prompt under a new uuid
                    let key = format!("{}|{}", prompt.trim(), ts.timestamp() / 60);
                    if seen_prompt.insert(key, ()).is_some() {
                        continue;
                    }
                    turns += 1;
                    s.prompts.push((turns, ts, crate::truncate(&prompt, 300)));
                    if opts.keep_events {
                        s.events.push(Ev::User { ts, text: crate::truncate(&prompt, 600) });
                    }
                } else if let Some(items) = content.and_then(Value::as_array) {
                    for item in items {
                        if item.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let id = item.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string();
                        let is_error = item.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        let body = match item.get("content") {
                            Some(Value::String(t)) => t.clone(),
                            Some(other) => records::content_text(&Value::Object(
                                [("content".to_string(), other.clone())].into_iter().collect(),
                            )),
                            None => String::new(),
                        };
                        ends.insert(
                            id,
                            CallEnd { ts, text: crate::truncate(&body, 200), is_error },
                        );
                    }
                }
            }
            "assistant" => {
                if s.cwd.is_empty() {
                    if let Some(c) = records::str_at(&v, &["cwd"]) {
                        s.cwd = c.to_string();
                    }
                }
                if s.agent_version.is_empty() {
                    if let Some(ver) = records::str_at(&v, &["version"]) {
                        s.agent_version = format!("claude {ver}");
                    }
                }
                let Some(message) = v.get("message") else { continue };
                let model = records::str_at(message, &["model"]).unwrap_or("").to_string();
                if model != "<synthetic>" && !model.is_empty() && model != last_model {
                    models.push(ModelChangeRec { ts, model: model.clone(), role: "model".into(), fallback: false });
                    last_model = model.clone();
                }

                let blocks = message.get("content").and_then(Value::as_array);
                let mut text_out = String::new();
                if let Some(blocks) = blocks {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = b.get("text").and_then(Value::as_str) {
                                    if !text_out.is_empty() {
                                        text_out.push('\n');
                                    }
                                    text_out.push_str(t);
                                }
                            }
                            Some("tool_use") => {
                                let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                let name = b.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
                                let input = b.get("input");
                                calls.push(CallRaw {
                                    turn: turns.max(1),
                                    ts,
                                    id,
                                    name,
                                    target: records::call_target(input),
                                    input_preview: call_intent(input),
                                });
                            }
                            _ => {}
                        }
                    }
                }
                if opts.keep_events && !text_out.trim().is_empty() {
                    s.events.push(Ev::Assistant { ts, text: crate::truncate(&text_out, opts.text_cap.min(600)) });
                }

                if let Some(usage) = message.get("usage") {
                    let (input, output, cache_read, cache_create) = tokens_of(usage);
                    if input + output + cache_read + cache_create > 0 {
                        usages.push(UsageRaw {
                            turn: turns.max(1),
                            ts,
                            model: if model.is_empty() { "?".into() } else { model.clone() },
                            input,
                            output,
                            cache_read,
                            cache_create,
                            stop: records::str_at(message, &["stop_reason"]).unwrap_or("").to_string(),
                        });
                    }
                }
            }
            "system" => {
                if records::str_at(&v, &["subtype"]) == Some("compact_boundary") {
                    s.compactions += 1;
                    if opts.keep_events {
                        s.events.push(Ev::Compact { ts });
                    }
                }
            }
            _ => {}
        }
    }

    // Blended $/token per model so per-turn numbers add up to the session total.
    // Model names differ in case/suffix between `modelUsage` and the messages
    // (`claude-opus-5[1m]` vs `claude-opus-5[1M]`), so normalize both sides.
    let mut rate: BTreeMap<String, f64> = BTreeMap::new();
    for (model, cost_usd) in &cost.model_cost {
        if let Some(tokens) = cost.model_tokens.get(model) {
            if *tokens > 0 {
                rate.insert(norm_model(model), cost_usd / *tokens as f64);
            }
        }
    }

    let mut attributed: Vec<f64> = usages
        .iter()
        .map(|u| {
            let tokens = u.input + u.output + u.cache_read + u.cache_create;
            let r = rate.get(&norm_model(&u.model)).copied().unwrap_or(0.0);
            tokens as f64 * r
        })
        .collect();

    // Any remainder (unpriced models, naming drift) is spread by token share so the
    // session total still equals `cost-state.totalCostUSD`.
    let total_tokens: u64 = usages
        .iter()
        .map(|u| u.input + u.output + u.cache_read + u.cache_create)
        .sum();
    if cost.seen && cost.total > 0.0 && total_tokens > 0 {
        let sum: f64 = attributed.iter().sum();
        let delta = cost.total - sum;
        if delta.abs() > 1e-9 {
            for (i, u) in usages.iter().enumerate() {
                let tokens = (u.input + u.output + u.cache_read + u.cache_create) as f64;
                attributed[i] += delta * tokens / total_tokens as f64;
            }
        }
    }

    for (i, u) in usages.iter().enumerate() {
        let tokens = u.input + u.output + u.cache_read + u.cache_create;
        let rec = UsageRec {
            ts: u.ts,
            provider: "anthropic".into(),
            model: u.model.clone(),
            purpose: "main".into(),
            api: "claude-code".into(),
            input: u.input,
            output: u.output,
            cache_read: u.cache_read,
            cache_write: u.cache_create,
            total: tokens,
            cost_cny: 0.0,
            cost: attributed[i],
            cost_exact: cost.seen,
            stop_reason: u.stop.clone(),
            turn: u.turn,
            duration_ms: None,
            ttft_ms: None,
            ctx_tokens: u.input + u.cache_read + u.cache_create,
        };
        if opts.keep_events {
            s.events.push(Ev::Usage {
                ts: u.ts,
                model: rec.model.clone(),
                cost: rec.cost,
                tokens: rec.total,
                stop: rec.stop_reason.clone(),
            });
        }
        s.usages.push(rec);
    }

    for c in calls {
        let end = ends.remove(&c.id);
        let (duration_ms, ok, result_head) = match &end {
            Some(e) => (
                Some((e.ts - c.ts).num_milliseconds()),
                !e.is_error,
                e.text.clone(),
            ),
            None => (None, true, String::new()),
        };
        if let Some(e) = &end {
            if !opts.keep_events && e.is_error {
                s.events.push(Ev::ToolFail { ts: e.ts, name: c.name.clone(), text: e.text.clone() });
            }
        }
        s.calls.push(CallRec {
            ts: c.ts,
            name: c.name.clone(),
            intent: c.input_preview.clone(),
            target: c.target.clone(),
            call_id: c.id.clone(),
            ended: end.as_ref().map(|e| e.ts),
            duration_ms,
            ok,
            result_chars: result_head.chars().count(),
            result_head,
            turn: c.turn,
        });
        if opts.keep_events {
            s.events.push(Ev::Tool {
                ts: c.ts,
                name: c.name,
                target: c.target,
                duration_ms,
                ok,
            });
            if let Some(e) = end {
                if e.is_error {
                    s.events.push(Ev::ToolFail { ts: e.ts, name: "tool".into(), text: e.text });
                }
            }
        }
    }

    s.models = models;
    s.turns = turns;
    if s.start.is_none() {
        s.start = s.prompts.first().map(|(_, ts, _)| *ts).or(s.end);
    }
    if s.start.is_none() {
        s.start = s.end;
    }
    if s.title.trim().is_empty() {
        s.title = s
            .prompts
            .first()
            .map(|(_, _, t)| crate::truncate(t, 60))
            .unwrap_or_else(|| s.id.clone());
    }
    if s.cwd.is_empty() {
        s.cwd = "(unknown)".into();
    }

    if opts.keep_events {
        s.events.sort_by_key(event_ts);
    }
    Ok(s)
}

fn event_ts(e: &Ev) -> DateTime<Utc> {
    match e {
        Ev::User { ts, .. }
        | Ev::Assistant { ts, .. }
        | Ev::Tool { ts, .. }
        | Ev::ToolFail { ts, .. }
        | Ev::Usage { ts, .. }
        | Ev::Model { ts, .. }
        | Ev::Compact { ts }
        | Ev::Exit { ts, .. }
        | Ev::Note { ts, .. } => *ts,
    }
}

/// Live guard events for appended lines (no aggregate math, cost is 0 here —
/// the authoritative number only exists in `cost-state`).
pub fn events_from_lines(lines: &[String], text_cap: usize) -> Vec<Ev> {
    let mut out = Vec::new();
    for line in lines {
        let Some(v) = records::parse(line) else { continue };
        let ts = records::ts(&v).unwrap_or_else(Utc::now);
        match records::kind(&v) {
            "user" => {
                let Some(message) = v.get("message") else { continue };
                match message.get("content") {
                    Some(Value::String(_)) => {
                        let text = records::content_text(message);
                        if !text.trim().is_empty() {
                            out.push(Ev::User { ts, text: crate::truncate(&text, 600) });
                        }
                    }
                    Some(Value::Array(items)) => {
                        for item in items {
                            if item.get("type").and_then(Value::as_str) != Some("tool_result") {
                                continue;
                            }
                            let is_error = item.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                            if is_error {
                                out.push(Ev::ToolFail {
                                    ts,
                                    name: "tool".into(),
                                    text: crate::truncate(&item.get("content").map(|c| c.to_string()).unwrap_or_default(), 200),
                                });
                            } else {
                                out.push(Ev::Tool { ts, name: "tool".into(), target: None, duration_ms: None, ok: true });
                            }
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let Some(message) = v.get("message") else { continue };
                let model = records::str_at(message, &["model"]).unwrap_or("").to_string();
                let mut text = String::new();
                if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = b.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(t);
                                }
                            }
                            Some("tool_use") => out.push(Ev::Tool {
                                ts,
                                name: b.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                                target: records::call_target(b.get("input")),
                                duration_ms: None,
                                ok: true,
                            }),
                            _ => {}
                        }
                    }
                }
                if !text.trim().is_empty() {
                    out.push(Ev::Assistant { ts, text: crate::truncate(&text, text_cap) });
                }
                if let Some(usage) = message.get("usage") {
                    let (input, output, cache_read, cache_create) = tokens_of(usage);
                    let total = input + output + cache_read + cache_create;
                    if total > 0 {
                        out.push(Ev::Usage {
                            ts,
                            model: if model.is_empty() { "?".into() } else { model },
                            cost: 0.0,
                            tokens: total,
                            stop: records::str_at(message, &["stop_reason"]).unwrap_or("").to_string(),
                        });
                    }
                }
            }
            "system" => {
                if records::str_at(&v, &["subtype"]) == Some("compact_boundary") {
                    out.push(Ev::Compact { ts });
                }
            }
            _ => {}
        }
    }
    out
}

pub fn load_all(root: &Path, opts: ScanOpts) -> (Vec<Session>, usize) {    let mut sessions = Vec::new();
    let mut bad = 0usize;
    for path in discover(root) {
        match scan_file(&path, opts) {
            Ok(s) => sessions.push(s),
            Err(_) => bad += 1,
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.end));
    (sessions, bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ot-claude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn parses_prompt_tool_call_and_cost() {
        let body = [
            r#"{"type":"ai-title","aiTitle":"整理构建脚本","sessionId":"s1","timestamp":"2026-10-12T05:50:00.000Z"}"#,
            r#"{"type":"user","uuid":"u1","sessionId":"s1","cwd":"D:\\x","timestamp":"2026-10-12T05:50:52.019Z","message":{"role":"user","content":"帮我看看构建脚本"}}"#,
            r#"{"type":"assistant","uuid":"a1","sessionId":"s1","cwd":"D:\\x","version":"2.1.289","timestamp":"2026-10-12T05:51:00.000Z","message":{"role":"assistant","model":"claude-sonnet-5","stop_reason":"tool_use","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"先看 build.sh"},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"build.sh"}}]}}"#,
            r##"{"type":"user","uuid":"u2","sessionId":"s1","timestamp":"2026-10-12T05:51:02.500Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","is_error":false,"content":"#!/bin/sh"}]}}"##,
            r#"{"type":"cost-state","sessionId":"s1","totalCostUSD":0.51,"modelUsage":{"claude-sonnet-5":{"inputTokens":1000,"outputTokens":100,"cacheReadInputTokens":4000,"cacheCreationInputTokens":0,"costUSD":0.51}}}"#,
        ]
        .join("\n");
        let path = write_fixture("s1.jsonl", &body);
        let s = scan_file(&path, ScanOpts::default()).unwrap();

        assert_eq!(s.title, "整理构建脚本");
        assert_eq!(s.turns, 1);
        assert_eq!(s.calls.len(), 1);
        assert_eq!(s.calls[0].name, "Read");
        assert_eq!(s.calls[0].target.as_deref(), Some("build.sh"));
        assert_eq!(s.calls[0].duration_ms, Some(2500));
        assert_eq!(s.usages.len(), 1);
        assert!((s.cost() - 0.51).abs() < 1e-9, "cost {}", s.cost());
        assert_eq!(s.tokens(), 5100);
        assert!(s.cost_exact());
    }

    #[test]
    fn ignores_synthetic_model_and_counts_failed_tools() {
        let body = [
            r#"{"type":"user","uuid":"u1","timestamp":"2026-10-12T05:50:52.019Z","message":{"role":"user","content":"run it"}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-10-12T05:50:53.000Z","message":{"role":"assistant","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"make"}}]}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-10-12T05:50:54.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"make: not found"}]}}"#,
        ]
        .join("\n");
        let path = write_fixture("s2.jsonl", &body);
        let s = scan_file(&path, ScanOpts::default()).unwrap();
        assert_eq!(s.calls.len(), 1);
        assert!(!s.calls[0].ok);
        assert_eq!(s.tool_failures(), 1);
        assert!(s.models.is_empty(), "synthetic model must not appear");
    }
}
