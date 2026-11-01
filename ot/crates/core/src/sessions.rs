//! Transcript scanning: turn a `*.jsonl` file into a `Session` view.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::records;

#[derive(Debug, Clone)]
pub struct UsageRec {
    pub ts: DateTime<Utc>,
    pub provider: String,
    pub model: String,
    pub purpose: String,
    pub api: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    pub cost: f64,
    /// 人民币金额（价目按 CNY 填的供应商）；和 `cost` 分开累计，绝不混加
    pub cost_cny: f64,
    pub cost_exact: bool,
    pub stop_reason: String,
    pub turn: usize,
    /// Wall-clock ms for the model call (assistant messages only).
    pub duration_ms: Option<i64>,
    /// Time to first token in ms (assistant messages only).
    pub ttft_ms: Option<i64>,
    /// Prompt tokens actually sent (contextSnapshot.promptTokens when present).
    pub ctx_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct CallRec {
    pub ts: DateTime<Utc>,
    pub name: String,
    pub intent: String,
    pub target: Option<String>,
    pub call_id: String,
    pub ended: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    pub ok: bool,
    pub result_chars: usize,
    pub result_head: String,
    pub turn: usize,
}

#[derive(Debug, Clone)]
pub struct ModelChangeRec {
    pub ts: DateTime<Utc>,
    pub model: String,
    pub role: String,
    pub fallback: bool,
}

#[derive(Debug, Clone)]
pub enum Ev {
    User { ts: DateTime<Utc>, text: String },
    Assistant { ts: DateTime<Utc>, text: String },
    Tool { ts: DateTime<Utc>, name: String, target: Option<String>, duration_ms: Option<i64>, ok: bool },
    ToolFail { ts: DateTime<Utc>, name: String, text: String },
    Usage { ts: DateTime<Utc>, model: String, cost: f64, tokens: u64, stop: String },
    Model { ts: DateTime<Utc>, model: String, role: String, fallback: bool },
    Compact { ts: DateTime<Utc> },
    Exit { ts: DateTime<Utc>, reason: String },
    Note { ts: DateTime<Utc>, text: String },
}

#[derive(Debug, Clone, Default)]
pub struct Session {
    pub path: PathBuf,
    /// which transcript format this came from: "omp" or "claude"
    pub source: String,
    pub size: u64,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub agent_version: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    pub turns: usize,
    /// 汇总模式下不重建完整调用，只记个数（Codex 转录太大）
    pub tool_count_hint: usize,
    pub usages: Vec<UsageRec>,
    pub calls: Vec<CallRec>,
    pub models: Vec<ModelChangeRec>,
    pub compactions: usize,
    pub exit: Option<String>,
    pub bad_lines: usize,
    pub events: Vec<Ev>,
    pub prompts: Vec<(usize, DateTime<Utc>, String)>,
}

impl Session {
    pub fn project(&self) -> String {
        let cwd = self.cwd.trim_end_matches(['\\', '/']);
        let last = cwd.rsplit(['\\', '/']).next().unwrap_or(cwd);
        if last.is_empty() {
            cwd.to_string()
        } else {
            last.to_string()
        }
    }

    pub fn tokens(&self) -> u64 {
        self.usages.iter().map(|u| u.total).sum()
    }

    pub fn cost(&self) -> f64 {
        self.usages.iter().map(|u| u.cost).sum()
    }

    /// 人民币金额（价目按 CNY 填的供应商）
    pub fn cost_cny(&self) -> f64 {
        self.usages.iter().map(|u| u.cost_cny).sum()
    }

    /// 没有调用记录时不算“精确 0 元”，这样界面显示 — 而不是 $0.0000。
    pub fn cost_exact(&self) -> bool {
        !self.usages.is_empty() && self.usages.iter().all(|u| u.cost_exact)
    }

