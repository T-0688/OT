//! Codex CLI transcript adapter (`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`).
//!
//! Codex 的转录比 Claude / omp 大一个量级（本机 125 个文件 509 MB，单个 161 MB）。
//! 真正好用的是 `event_msg/item_completed` 这条流：它的 `item.type` 已经是
//! UserMessage / AgentMessage / CommandExecution / FileChange / McpToolCall 这些
//! 语义单元，不用去碰体积巨大的 `response_item`（那里是完整的推理和原始 payload）。
//!
//! 花费：Codex 不写美元数，`token_usage_record` 只有 token，所以金额一律留空（显示 —），
//! 不拿别家价目表硬套。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::records;
use crate::sessions::{CallRec, Ev, ModelChangeRec, ScanOpts, Session, UsageRec};

pub const SOURCE: &str = "codex";

pub fn root() -> PathBuf {
    if let Ok(p) = std::env::var("OT_CODEX_DIR") {
        return PathBuf::from(p);
    }
    crate::home().join(".codex").join("sessions")
}

pub fn discover(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, 0, 5, &mut out);
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

/// `rollout-2026-09-19T20-03-04-01a0b98c-712f-…jsonl` → `01a0b98c-712f-…`
///
/// 会话 id 是 UUID 形态（8-4-4-4-12，36 字符），前缀 `01`；文件名前面还有一段
/// 带连字符的时间戳，所以按「36 字符串 + 4 个固定位置的连字符」来找，不能简单
/// 按 `-` 切分。
pub fn id_from_filename(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let bytes = stem.as_bytes();
    let mut start = 0usize;
    while start + 36 <= bytes.len() {
        if &bytes[start..start + 2] == b"01" {
            let cand = &stem[start..start + 36];
            let b = cand.as_bytes();
            let shape_ok = b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-';
            let chars_ok = cand.chars().all(|c| c == '-' || c.is_ascii_hexdigit());
            if shape_ok && chars_ok {
                return cand.to_string();
            }
        }
        start += 1;
        while start < bytes.len() && !stem.is_char_boundary(start) {
            start += 1;
        }
    }
    stem.to_string()
}

struct UsageRaw {
    ts: DateTime<Utc>,
    turn: usize,
    input: u64,
    cached: u64,
    output: u64,
    total: u64,
}

