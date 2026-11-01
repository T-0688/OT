//! Read-only core for the `ot` terminal sidecar.
//!
//! Everything here is derived from files omp already writes:
//!   <omp>/agent/sessions/**/*.jsonl   session transcripts
//!   <omp>/agent/config.yml            model roles
//!   <omp>/agent/models.yml            provider + price table
//! plus our own state/settings under %LOCALAPPDATA%\ot.
//!
//! Nothing in this crate writes to a session file.

pub mod alerts;
pub mod balance;
pub mod calls;
pub mod ccswitch;
pub mod claude;
pub mod codex;
pub mod config;
pub mod pricing;
pub mod providers;
pub mod purge;
pub mod records;
pub mod sessions;
pub mod source;
pub mod usage;
pub mod watch;

use std::path::PathBuf;

use chrono::{DateTime, Local, Utc};

pub const APP: &str = "ot";

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
}

pub fn omp_agent_dir() -> PathBuf {
    omp_home().join("agent")
}

pub fn omp_home() -> PathBuf {
    if let Ok(p) = std::env::var("OT_OMP_HOME") {
        return PathBuf::from(p);
    }
    home().join(".omp")
}

/// Session transcript root. `OT_SESSION_DIR` wins, then `--session-dir`, then omp's default.
pub fn sessions_root() -> PathBuf {
    if let Ok(p) = std::env::var("OT_SESSION_DIR") {
        return PathBuf::from(p);
    }
    omp_agent_dir().join("sessions")
}

pub fn config_path() -> PathBuf {
    omp_agent_dir().join("config.yml")
}

pub fn models_path() -> PathBuf {
    omp_agent_dir().join("models.yml")
}

pub fn local_app_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| home().to_string_lossy().to_string());
    PathBuf::from(base).join(APP)
}

pub fn state_path() -> PathBuf {
    local_app_dir().join("state.json")
}

pub fn settings_default_currency() -> &'static str {
    "USD"
}

pub fn fmt_cost(cost: f64, currency: &str) -> String {
    // the delta-spreading step can hand back -0.0
    let cost = if cost.abs() < 1e-9 { 0.0 } else { cost };
    if currency.eq_ignore_ascii_case("CNY") {
        format!("￥{cost:.4}")
    } else {
        format!("${cost:.4}")
    }
}

/// 花费显示：没有价目表的就写 —，缺价的加 ≈，别把 0 当成“免费”。
pub fn fmt_money(cost: f64, exact: bool, currency: &str) -> String {
    if !exact && cost.abs() < 1e-12 {
        "—".to_string()
    } else if exact {
        fmt_cost(cost, currency)
    } else {
        format!("{}≈", fmt_cost(cost, currency))
    }
}

pub fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.2}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

pub fn fmt_dur(ms: i64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else if ms < 3_600_000 {
        format!("{}m{:02}s", ms / 60_000, (ms % 60_000) / 1000)
    } else {
        format!("{}h{:02}m", ms / 3_600_000, (ms % 3_600_000) / 60_000)
    }
}

/// "3 分钟前" 这种相对时间，按本地时区。
pub fn rel_time(ts: Option<DateTime<Utc>>) -> String {
    let Some(ts) = ts else { return "-".into() };
    let now = Utc::now();
    let secs = (now - ts).num_seconds();
    if secs < 0 {
        return ts.with_timezone(&Local).format("%m-%d %H:%M").to_string();
    }
    if secs < 60 {
        format!("{secs} 秒前")
    } else if secs < 3600 {
        format!("{} 分钟前", secs / 60)
    } else if secs < 86_400 {
        format!("{} 小时前", secs / 3600)
    } else if secs < 86_400 * 7 {
        format!("{} 天前", secs / 86_400)
    } else {
        ts.with_timezone(&Local).format("%m-%d %H:%M").to_string()
    }
}

pub fn local_date(ts: DateTime<Utc>) -> String {
    ts.with_timezone(&Local).format("%Y-%m-%d").to_string()
}

pub fn local_time(ts: DateTime<Utc>) -> String {
    ts.with_timezone(&Local).format("%m-%d %H:%M:%S").to_string()
}

/// The shell line that resumes this session in its own agent.
pub fn resume_command(s: &sessions::Session) -> String {
    let cwd = s.cwd.trim_end_matches(['\\', '/']);
    match s.source.as_str() {
        "claude" => format!("cd /d \"{cwd}\" && claude --resume {}", s.id),
        "codex" => format!("cd /d \"{cwd}\" && codex resume {}", s.id),
        _ => format!("cd /d \"{cwd}\" && omp --resume {}", s.id),
    }
}