    pub fn fallbacks(&self) -> usize {
        // omp marks a fallback either with `role: "fallback"` or the
        // `resolvedModelIsFallback` flag, depending on the runtime version.
        self.models
            .iter()
            .filter(|m| m.fallback || m.role.eq_ignore_ascii_case("fallback"))
            .count()
    }

    pub fn tool_failures(&self) -> usize {
        self.calls.iter().filter(|c| !c.ok).count()
    }

    /// 工具调用次数：详情模式下是真实条数，汇总模式下是数出来的。
    pub fn tool_count(&self) -> usize {
        if self.calls.is_empty() {
            self.tool_count_hint
        } else {
            self.calls.len()
        }
    }

    pub fn last_model(&self) -> Option<&str> {
        self.models.last().map(|m| m.model.as_str())
    }

    pub fn context_peak(&self) -> u64 {
        self.usages
            .iter()
            .map(|u| u.ctx_tokens.max(u.input + u.cache_read + u.cache_write))
            .max()
            .unwrap_or(0)
    }

    /// Cost grouped by turn (1-based turn index).
    pub fn turn_costs(&self) -> Vec<(usize, f64)> {
        let mut out: Vec<(usize, f64)> = Vec::new();
        for u in &self.usages {
            let turn = u.turn.max(1);
            match out.last_mut() {
                Some((t, c)) if *t == turn => *c += u.cost,
                _ => out.push((turn, u.cost)),
            }
        }
        out
    }

    pub fn summary_line(&self) -> String {
        format!(
            "{} turns · {} tools · {} tok · ${:.4}{}",
            self.turns,
            self.calls.len(),
            self.tokens(),
            self.cost(),
            if self.cost_exact() { "" } else { "~" }
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ScanOpts {
    pub keep_events: bool,
    pub text_cap: usize,
}

impl Default for ScanOpts {
    fn default() -> Self {
        Self { keep_events: true, text_cap: 4_000 }
    }
}

fn id_from_filename(path: &Path) -> String {
    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    match name.rsplit_once('_') {
        Some((_, id)) if !id.is_empty() => id.to_string(),
        _ => name.to_string(),
    }
}

pub fn scan_file(path: &Path, opts: ScanOpts) -> std::io::Result<Session> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    let mut s = Session {
        path: path.to_path_buf(),
        size,
        source: "omp".into(),
        id: id_from_filename(path),
        ..Default::default()
    };

    let mut pending: HashMap<String, usize> = HashMap::new();
    let mut turns = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                s.bad_lines += 1;
                continue;
            }
        };
        let Some(v) = records::parse(&line) else {
            if !line.trim().is_empty() {
                s.bad_lines += 1;
            }
            continue;
        };
        let ts_opt = records::ts(&v);
        let ts = ts_opt.unwrap_or_else(|| s.end.unwrap_or_else(Utc::now));