fn item_text(item: &Value) -> String {
    if let Some(items) = item.get("content").and_then(Value::as_array) {
        let mut out = String::new();
        for it in items {
            if let Some(t) = it.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    item.get("text").and_then(Value::as_str).unwrap_or("").to_string()
}

fn command_of(item: &Value) -> String {
    match item.get("command") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

pub fn scan_file(path: &Path, opts: ScanOpts) -> std::io::Result<Session> {
    let file = std::fs::File::open(path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut s = Session {
        path: path.to_path_buf(),
        size,
        source: SOURCE.into(),
        id: id_from_filename(path),
        ..Default::default()
    };

    let mut turns = 0usize;
    let mut tool_count = 0usize;
    let mut pending: HashMap<String, CallRec> = HashMap::new();
    let mut usages: Vec<UsageRaw> = Vec::new();
    let mut calls: Vec<CallRec> = Vec::new();
    let mut model_seen: Vec<ModelChangeRec> = Vec::new();
    let mut last_model = String::new();
    let mut end: Option<DateTime<Utc>> = None;

    for line in BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                s.bad_lines += 1;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if line.contains("\"type\":\"session_meta\"") {
            if let Some(v) = records::parse(&line) {
                if let Some(p) = v.get("payload") {
                    if let Some(id) = records::str_at(p, &["session_id"]).or(records::str_at(p, &["id"])) {
                        s.id = id.to_string();
                    }
                    if let Some(cwd) = records::str_at(p, &["cwd"]) {
                        s.cwd = cwd.to_string();
                    }
                    if let Some(ver) = records::str_at(p, &["cli_version"]) {
                        s.agent_version = format!("codex {ver}");
                    }
                    s.start = records::ts(&v);
                }
            }
            continue;
        }
        if line.contains("\"type\":\"token_usage_record\"") {
            if let Some(v) = records::parse(&line) {
                if let Some(u) = v.get("payload").and_then(|p| p.get("usage")) {
                    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                    let (i, c, o) = (n("input_tokens"), n("cached_input_tokens"), n("output_tokens"));
                    let total = u.get("total_tokens").and_then(Value::as_u64).unwrap_or(i + o);
                    usages.push(UsageRaw {
                        ts: records::ts(&v).unwrap_or_else(Utc::now),
                        turn: turns.max(1),
                        input: i,
                        cached: c,
                        output: o,
                        total,
                    });
                }
            }
            continue;
        }
        if line.contains("\"type\":\"thread_settings_applied\"") {
            if let Some(v) = records::parse(&line) {
                if let Some(m) = records::str_at(&v, &["payload", "thread_settings", "model"]) {
                    if m != last_model {
                        last_model = m.to_string();
                        model_seen.push(ModelChangeRec {
                            ts: records::ts(&v).unwrap_or_else(Utc::now),
                            model: m.to_string(),
                            role: "model".into(),
                            fallback: false,
                        });
                    }
                }
            }
            continue;
        }
        if line.contains("\"type\":\"compacted\"") || line.contains("\"type\":\"ContextCompaction\"") {
            s.compactions += 1;
        }
        if !line.contains("\"item_completed\"") {
            continue;
        }

        let Some(v) = records::parse(&line) else { continue };
        let ts = records::ts(&v).unwrap_or_else(Utc::now);
        end = Some(ts);
        let Some(item) = v.get("payload").and_then(|p| p.get("item")) else { continue };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");

        match kind {
            "UserMessage" => {
                turns += 1;
                let text = crate::truncate(&item_text(item), 300);
                if !text.trim().is_empty() {
                    s.prompts.push((turns, ts, text.clone()));
                    if opts.keep_events {
                        s.events.push(Ev::User { ts, text: crate::truncate(&text, 600) });
                    }
                }
            }
            "AgentMessage" => {
                if opts.keep_events {
                    let text = item_text(item);
                    if !text.trim().is_empty() {
                        s.events.push(Ev::Assistant {
                            ts,
                            text: crate::truncate(&text, opts.text_cap.min(600)),
                        });
                    }
                }
            }
            "CommandExecution" | "McpToolCall" | "FileChange" | "Extension" => {
                tool_count += 1;
                let (name, target) = match kind {
                    "CommandExecution" => ("exec", command_of(item)),
                    "FileChange" => (
                        "edit",
                        item.get("paths")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                            .unwrap_or_default(),
                    ),
                    "McpToolCall" => ("mcp", item.get("tool").and_then(Value::as_str).unwrap_or("").to_string()),
                    _ => ("ext", item.get("name").and_then(Value::as_str).unwrap_or("").to_string()),
                };
                let ok = item
                    .get("exit_code")
                    .and_then(Value::as_i64)
                    .map(|c| c == 0)
                    .unwrap_or(true);
                let head = item
                    .get("aggregated_output")
                    .or_else(|| item.get("output"))
                    .and_then(Value::as_str)
                    .map(|t| crate::truncate(t, 200))
                    .unwrap_or_default();
                let duration = item
                    .get("duration_ms")
                    .and_then(Value::as_i64)
                    .or_else(|| item.get("duration").and_then(Value::as_f64).map(|d| d as i64));
                let call_id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();

                if opts.keep_events {
                    s.events.push(Ev::Tool {
                        ts,
                        name: name.to_string(),
                        target: if target.is_empty() { None } else { Some(crate::truncate(&target, 90)) },
                        duration_ms: duration,
                        ok,
                    });
                    if !ok {
                        s.events.push(Ev::ToolFail { ts, name: name.to_string(), text: head.clone() });
                    }
                }
                let call = CallRec {
                    ts,
                    name: name.to_string(),
                    intent: crate::truncate(&target, 120),
                    target: if target.is_empty() { None } else { Some(crate::truncate(&target, 200)) },
                    call_id: call_id.clone(),
                    ended: Some(ts),
                    duration_ms: duration,
                    ok,
                    result_chars: head.chars().count(),
                    result_head: head,
                    turn: turns.max(1),
                };
                if !call_id.is_empty() {
                    pending.insert(call_id, call.clone());
                }
                calls.push(call);
            }
            _ => {}
        }
    }

    for u in usages {
        s.usages.push(UsageRec {
            ts: u.ts,
            provider: "openai".into(),
            model: if last_model.is_empty() { "codex".into() } else { last_model.clone() },
            purpose: "main".into(),
            api: "codex".into(),
            input: u.input,
            output: u.output,
            cache_read: u.cached,
            cache_write: 0,
            total: u.total,
            cost: 0.0,
            cost_cny: 0.0,
            cost_exact: false,
            stop_reason: String::new(),
            turn: u.turn,
            duration_ms: None,
            ttft_ms: None,
            ctx_tokens: u.total,
        });
    }

    s.turns = turns;
    s.models = model_seen;
    s.tool_count_hint = tool_count;
    s.calls = calls;
    s.end = end.or_else(|| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .map(DateTime::<Utc>::from)
    });
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
        s.cwd = "(未知)".into();
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

pub fn load_all(root: &Path, opts: ScanOpts) -> (Vec<Session>, usize) {
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

/// 守卫用：只看新增行里的用户消息。
pub fn events_from_lines(lines: &[String], text_cap: usize) -> Vec<Ev> {
    let mut out = Vec::new();
    for line in lines {
        if line.contains("\"type\":\"compacted\"") {
            if let Some(v) = records::parse(line) {
                out.push(Ev::Compact { ts: records::ts(&v).unwrap_or_else(Utc::now) });
            }
            continue;
        }
        if !line.contains("\"item_completed\"") || !line.contains("\"type\":\"UserMessage\"") {
            continue;
        }
        if let Some(v) = records::parse(line) {
            let ts = records::ts(&v).unwrap_or_else(Utc::now);
            if let Some(item) = v.get("payload").and_then(|p| p.get("item")) {
                let text = item_text(item);
                if !text.trim().is_empty() {
                    out.push(Ev::User { ts, text: crate::truncate(&text, text_cap) });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ot-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn id_comes_from_the_ulid_in_the_filename() {
        let p = Path::new(
            "rollout-2026-09-19T20-03-04-01a0b98c-712f-7f42-a59f-f45dc051e5d6.jsonl",
        );
        assert_eq!(id_from_filename(p), "01a0b98c-712f-7f42-a59f-f45dc051e5d6");
    }

    #[test]
    fn counts_items_tokens_and_turns() {
        let body = [
            r#"{"timestamp":"2026-09-19T12:04:07.998Z","type":"session_meta","payload":{"session_id":"01a0b98c-712f-7f42-a59f-f45dc051e5d6","cwd":"D:\\x","cli_version":"0.155.0"}}"#,
            r#"{"timestamp":"2026-09-19T12:04:08.074Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"帮我看看这个仓库"}]}}}"#,
            r#"{"timestamp":"2026-09-19T12:04:09.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"exec-1","command":["pwsh","-Command","ls"],"exit_code":0,"duration_ms":1500,"aggregated_output":"total 0"}}}"#,
            r#"{"timestamp":"2026-09-19T12:04:10.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"text","text":"看完了"}]}}}"#,
            r#"{"timestamp":"2026-09-19T12:04:26.311Z","type":"token_usage_record","payload":{"usage":{"input_tokens":25806,"cached_input_tokens":3968,"output_tokens":484,"total_tokens":26290}}}"#,
        ]
        .join("\n");
        let path = fixture("rollout-2026-09-19T20-03-04-01a0b98c-712f-7f42-a59f-f45dc051e5d6.jsonl", &body);

        let quick = scan_file(&path, ScanOpts { keep_events: false, text_cap: 0 }).unwrap();
        assert_eq!(quick.id, "01a0b98c-712f-7f42-a59f-f45dc051e5d6");
        assert_eq!(quick.turns, 1);
        assert_eq!(quick.tool_count(), 1);
        assert_eq!(quick.title, "帮我看看这个仓库");
        assert_eq!(quick.tokens(), 26290);
        assert!(!quick.cost_exact());

        let full = scan_file(&path, ScanOpts::default()).unwrap();
        assert_eq!(full.calls.len(), 1);
        assert_eq!(full.calls[0].name, "exec");
        assert_eq!(full.calls[0].duration_ms, Some(1500));
        assert_eq!(full.events.iter().filter(|e| matches!(e, Ev::User { .. })).count(), 1);
    }
}