/// 会话记录的目录可能已经删了。退到最近一个还存在的上级目录，避免
/// `start /D` 抛「当前目录无效」。
pub fn resolve_cwd(cwd: &str) -> (std::path::PathBuf, bool) {
    let p = std::path::Path::new(cwd);
    if p.is_dir() {
        return (p.to_path_buf(), false);
    }
    let mut cur = p;
    while let Some(parent) = cur.parent() {
        if parent.is_dir() {
            return (parent.to_path_buf(), true);
        }
        cur = parent;
    }
    (home(), true)
}

/// Open the session in a new console window.
///
/// Deliberately does NOT hand `start` a single quoted `cd … && agent …` string:
/// cmd would treat it as one argument and fail with
/// 「文件名、目录名或卷标语法不正确」. `/D` sets the working directory instead.
pub fn spawn_resume(s: &sessions::Session) -> std::io::Result<(std::path::PathBuf, bool)> {
    let (dir, substituted) = resolve_cwd(&s.cwd);
    open_resume_at(&dir, &s.source, &s.id)?;
    Ok((dir, substituted))
}

/// 找 Windows Terminal 的绝对路径。
///
/// 注意：`wt.exe` 是 WindowsApps 里的**应用执行别名**，`where.exe wt` 查不到它，
/// 之前就因为这个一直走 cmd 兜底——实测那条路要 4.6 秒，wt 只要 0.2 秒。
fn wt_exe() -> Option<std::path::PathBuf> {
    static CACHE: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            if let Ok(base) = std::env::var("LOCALAPPDATA") {
                let p = std::path::PathBuf::from(base)
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("wt.exe");
                if p.exists() {
                    return Some(p);
                }
            }
            let out = std::process::Command::new("where.exe").arg("wt").output().ok()?;
            if !out.status.success() {
                return None;
            }
            let line = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
            if line.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(line))
            }
        })
        .clone()
}

/// 在 `dir` 下新开一个终端，跑 `<agent> --resume <id>`。
///
/// 两个细节决定了"有没有颜色"：
///   1. **清掉 NO_COLOR**：GUI 进程会继承启动它的那个 shell 的环境，一旦里面有
///      NO_COLOR=1，claude 就整场不上色。顺手补上 TERM/COLORTERM/FORCE_COLOR。
///   2. **优先用 Windows Terminal**：wt 会设置 WT_SESSION，真彩和 Nerd 字体都正常；
///      cmd + conhost 在部分环境下会被 Claude Code 判定为"不支持颜色"。
pub fn open_resume_at(dir: &std::path::Path, source: &str, id: &str) -> std::io::Result<()> {
    let (agent, flag): (&str, &str) = match source {
        "codex" => ("codex", "resume"),
        "omp" => ("omp", "--resume"),
        _ => ("claude", "--resume"),
    };
    run_in_terminal(dir, &[agent, flag, id])
}

/// 在 `dir` 里新开一个终端跑 `claude <args…>`，用于「新建对话」。
pub fn new_claude_session(dir: &std::path::Path, name: &str, prompt: Option<&str>) -> std::io::Result<()> {
    let mut args: Vec<&str> = vec!["claude"];
    if !name.trim().is_empty() {
        args.push("--name");
        args.push(name.trim());
    }
    if let Some(p) = prompt.map(str::trim).filter(|p| !p.is_empty()) {
        args.push(p);
    }
    run_in_terminal(dir, &args)
}

/// 打开一个终端窗口，argv 直接跟在 `cmd /k` 后面。
///
/// 两个细节决定了"有没有颜色"：
///   1. **清掉 NO_COLOR**：GUI 进程继承启动它的 shell 的环境，一旦里面有
///      NO_COLOR=1，claude 就整场不上色；顺手补 TERM/COLORTERM/FORCE_COLOR。
///   2. **优先 Windows Terminal**：wt 会设 WT_SESSION，真彩和 Nerd 字体都正常。
pub fn run_in_terminal(dir: &std::path::Path, argv: &[&str]) -> std::io::Result<()> {
    let mut command = if let Some(wt) = wt_exe() {
        // `-w 0 nt`：有窗口就在里面开个标签页，没有就新建；比每次起新窗口快
        let mut c = std::process::Command::new(wt);
        c.args(["-w", "0", "nt", "-d"]).arg(dir).args(["cmd", "/k"]).args(argv);
        c
    } else {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "start", ""]).arg("/D").arg(dir).args(["cmd", "/k"]).args(argv);
        c
    };

    command
        .env_remove("NO_COLOR")
        .env("FORCE_COLOR", "1")
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .current_dir(dir)
        .spawn()
        .map(|_| ())
}

pub fn truncate(s: &str, max: usize) -> String {    let s = s.replace(['\r', '\n'], " ");
    let trimmed = s.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}…")
}

pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
