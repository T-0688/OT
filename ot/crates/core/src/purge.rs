//! 彻底删除一个 Claude Code 会话：转录、附属目录、全局历史里的一并清掉。
//!
//! 一个会话在 Claude Code 里落成这几处：
//!   ~/.claude/projects/<项目>/<会话>.jsonl      转录本体
//!   ~/.claude/file-history/<会话>/              改过的文件快照
//!   ~/.claude/session-env/<会话>/               会话环境
//!   ~/.claude/todos/<会话>-*.json               待办
//!   ~/.claude/history.jsonl                     全局输入历史（按 sessionId 挑掉）
//!   ~/.claude.json                              项目里的会话引用
//!
//! 这里不做"回收站"：调用方已经确认过，就真的删。

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Target {
    /// 展示用：相对 ~/.claude 的路径
    pub path: String,
    pub kind: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Plan {
    pub items: Vec<Target>,
    pub total_bytes: u64,
}

pub fn claude_root() -> PathBuf {
    // 测试/多实例时可以把整个 .claude 指到别处：OT_CLAUDE_DIR 是它下面的 projects
    if let Ok(dir) = std::env::var("OT_CLAUDE_DIR") {
        let p = PathBuf::from(dir);
        if let Some(parent) = p.parent() {
            return parent.to_path_buf();
        }
    }
    crate::home().join(".claude")
}

fn claude_json() -> PathBuf {
    crate::home().join(".claude.json")
}

/// 只允许 UUID 形态的 id，防止拼路径时被带出目录。
fn check_id(id: &str) -> Result<()> {
    if id.len() < 8 || id.len() > 64 {
        bail!("会话 id 长度不对");
    }
    if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        bail!("会话 id 含非法字符");
    }
    Ok(())
}

fn dir_size(p: &Path) -> u64 {
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            total += dir_size(&e.path());
        }
    }
    total
}

fn rel(p: &Path) -> String {
    let root = claude_root();
    p.strip_prefix(&root)
        .map(|x| x.display().to_string())
        .unwrap_or_else(|_| p.display().to_string())
}

fn push(plan: &mut Plan, path: &Path, kind: &str) {
    if !path.exists() {
        return;
    }
    let bytes = dir_size(path);
    plan.total_bytes += bytes;
    plan.items.push(Target { path: rel(path), kind: kind.to_string(), bytes });
}

pub fn plan(id: &str) -> Result<Plan> {
    check_id(id)?;
    let mut plan = Plan::default();
    let root = claude_root();

    // 转录：projects/<项目>/<id>.jsonl
    if let Ok(projects) = std::fs::read_dir(root.join("projects")) {
        for e in projects.flatten() {
            let p = e.path().join(format!("{id}.jsonl"));
            push(&mut plan, &p, "转录");
        }
    }
    for (dir, kind) in [
        ("file-history", "文件历史"),
        ("session-env", "会话环境"),
        ("todos", "待办"),
    ] {
        let base = root.join(dir);
        if !base.exists() {
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(id) {
                    push(&mut plan, &e.path(), kind);
                }
            }
        }
    }

    // 全局历史里有这个会话的行
    let hist = root.join("history.jsonl");
    if hist.exists() && history_hits(&hist, id) > 0 {
        plan.items.push(Target { path: "history.jsonl（挑掉相关行）".into(), kind: "全局历史".into(), bytes: 0 });
    }
    // ~/.claude.json 里的项目引用
    let cj = claude_json();
    if cj.exists() {
        if let Ok(text) = std::fs::read_to_string(&cj) {
            if text.contains(id) {
                plan.items.push(Target { path: "~/.claude.json（去掉该会话条目）".into(), kind: "项目引用".into(), bytes: 0 });
            }
        }
    }
    Ok(plan)
}

fn history_hits(path: &Path, id: &str) -> usize {
    let Ok(text) = std::fs::read_to_string(path) else { return 0 };
    text.lines()
        .filter(|l| l.contains(id))
        .filter(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("sessionId").and_then(|s| s.as_str()).map(|s| s == id))
                .unwrap_or(true)
        })
        .count()
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let tmp = path.with_extension("ot-tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 真删。返回删掉的文件/目录个数。
pub fn delete(id: &str) -> Result<usize> {
    let plan = plan(id)?;
    let root = claude_root();
    let mut removed = 0usize;

    // 1) 转录 + 附属目录
    if let Ok(projects) = std::fs::read_dir(root.join("projects")) {
        for e in projects.flatten() {
            let p = e.path().join(format!("{id}.jsonl"));
            if p.is_file() {
                std::fs::remove_file(&p).with_context(|| format!("删除 {} 失败", p.display()))?;
                removed += 1;
            }
        }
    }
    for dir in ["file-history", "session-env", "todos"] {
        let base = root.join(dir);
        if !base.exists() {
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                if !e.file_name().to_string_lossy().starts_with(id) {
                    continue;
                }
                let p = e.path();
                let ok = if p.is_dir() {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                };
                if ok.is_ok() {
                    removed += 1;
                }
            }
        }
    }

    // 2) 全局历史：只挑掉属于这个会话的行
    let hist = root.join("history.jsonl");
    if hist.exists() {
        if let Ok(text) = std::fs::read_to_string(&hist) {
            if text.contains(id) {
                let kept: Vec<&str> = text
                    .lines()
                    .filter(|l| {
                        if !l.contains(id) {
                            return true;
                        }
                        // 解析不出来就保守保留
                        match serde_json::from_str::<serde_json::Value>(l) {
                            Ok(v) => v.get("sessionId").and_then(|s| s.as_str()).map(|s| s != id).unwrap_or(true),
                            Err(_) => true,
                        }
                    })
                    .collect();
                let mut out = kept.join("\n");
                if !out.is_empty() {
                    out.push('\n');
                }
                if out != text {
                    atomic_write(&hist, &out)?;
                }
            }
        }
    }

    // 3) ~/.claude.json：去掉带这个 sessionId 的条目（先备份）
    let cj = claude_json();
    if cj.exists() {
        if let Ok(text) = std::fs::read_to_string(&cj) {
            if text.contains(id) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                    let changed = strip_session(&mut v, id);
                    if changed {
                        let backup = cj.with_extension("json.bak-ot");
                        let _ = std::fs::write(&backup, &text);
                        let next = serde_json::to_string_pretty(&v)? + "\n";
                        atomic_write(&cj, &next)?;
                    }
                }
            }
        }
    }

    if removed == 0 && plan.items.is_empty() {
        bail!("没找到这个会话的文件");
    }
    let _ = plan;
    Ok(removed)
}