        match records::kind(&v) {
            "title" | "title_change" => {
                if let Some(t) = records::str_at(&v, &["title"]) {
                    if !t.is_empty() {
                        s.title = t.to_string();
                    }
                }
            }
            "session" => {
                if let Some(id) = records::str_at(&v, &["id"]) {
                    if id.len() >= 8 {
                        s.id = id.to_string();
                    }
                }
                if let Some(cwd) = records::str_at(&v, &["cwd"]) {
                    s.cwd = cwd.to_string();
                }
                s.start = Some(ts);
                if s.agent_version.is_empty() {
                    s.agent_version = records::str_at(&v, &["runtime", "version"]).unwrap_or("").into();
                }
            }
            "model_change" => {
                let model = records::str_at(&v, &["model"]).unwrap_or("?").to_string();
                let role = records::str_at(&v, &["role"]).unwrap_or("default").to_string();
                let fallback = records::bool_at(&v, &["resolvedModelIsFallback"]);
                if s.agent_version.is_empty() {
                    s.agent_version = records::str_at(&v, &["runtime", "version"]).unwrap_or("").into();
                }
                s.models.push(ModelChangeRec { ts, model, role, fallback });
                if opts.keep_events {
                    s.events.push(Ev::Model {
                        ts,
                        model: records::str_at(&v, &["model"]).unwrap_or("?").to_string(),
                        role: records::str_at(&v, &["role"]).unwrap_or("default").to_string(),
                        fallback,
                    });
                }
            }
            "message" => {
                let Some(message) = v.get("message") else { continue };
                let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                match role {
                    "user" => {
                        turns += 1;
                        let text = records::content_text(message);
                        if !text.is_empty() {
                            s.prompts.push((turns, ts, crate::truncate(&text, 300)));
                        }
                        if opts.keep_events {
                            s.events.push(Ev::User { ts, text: crate::truncate(&text, 600) });
                        }
                    }
                    "assistant" => {
                        let text = records::content_text(message);
                        for tc in records::tool_calls(message) {
                            let idx = s.calls.len();
                            s.calls.push(CallRec {
                                ts,
                                name: tc.name.to_string(),
                                intent: String::new(),
                                target: records::call_target(tc.arguments),
                                call_id: tc.id.to_string(),
                                ended: None,
                                duration_ms: None,
                                ok: true,
                                result_chars: 0,
                                result_head: String::new(),
                                turn: turns.max(1),
                            });
                            if !tc.id.is_empty() {
                                pending.insert(tc.id.to_string(), idx);
                            }
                        }
                        if opts.keep_events && !text.trim().is_empty() {
                            s.events.push(Ev::Assistant {
                                ts,
                                text: crate::truncate(&text, opts.text_cap.min(600)),
                            });
                        }
                        // Per-call accounting lives on the assistant message itself:
                        // usage{input,output,cacheRead,cacheWrite,totalTokens,cost{...}},
                        // plus duration / ttft / contextSnapshot.promptTokens.
                        if let Some(usage) = message.get("usage") {
                            let num = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                            let cost = usage
                                .get("cost")
                                .and_then(|c| c.get("total"))
                                .and_then(Value::as_f64);
                            let rec = UsageRec {
                                ts,
                                provider: records::str_at(message, &["provider"]).unwrap_or("").to_string(),
                                model: records::str_at(message, &["model"]).unwrap_or("?").to_string(),
                                purpose: "main".into(),
                                api: records::str_at(message, &["api"]).unwrap_or("").to_string(),
                                input: num("input"),
                                output: num("output"),
                                cache_read: num("cacheRead"),
                                cache_write: num("cacheWrite"),
                                total: num("totalTokens"),
                                cost_cny: 0.0,
                                cost: cost.unwrap_or(0.0),
                                cost_exact: cost.is_some(),
                                stop_reason: records::str_at(message, &["stopReason"]).unwrap_or("").to_string(),
                                turn: turns.max(1),
                                duration_ms: message.get("duration").and_then(Value::as_f64).map(|d| d as i64),
                                ttft_ms: message.get("ttft").and_then(Value::as_f64).map(|d| d as i64),
                                ctx_tokens: records::u64_at(message, &["contextSnapshot", "promptTokens"]),
                            };
                            if opts.keep_events {
                                s.events.push(Ev::Usage {
                                    ts,
                                    model: rec.model.clone(),
                                    cost: rec.cost,
                                    tokens: rec.total,
                                    stop: rec.stop_reason.clone(),
                                });
                            }
                            s.usages.push(rec);
                        }
                    }
                    "toolResult" => {
                        let call_id = message.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                        let head = crate::truncate(&records::content_text(message), 160);
                        let chars = records::content_text(message).chars().count();
                        let is_error = message.get("isError").and_then(Value::as_bool).unwrap_or(false)
                            || v.get("isError").and_then(Value::as_bool).unwrap_or(false);
                        if let Some(&idx) = pending.get(call_id) {
                            let call = &mut s.calls[idx];
                            call.ended = Some(ts);
                            call.duration_ms = Some((ts - call.ts).num_milliseconds());
                            call.ok = !is_error;
                            call.result_chars = chars;
                            call.result_head = head;
                        } else if opts.keep_events {
                            s.events.push(Ev::Note {
                                ts,
                                text: format!("tool result {} {}", call_id, head),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "model_usage" => {
                let usage = v.get("usage");
                let get = |k: &str| usage.and_then(|u| u.get(k));
                let num = |k: &str| get(k).and_then(Value::as_u64).unwrap_or(0);
                let cost_obj = get("cost");
                let cost = cost_obj.and_then(|c| c.get("total")).and_then(Value::as_f64);
                let rec = UsageRec {
                    ts,
                    provider: records::str_at(&v, &["provider"]).unwrap_or("").to_string(),
                    model: records::str_at(&v, &["model"]).unwrap_or("?").to_string(),
                    purpose: records::str_at(&v, &["purpose"]).unwrap_or("").to_string(),
                    api: records::str_at(&v, &["api"]).unwrap_or("").to_string(),
                    input: num("input"),
                    output: num("output"),
                    cache_read: num("cacheRead"),
                    cache_write: num("cacheWrite"),
                    total: num("totalTokens"),
                    cost_cny: 0.0,
                    cost: cost.unwrap_or(0.0),
                    cost_exact: cost.is_some(),
                    stop_reason: records::str_at(&v, &["stopReason"]).unwrap_or("").to_string(),
                    turn: turns.max(1),
                    duration_ms: None,
                    ttft_ms: None,
                    ctx_tokens: num("input") + num("cacheRead") + num("cacheWrite"),
                };
                if opts.keep_events {
                    s.events.push(Ev::Usage {
                        ts,
                        model: rec.model.clone(),
                        cost: rec.cost,
                        tokens: rec.total,
                        stop: rec.stop_reason.clone(),
                    });
                }
                s.usages.push(rec);
            }
            "custom" => {
                let ctype = records::str_at(&v, &["customType"]).unwrap_or("");
                match ctype {
                    "tool_execution_start" => {
                        let call_id = records::str_at(&v, &["data", "toolCallId"]).unwrap_or("");
                        let intent = records::str_at(&v, &["data", "intent"]).unwrap_or("");
                        let name = records::str_at(&v, &["data", "toolName"]).unwrap_or("");
                        let started = records::str_at(&v, &["data", "startedAt"])
                            .and_then(records::parse_ts)
                            .unwrap_or(ts);
                        if let Some(&idx) = pending.get(call_id) {
                            let call = &mut s.calls[idx];
                            call.intent = intent.to_string();
                            call.ts = started;
                            if call.name.is_empty() || call.name == "?" {
                                call.name = name.to_string();
                            }
                        }
                    }
                    "session_exit" => {
                        let reason = records::str_at(&v, &["data", "reason"]).unwrap_or("").to_string();
                        s.exit = Some(reason.clone());
                        if opts.keep_events {
                            s.events.push(Ev::Exit { ts, reason });
                        }
                    }
                    _ => {}
                }
            }
            "custom_message" => {
                let ctype = records::str_at(&v, &["customType"]).unwrap_or("");
                if ctype == "async-result" && opts.keep_events {
                    let text = records::content_text(&v);
                    s.events.push(Ev::Note {
                        ts,
                        text: format!("background job finished: {}", crate::truncate(&text, 160)),
                    });
                }
            }
            "compaction" => {
                s.compactions += 1;
                if opts.keep_events {
                    s.events.push(Ev::Compact { ts });
                }
            }
            _ => {}
        }

        if let Some(t) = ts_opt {
            s.end = Some(match s.end {
                Some(prev) if prev > t => prev,
                _ => t,
            });
        }
    }

    // surface tool calls in the event stream (after their duration is known)
    if opts.keep_events {
        for call in &s.calls {
            s.events.push(Ev::Tool {
                ts: call.ts,
                name: call.name.clone(),
                target: call.target.clone(),
                duration_ms: call.duration_ms,
                ok: call.ok,
            });
        }
        s.events.sort_by_key(|e| event_ts(e));
    }

    s.turns = turns;
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

/// Recursively collect `*.jsonl` files. omp nests one directory per cwd.
pub fn discover(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, 0, 4, &mut out);
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

/// Scan every transcript under the sessions root (or an explicit root).
pub fn load_all_from(root: &Path, opts: ScanOpts) -> (Vec<Session>, usize) {
    let mut sessions = Vec::new();
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

pub fn load_all(opts: ScanOpts) -> (Vec<Session>, usize) {
    load_all_from(&crate::sessions_root(), opts)
}

/// Find one session by full id or unique prefix.
pub fn find(root: &Path, prefix: &str) -> anyhow::Result<Option<Session>> {
    let opts = ScanOpts { keep_events: true, text_cap: 4_000 };
    let prefix = prefix.trim().to_lowercase();
    if prefix.is_empty() {
        return Ok(None);
    }
    let mut hits: Vec<Session> = Vec::new();
    // pass 1: match the file name / embedded session id only
    let mut loose: Vec<PathBuf> = Vec::new();
    for path in discover(root) {
        let as_id = id_from_filename(&path).to_lowercase();
        if as_id.starts_with(&prefix) || path.to_string_lossy().to_lowercase().contains(&prefix) {
            if let Ok(s) = scan_file(&path, opts) {
                hits.push(s);
            }
        } else {
            loose.push(path);
        }
    }
    // pass 2: only if nothing matched by id, look inside the record head
    if hits.is_empty() {
        for path in loose {
            if read_head(&path, 4096).to_lowercase().contains(&prefix) {
                if let Ok(s) = scan_file(&path, opts) {
                    hits.push(s);
                }
            }
        }
    }
    match hits.len() {
        0 => Ok(None),
        1 => Ok(hits.pop()),
        _ => {
            let ids: Vec<String> = hits
                .iter()
                .map(|s| format!("{}  {}", &s.id[..8.min(s.id.len())], crate::truncate(&s.title, 40)))
                .collect();
            anyhow::bail!("ambiguous prefix '{prefix}', matches:\n  {}", ids.join("\n  "))
        }
    }
}

fn read_head(path: &Path, bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let Ok(mut f) = File::open(path) else { return String::new() };
    let n = f.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).to_string()
}

/// Read complete lines appended after `offset`. Half-written trailing bytes stay unconsumed.
pub fn read_new_lines(path: &Path, offset: &mut u64) -> std::io::Result<Vec<String>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < *offset {
        *offset = 0;
    }
    if len == *offset {
        return Ok(Vec::new());
    }
    let mut buf = Vec::new();
    f.seek(SeekFrom::Start(*offset))?;
    f.read_to_end(&mut buf)?;
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut consumed = 0usize;
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\n' {
            out.push(String::from_utf8_lossy(&buf[start..i]).to_string());
            start = i + 1;
            consumed = start;
        }
    }
    *offset += consumed as u64;
    Ok(out)
}

/// Parse a batch of raw lines into events (used by follow/watch, no aggregate math).
pub fn events_from_lines(lines: &[String], text_cap: usize) -> Vec<Ev> {
    let mut out = Vec::new();
    for line in lines {
        let Some(v) = records::parse(line) else { continue };
        let ts = records::ts(&v).unwrap_or_else(Utc::now);
        match records::kind(&v) {
            "message" => {
                let Some(message) = v.get("message") else { continue };
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => out.push(Ev::User { ts, text: crate::truncate(&records::content_text(message), 600) }),
                    Some("assistant") => {
                        let text = records::content_text(message);
                        if !text.trim().is_empty() {
                            out.push(Ev::Assistant { ts, text: crate::truncate(&text, text_cap) });
                        }
                        for tc in records::tool_calls(message) {
                            out.push(Ev::Tool {
                                ts,
                                name: tc.name.to_string(),
                                target: records::call_target(tc.arguments),
                                duration_ms: None,
                                ok: true,
                            });
                        }
                    }
                    Some("toolResult") => {
                        let is_error = message.get("isError").and_then(Value::as_bool).unwrap_or(false);
                        if is_error {
                            out.push(Ev::ToolFail {
                                ts,
                                name: message
                                    .get("toolName")
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                                    .to_string(),
                                text: crate::truncate(&records::content_text(message), 200),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "model_change" => out.push(Ev::Model {
                ts,
                model: records::str_at(&v, &["model"]).unwrap_or("?").to_string(),
                role: records::str_at(&v, &["role"]).unwrap_or("default").to_string(),
                fallback: records::bool_at(&v, &["resolvedModelIsFallback"]),
            }),
            "model_usage" => {
                let usage = v.get("usage");
                let num = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_u64).unwrap_or(0);
                let cost = usage
                    .and_then(|u| u.get("cost"))
                    .and_then(|c| c.get("total"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                out.push(Ev::Usage {
                    ts,
                    model: records::str_at(&v, &["model"]).unwrap_or("?").to_string(),
                    cost,
                    tokens: num("totalTokens"),
                    stop: records::str_at(&v, &["stopReason"]).unwrap_or("").to_string(),
                });
            }
            "compaction" => out.push(Ev::Compact { ts }),
            "custom" => {
                if records::str_at(&v, &["customType"]) == Some("session_exit") {
                    out.push(Ev::Exit {
                        ts,
                        reason: records::str_at(&v, &["data", "reason"]).unwrap_or("").to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

// ------------------------------------------------------------------ 产出文件

/// 会话写/改过的一个文件。
///
/// 只认会把内容落到盘上的工具（Write / Edit / MultiEdit / NotebookEdit …）；
/// Read、Bash 这类不记——它们的目标不一定是文件，也不一定是"产出"。
#[derive(Debug, Clone)]
pub struct ProducedFile {
    /// 绝对路径（相对路径按会话的 cwd 展开）
    pub path: String,
    /// 相对 cwd 的短路径；在 cwd 之外时与 `path` 相同
    pub rel: String,
    /// 最后一次动它的工具名
    pub tool: String,
    /// 写 + 改的次数
    pub count: usize,
    /// 最后一次动它的时间
    pub last: DateTime<Utc>,
}

fn is_write_tool(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "write"
            | "edit"
            | "multiedit"
            | "notebookedit"
            | "notepad"
            | "apply_patch"
            | "str_replace"
            | "str_replace_editor"
    )
}

fn is_absolute(raw: &str) -> bool {
    let b = raw.as_bytes();
    raw.starts_with('\\')
        || raw.starts_with('/')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// 折叠 `.` / `..`、统一成反斜杠。**不做** canonicalize：文件可能早就删了，
/// 而且 `\\wsl.localhost` 之类的路径碰一下可能要几百毫秒。
fn normalize_path(raw: &str, cwd: &str) -> String {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() {
        return String::new();
    }
    let cwd = cwd.trim().trim_matches('"');
    let joined = if is_absolute(raw) {
        raw.to_string()
    } else if cwd.is_empty() {
        raw.to_string()
    } else {
        format!("{}\\{}", cwd.trim_end_matches(['\\', '/']), raw)
    };

    let unified = joined.replace('/', "\\");
    let (prefix, rest) = match unified.strip_prefix("\\\\") {
        Some(r) => ("\\\\", r),
        None => ("", unified.as_str()),
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        match seg {
            "" | "." => {}
            // "C:" 这种前缀不能弹，所以留一个下限
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    format!("{prefix}{}", parts.join("\\"))
}

/// 在 cwd 里面就返回相对路径，省得界面上每行都从头写一遍盘符。
fn rel_path(path: &str, cwd: &str) -> String {
    let cwd = cwd.trim().trim_end_matches(['\\', '/']);
    if cwd.is_empty() {
        return path.to_string();
    }
    match path.get(..cwd.len()) {
        Some(head) if head.eq_ignore_ascii_case(cwd) && path.as_bytes().get(cwd.len()) == Some(&b'\\') => {
            path[cwd.len() + 1..].to_string()
        }
        _ => path.to_string(),
    }
}

/// 这个会话产出过哪些文件，按最后一次写入时间倒序。
///
/// Windows 路径不区分大小写，所以按小写去重；同一个文件改十次只留一行，带次数。
pub fn produced_files(s: &Session) -> Vec<ProducedFile> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, ProducedFile> = HashMap::new();

    for ev in &s.events {
        let Ev::Tool {
            ts,
            name,
            target: Some(target),
            ..
        } = ev
        else {
            continue;
        };
        if !is_write_tool(name) {
            continue;
        }
        let path = normalize_path(target, &s.cwd);
        if path.is_empty() {
            continue;
        }
        let key = path.to_lowercase();
        match map.get_mut(&key) {
            Some(f) => {
                f.count += 1;
                if *ts >= f.last {
                    f.last = *ts;
                    f.tool = name.clone();
                }
            }
            None => {
                order.push(key.clone());
                map.insert(
                    key,
                    ProducedFile {
                        rel: rel_path(&path, &s.cwd),
                        path,
                        tool: name.clone(),
                        count: 1,
                        last: *ts,
                    },
                );
            }
        }
    }

    let mut out: Vec<ProducedFile> = order.into_iter().filter_map(|k| map.remove(&k)).collect();
    out.sort_by(|a, b| b.last.cmp(&a.last));
    out
}

#[cfg(test)]
mod produced_file_tests {
    use super::*;

    fn tool(secs: i64, name: &str, target: &str) -> Ev {
        Ev::Tool {
            ts: DateTime::<Utc>::from_timestamp(secs, 0).unwrap(),
            name: name.to_string(),
            target: Some(target.to_string()),
            duration_ms: None,
            ok: true,
        }
    }

    fn session(cwd: &str, events: Vec<Ev>) -> Session {
        Session {
            cwd: cwd.to_string(),
            events,
            ..Default::default()
        }
    }

    #[test]
    fn dedupes_and_orders_by_last_write() {
        let s = session(
            r"D:\proj",
            vec![
                tool(1, "Write", r"D:\proj\a.rs"),
                tool(2, "Read", r"D:\proj\b.rs"), // 读不是产出
                tool(3, "Edit", r"D:\proj\A.RS"), // 同文件，大小写不同也算一个
                tool(4, "Write", r"D:\proj\src\c.rs"),
            ],
        );
        let files = produced_files(&s);
        assert_eq!(files.len(), 2, "应当合并成两个文件");
        assert_eq!(files[0].rel, r"src\c.rs", "最后写的排最前");
        assert_eq!(files[1].rel, "a.rs");
        assert_eq!(files[1].count, 2);
        assert_eq!(files[1].tool, "Edit");
    }

    #[test]
    fn resolves_relative_paths_and_folds_dotdot() {
        let s = session(r"D:\proj\sub", vec![tool(1, "Write", r"..\a\b.txt")]);
        let files = produced_files(&s);
        assert_eq!(files[0].path, r"D:\proj\a\b.txt");
        // 落在 cwd 之外，就没有"相对 cwd"这回事，原样给绝对路径
        assert_eq!(files[0].rel, r"D:\proj\a\b.txt");
    }

    #[test]
    fn keeps_paths_outside_cwd_absolute() {
        let s = session(r"D:\proj", vec![tool(1, "Write", r"E:\other\x.txt")]);
        let files = produced_files(&s);
        assert_eq!(files[0].path, r"E:\other\x.txt");
        assert_eq!(files[0].rel, r"E:\other\x.txt");
    }
}
