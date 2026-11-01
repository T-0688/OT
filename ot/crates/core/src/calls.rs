//! Tool-call inspection: slowest calls, failures, repeated targets, and grep.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::records;
use crate::sessions::{CallRec, Session};

#[derive(Debug, Clone)]
pub struct CallHit {
    pub session_id: String,
    pub project: String,
    pub title: String,
    pub call: CallRec,
}

pub fn slowest(sessions: &[Session], n: usize) -> Vec<CallHit> {
    let mut all: Vec<CallHit> = Vec::new();
    for s in sessions {
        for c in &s.calls {
            if c.duration_ms.is_some() {
                all.push(CallHit {
                    session_id: s.id.clone(),
                    project: s.project(),
                    title: s.title.clone(),
                    call: c.clone(),
                });
            }
        }
    }
    all.sort_by(|a, b| b.call.duration_ms.cmp(&a.call.duration_ms));
    all.truncate(n);
    all
}

pub fn slowest_turns(sessions: &[Session], n: usize) -> Vec<CallHit> {
    let mut all: Vec<CallHit> = Vec::new();
    for s in sessions {
        for c in &s.calls {
            all.push(CallHit {
                session_id: s.id.clone(),
                project: s.project(),
                title: s.title.clone(),
                call: c.clone(),
            });
        }
    }
    all.truncate(n);
    all
}

pub fn failures(sessions: &[Session], n: usize) -> Vec<CallHit> {
    let mut all: Vec<CallHit> = Vec::new();
    for s in sessions {
        for c in &s.calls {
            if !c.ok {
                all.push(CallHit {
                    session_id: s.id.clone(),
                    project: s.project(),
                    title: s.title.clone(),
                    call: c.clone(),
                });
            }
        }
    }
    all.sort_by_key(|h| std::cmp::Reverse(h.call.ts));
    all.truncate(n);
    all
}

/// Tools that keep poking the same file are a smell (repeated re-reads / rewrite loops).
pub fn repeated_targets(sessions: &[Session], min: usize) -> Vec<(String, usize)> {
    let mut map: BTreeMap<String, usize> = BTreeMap::new();
    for s in sessions {
        for c in &s.calls {
            if let Some(t) = &c.target {
                if t.len() > 3 && !t.starts_with('-') {
                    *map.entry(t.clone()).or_default() += 1;
                }
            }
        }
    }
    let mut v: Vec<(String, usize)> = map.into_iter().filter(|(_, n)| *n >= min).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// Cost per turn, flattened across sessions.
pub fn expensive_turns(sessions: &[Session], n: usize) -> Vec<(String, String, usize, f64)> {
    let mut all: Vec<(String, String, usize, f64)> = Vec::new();
    for s in sessions {
        let (id, title) = (s.id.clone(), s.title.clone());
        for (turn, cost) in s.turn_costs() {
            if cost > 0.0 {
                all.push((id.clone(), title.clone(), turn, cost));
            }
        }
    }
    all.sort_by(|a, b| b.3.total_cmp(&a.3));
    all.truncate(n);
    all
}

#[derive(Debug, Clone)]
pub struct GrepHit {
    pub session_id: String,
    pub source: String,
    pub title: String,
    pub project: String,
    pub ts: Option<DateTime<Utc>>,
    pub role: String,
    pub snippet: String,
}

/// Render a tool call whose arguments contain the needle as `name(args…)`.
fn tool_arg_match(message: &Value, needle_lc: &str) -> Option<String> {
    for tc in records::tool_calls(message) {
        let args = tc.arguments?;
        let raw = serde_json::to_string(args).unwrap_or_default();
        if !raw.to_lowercase().contains(needle_lc) {
            continue;
        }
        let compact = crate::truncate(&raw, 150);
        return Some(format!("{}({compact})", tc.name));
    }
    None
}

/// Slice a window out of a raw JSON line around a byte offset, undoing the worst
/// of the JSON escaping so the snippet stays readable.
fn raw_window(line: &str, pos: usize, width: usize) -> String {
    let mut start = pos.saturating_sub(width / 2);
    while start > 0 && !line.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + width).min(line.len());
    while end > start && !line.is_char_boundary(end) {
        end -= 1;
    }
    let slice = &line[start..end];
    let cleaned = slice.replace("\\n", " ").replace("\\\"", "\"").replace("\\\\", "\\");
    crate::one_line(&format!("…{cleaned}…"))
}