/// 递归去掉任何带 `sessionId == id` 的对象/数组项；返回是否改动。
fn strip_session(v: &mut serde_json::Value, id: &str) -> bool {
    match v {
        serde_json::Value::Object(map) => {
            let mut changed = false;
            if map.get("sessionId").and_then(|s| s.as_str()) == Some(id) {
                map.insert("sessionId".into(), serde_json::Value::String(String::new()));
                changed = true;
            }
            if map.get("lastSessionId").and_then(|s| s.as_str()) == Some(id) {
                map.remove("lastSessionId");
                changed = true;
            }
            for (_, child) in map.iter_mut() {
                changed |= strip_session(child, id);
            }
            changed
        }
        serde_json::Value::Array(arr) => {
            let before = arr.len();
            arr.retain(|item| item.get("sessionId").and_then(|s| s.as_str()) != Some(id));
            let mut changed = arr.len() != before;
            for item in arr.iter_mut() {
                changed |= strip_session(item, id);
            }
            changed
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert!(check_id("../../etc/passwd").is_err());
        assert!(check_id("abc/def").is_err());
        assert!(check_id("b1e0d9c8-658c-42c4-b74a-3663b4e21995").is_ok());
    }

#[test]
    fn deletes_transcript_sidecars_and_history_lines() {
        let root = std::env::temp_dir().join(format!("ot-purge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("projects").join("D--x")).unwrap();
        std::fs::create_dir_all(root.join("file-history")).unwrap();
        std::fs::create_dir_all(root.join("session-env")).unwrap();
        std::fs::create_dir_all(root.join("todos")).unwrap();

        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        std::fs::write(root.join("projects").join("D--x").join(format!("{id}.jsonl")), "{}\n").unwrap();
        std::fs::create_dir_all(root.join("file-history").join(id)).unwrap();
        std::fs::write(root.join("file-history").join(id).join("snap"), "x").unwrap();
        std::fs::create_dir_all(root.join("session-env").join(id)).unwrap();
        std::fs::write(root.join("todos").join(format!("{id}-agent.json")), "[]").unwrap();
        // 别的会话的文件，不该被碰
        std::fs::write(root.join("projects").join("D--x").join("other.jsonl"), "{}\n").unwrap();

        let hist = root.join("history.jsonl");
        std::fs::write(
            &hist,
            format!(
                "{{\"display\":\"mine\",\"sessionId\":\"{id}\"}}\n{{\"display\":\"keep\",\"sessionId\":\"zzz\"}}\n"
            ),
        )
        .unwrap();

        std::env::set_var("OT_CLAUDE_DIR", root.join("projects").display().to_string());

        let plan = plan(id).unwrap();
        assert!(plan.items.len() >= 3, "plan 应覆盖转录与附属目录: {:?}", plan.items);
        let removed = delete(id).unwrap();
        assert!(removed >= 3, "至少删掉转录 + 两个目录，实际 {removed}");

        assert!(!root.join("projects").join("D--x").join(format!("{id}.jsonl")).exists());
        assert!(!root.join("file-history").join(id).exists());
        assert!(!root.join("session-env").join(id).exists());
        assert!(!root.join("todos").join(format!("{id}-agent.json")).exists());
        assert!(root.join("projects").join("D--x").join("other.jsonl").exists(), "别人的会话不能动");

        let text = std::fs::read_to_string(&hist).unwrap();
        assert!(!text.contains(id), "历史里的该会话行应被删除");
        assert!(text.contains("keep"), "别的历史行要保留");

        std::env::remove_var("OT_CLAUDE_DIR");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn strips_matching_session_entries() {
        let mut v: serde_json::Value = serde_json::from_str(
            r#"{"a":{"history":[{"sessionId":"keep"},{"sessionId":"drop"}]},"lastSessionId":"drop"}"#,
        )
        .unwrap();
        assert!(strip_session(&mut v, "drop"));
        assert_eq!(v["a"]["history"].as_array().unwrap().len(), 1);
        assert!(v.get("lastSessionId").is_none());
        assert!(!strip_session(&mut v, "drop"), "第二次应无改动");
    }
}
