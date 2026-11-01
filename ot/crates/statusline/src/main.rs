//! Claude Code 的状态栏渲染器。
//!
//! Claude Code 会把当前会话的 JSON 从 stdin 喂进来，把 stdout 当状态栏显示。
//! 我们不自己算 token 和花费——那两样 JSON 里就有；只有余额要另外查（走 ot-core
//! 的 /v1/usage 探针），为了不拖慢每次重绘，余额是"用缓存 + 后台刷新"。
//!
//! 段：模型 · 上下文 · 花费 · 目录 · git · 余额

use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const SEP: &str = "\u{e0b0}";

/// 低饱和深绿，从左到右一档一档变亮
const BG: [(u8, u8, u8); 6] = [
    (26, 46, 41),
    (31, 56, 49),
    (36, 66, 57),
    (41, 76, 65),
    (46, 86, 74),
    (53, 100, 85),
];
const TEXT: (u8, u8, u8) = (214, 226, 219);

fn fg(rgb: (u8, u8, u8)) -> String {
    format!("\x1b[38;2;{};{};{}m", rgb.0, rgb.1, rgb.2)
}

fn bg(rgb: (u8, u8, u8)) -> String {
    format!("\x1b[48;2;{};{};{}m", rgb.0, rgb.1, rgb.2)
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn get<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

fn as_u64(v: &Value, path: &[&str]) -> Option<u64> {
    get(v, path).and_then(|x| x.as_u64())
}

fn segment_texts(input: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // 模型
    let model = get(input, &["model", "display_name"])
        .and_then(|v| v.as_str())
        .or_else(|| get(input, &["model", "id"]).and_then(|v| v.as_str()))
        .unwrap_or("claude");
    out.push(model.to_string());

    // 上下文：不同版本字段名不一样，挨个试
    let used = as_u64(input, &["context", "used_tokens"])
        .or_else(|| as_u64(input, &["context_window", "used_tokens"]))
        .or_else(|| as_u64(input, &["context_usage", "used_tokens"]));
    let max = as_u64(input, &["context", "max_tokens"])
        .or_else(|| as_u64(input, &["context_window", "max_tokens"]))
        .or_else(|| as_u64(input, &["context_usage", "max_tokens"]))
        .filter(|m| *m > 0);
    if let (Some(u), Some(m)) = (used, max) {
        out.push(format!("上下文 {:.0}%", u as f64 * 100.0 / m as f64));
    } else if let Some(u) = used {
        out.push(format!("上下文 {}", fmt_tokens(u)));
    }

    // 花费
    if let Some(c) = get(input, &["cost", "total_cost_usd"]).and_then(|v| v.as_f64()) {
        if c > 0.0 {
            out.push(format!("${c:.2}"));
        }
    }

    // 目录（显示最后两段，太长会占满一行）
    let dir = get(input, &["workspace", "current_dir"])
        .and_then(|v| v.as_str())
        .or_else(|| get(input, &["cwd"]).and_then(|v| v.as_str()))
        .unwrap_or("");
    if !dir.is_empty() {
        let parts: Vec<&str> = dir.trim_end_matches('\\').rsplit('\\').take(2).collect();
        let short = parts.into_iter().rev().collect::<Vec<_>>().join("\\");
        out.push(short);
    }

    // git 分支
    if let Some(branch) = git_branch(dir) {
        out.push(branch);
    }

    // 余额（缓存）
    if let Some(b) = balance_cached() {
        out.push(format!("余额 {b}"));
    }

    out
}

fn git_branch(dir: &str) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let out = std::process::Command::new("git")
        .args(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

// ---------------------------------------------------------------- 余额缓存

fn cache_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("ot").join("statusline-balance.json")
}

const TTL_SECS: u64 = 300;

fn read_cache() -> Option<(u64, String)> {
    let text = std::fs::read_to_string(cache_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let ts = v.get("ts").and_then(|x| x.as_u64())?;
    let text = v.get("text").and_then(|x| x.as_str())?.to_string();
    Some((ts, text))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn balance_cached() -> Option<String> {
    let cached = read_cache();
    let fresh = cached.as_ref().map(|(ts, _)| now_secs().saturating_sub(*ts) < TTL_SECS).unwrap_or(false);
    if !fresh {
        // 后台刷新，不阻塞状态栏
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe)
                .arg("--refresh-balance")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    cached.map(|(_, t)| t)
}

/// `--refresh-balance`：查当前 claude 供应商的余额，写缓存。
fn refresh_balance() {
    let store = ot_core::providers::load();
    let Some(profile) = store
        .profiles
        .iter()
        .find(|p| p.app == "claude" && store.current.get("claude") == Some(&p.id))
    else {
        eprintln!("[statusline] 没找到当前 claude 供应商（current={:?}）", store.current.get("claude"));
        return;
    };
    let base = profile.base_url.clone();
    let cur = if profile.currency.is_empty() { None } else { Some(profile.currency.as_str()) };
    let bal = match ot_core::balance::query_with_currency(&base, &profile.api_key, cur) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[statusline] 查余额失败 base={base} err={e}");
            return;
        }
    };
    let text = if bal.unit == "CNY" {
        format!("¥{:.2}", bal.amount)
    } else {
        format!("${:.2}", bal.amount)
    };
    let payload = format!(
        "{{\"ts\":{},\"text\":{}}}",
        now_secs(),
        serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".into())
    );
    if let Some(dir) = cache_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(cache_path(), payload) {
        eprintln!("[statusline] 写缓存失败: {e}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--refresh-balance") {
        refresh_balance();
        return;
    }

    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return;
    }
    let input: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    let segs = segment_texts(&input);
    if segs.is_empty() {
        return;
    }

    let mut out = String::new();
    for (i, text) in segs.iter().enumerate() {
        let bgc = BG[i % BG.len()];
        out.push_str(&bg(bgc));
        out.push_str(&fg(TEXT));
        out.push_str(&format!(" {text} "));
        // 分隔符：本段底色作前景，下一段底色作背景
        let next = BG[(i + 1) % BG.len()];
        out.push_str(&fg(bgc));
        if i + 1 < segs.len() {
            out.push_str(&bg(next));
        } else {
            out.push_str("\x1b[49m");
        }
        out.push_str(SEP);
    }
    out.push_str("\x1b[0m");
    println!("{out}");
}
