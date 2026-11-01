//! Line-level helpers for omp transcript records.
//!
//! Transcripts are one JSON object per line. We deliberately keep these
//! untyped (`serde_json::Value`) because the schema grows new `type`s and
//! `customType`s between omp releases and a strict struct would drop them.

use chrono::{DateTime, Utc};
use serde_json::Value;

pub fn parse(line: &str) -> Option<Value> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(line).ok()
}

pub fn kind(v: &Value) -> &str {
    v.get("type").and_then(Value::as_str).unwrap_or("")
}

pub fn ts(v: &Value) -> Option<DateTime<Utc>> {
    let raw = v.get("timestamp").and_then(Value::as_str)?;
    parse_ts(raw)
}

pub fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            // a few records carry epoch millis instead
            raw.parse::<i64>()
                .ok()
                .and_then(DateTime::<Utc>::from_timestamp_millis)
        })
}

pub fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_str()
}

pub fn u64_at(v: &Value, path: &[&str]) -> u64 {
    let mut cur = v;
    for key in path {
        match cur.get(*key) {
            Some(next) => cur = next,
            None => return 0,
        }
    }
    cur.as_u64()
        .or_else(|| cur.as_f64().map(|f| f.max(0.0) as u64))
        .unwrap_or(0)
}

pub fn f64_at(v: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = v;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_f64()
}

pub fn bool_at(v: &Value, path: &[&str]) -> bool {
    let mut cur = v;
    for key in path {
        match cur.get(*key) {
            Some(next) => cur = next,
            None => return false,
        }
    }
    cur.as_bool().unwrap_or(false)
}

/// Flatten a message `content` array (or bare string) into plain text.
pub fn content_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for item in items {
        let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
        if ty == "text" {
            if let Some(t) = item.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    out
}

pub fn thinking_text(message: &Value) -> String {
    let Some(items) = message.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut out = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("thinking") {
            if let Some(t) = item.get("thinking").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    out
}

pub struct RawToolCall<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub arguments: Option<&'a Value>,
}

pub fn tool_calls(message: &Value) -> Vec<RawToolCall<'_>> {
    let mut out = Vec::new();
    let Some(items) = message.get("content").and_then(Value::as_array) else {
        return out;
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("toolCall") {
            continue;
        }
        out.push(RawToolCall {
            id: item.get("id").and_then(Value::as_str).unwrap_or(""),
            name: item.get("name").and_then(Value::as_str).unwrap_or("?"),
            arguments: item.get("arguments"),
        });
    }
    out
}

/// Best-effort "what was this call aimed at" — most tools carry a path-ish arg.
pub fn call_target(arguments: Option<&Value>) -> Option<String> {
    let args = arguments?;
    let obj = args.as_object()?;
    for key in [
        "path", "file_path", "file", "filename", "target", "url", "pattern", "command", "cmd",
        "query", "q",
    ] {
        if let Some(v) = obj.get(key).and_then(Value::as_str) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}