/// Stream every transcript line and substring-match. Cheap enough for tens of MB,
/// and it never holds a whole file in memory.
pub fn grep_root(root: &Path, label: &str, needle: &str, include_tools: bool, limit: usize) -> Vec<GrepHit> {
    let needle_lc = needle.to_lowercase();
    let mut hits = Vec::new();
    if needle_lc.is_empty() {
        return hits;
    }
    for path in crate::source::files_in(label, root) {
        if hits.len() >= limit {
            break;
        }
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let mut id = String::new();
        let mut title = String::new();
        let mut project = String::new();
        let reader = BufReader::new(file);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let Some(v) = records::parse(&line) else { continue };
            let matched = line.to_lowercase().contains(&needle_lc);
            let kind = records::kind(&v);

            match kind {
                "title" | "title_change" => {
                    if let Some(t) = records::str_at(&v, &["title"]) {
                        title = t.to_string();
                    }
                    continue;
                }
                "ai-title" => {
                    if let Some(t) = records::str_at(&v, &["aiTitle"]) {
                        title = t.to_string();
                    }
                    continue;
                }
                "session" => {
                    if let Some(i) = records::str_at(&v, &["id"]) {
                        id = i.to_string();
                    }
                    if let Some(c) = records::str_at(&v, &["cwd"]) {
                        project = c.rsplit(['\\', '/']).next().unwrap_or(c).to_string();
                    }
                    continue;
                }
                _ => {}
            }
            if !matched {
                continue;
            }
            if id.is_empty() {
                if let Some(sid) = records::str_at(&v, &["sessionId"]) {
                    id = sid.to_string();
                }
            }
            if project.is_empty() {
                if let Some(c) = records::str_at(&v, &["cwd"]) {
                    project = c.rsplit(['\\', '/']).next().unwrap_or(c).to_string();
                }
            }

            let (role, text, in_tools_only) = if label == crate::claude::SOURCE {
                claude_line(&v, include_tools)
            } else {
                omp_line(&v, include_tools)
            };
            let Some(role) = role else { continue };
            if in_tools_only && !include_tools {
                continue;
            }

            let lower = text.to_lowercase();
            let snippet = match lower.find(&needle_lc) {
                Some(p) => {
                    let before: String = text[..p]
                        .chars()
                        .rev()
                        .take(60)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    let after: String = text[p..].chars().take(140).collect();
                    crate::one_line(&format!("{before}{after}"))
                }
                None => raw_window(&line, line.to_lowercase().find(&needle_lc).unwrap_or(0), 180),
            };
            hits.push(GrepHit {
                session_id: if id.is_empty() {
                    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
                } else {
                    id.clone()
                },
                source: label.to_string(),
                title: title.clone(),
                project: project.clone(),
                ts: records::ts(&v),
                role,
                snippet,
            });
            if hits.len() >= limit {
                return hits;
            }
        }
    }
    hits
}

/// (role, text, tool-output-only)
fn omp_line(v: &Value, _include_tools: bool) -> (Option<String>, String, bool) {
    if records::kind(v) != "message" {
        return (None, String::new(), false);
    }
    let Some(message) = v.get("message") else { return (None, String::new(), false) };
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let (label, tools_only) = match role {
        "user" => ("user", false),
        "assistant" => ("ai", false),
        "toolResult" => ("tool", true),
        _ => return (None, String::new(), false),
    };
    (Some(label.to_string()), records::content_text(message), tools_only)
}

/// (role, text, tool-output-only)
fn claude_line(v: &Value, _include_tools: bool) -> (Option<String>, String, bool) {
    match records::kind(v) {
        "user" => {
            let Some(message) = v.get("message") else { return (None, String::new(), false) };
            match message.get("content") {
                Some(Value::String(text)) => (Some("user".into()), text.clone(), false),
                Some(Value::Array(items)) => {
                    let is_tool = items
                        .iter()
                        .any(|i| i.get("type").and_then(Value::as_str) == Some("tool_result"));
                    let text = if is_tool {
                        items
                            .iter()
                            .filter(|i| i.get("type").and_then(Value::as_str) == Some("tool_result"))
                            .filter_map(|i| match i.get("content") {
                                Some(Value::String(t)) => Some(t.clone()),
                                Some(other) => Some(other.to_string()),
                                None => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        records::content_text(message)
                    };
                    if is_tool {
                        (Some("tool".into()), text, true)
                    } else {
                        (Some("user".into()), text, false)
                    }
                }
                _ => (None, String::new(), false),
            }
        }
        "assistant" => {
            let Some(message) = v.get("message") else { return (None, String::new(), false) };
            let mut text = String::new();
            if let Some(items) = message.get("content").and_then(Value::as_array) {
                for b in items {
                    if b.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                }
            }
            // tool arguments are part of the assistant turn and always searchable
            if text.is_empty() {
                if let Some(items) = message.get("content").and_then(Value::as_array) {
                    for b in items {
                        if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let name = b.get("name").and_then(Value::as_str).unwrap_or("?");
                            let args = b.get("input").map(|i| i.to_string()).unwrap_or_default();
                            text.push_str(&format!("{name}({args})"));
                        }
                    }
                }
            }
            (Some("ai".into()), text, false)
        }
        _ => (None, String::new(), false),
    }
}
