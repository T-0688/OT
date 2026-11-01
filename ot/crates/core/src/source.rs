//! Which transcript store(s) to read.
//!
//! `auto` prefers Claude Code when it has transcripts on this machine, because
//! that is the terminal agent `ot` is a sidecar for; otherwise it falls back to
//! omp. `all` merges both and labels every row.

use std::path::{Path, PathBuf};

use crate::claude;
use crate::codex;
use crate::sessions::{self, ScanOpts, Session};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Omp,
    Claude,
    Codex,
    All,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Omp => "omp",
            Source::Claude => "claude",
            Source::Codex => "codex",
            Source::All => "all",
        }
    }
}

pub fn parse(arg: &str) -> anyhow::Result<Source> {
    match arg.trim().to_ascii_lowercase().as_str() {
        "omp" | "pi" => Ok(Source::Omp),
        "claude" | "cc" | "claude-code" => Ok(Source::Claude),
        "codex" | "cx" => Ok(Source::Codex),
        "all" | "both" => Ok(Source::All),
        "auto" => Ok(detect()),
        other => anyhow::bail!("--source 只能是 auto|omp|claude|codex|all（收到 {other}）"),
    }
}

fn count_files(root: &Path) -> usize {
    if !root.exists() {
        return 0;
    }
    sessions::discover(root).len()
}

/// Prefer whichever agent actually has history here.
pub fn detect() -> Source {
    let cc = count_files(&claude::root());
    let omp = count_files(&crate::sessions_root());
    if cc > 0 && omp == 0 {
        Source::Claude
    } else if omp > 0 && cc == 0 {
        Source::Omp
    } else if cc >= omp && cc > 0 {
        Source::Claude
    } else {
        Source::Omp
    }
}

pub fn roots(source: Source) -> Vec<(&'static str, PathBuf)> {
    match source {
        Source::Omp => vec![("omp", crate::sessions_root())],
        // Claude 可能有多个目录：Windows 一份 + WSL 各发行版各一份
        Source::Claude => claude::roots().into_iter().map(|p| (claude::SOURCE, p)).collect(),
        Source::Codex => vec![(codex::SOURCE, codex::root())],
        Source::All => claude::roots()
            .into_iter()
            .map(|p| (claude::SOURCE, p))
            .chain(std::iter::once(("omp", crate::sessions_root())))
            .collect(),
    }
}

pub fn parse_file(label: &str, path: &Path, opts: ScanOpts) -> std::io::Result<Session> {
    match label {
        l if l == claude::SOURCE => claude::scan_file(path, opts),
        l if l == codex::SOURCE => codex::scan_file(path, opts),
        _ => sessions::scan_file(path, opts),
    }
}

pub fn files_in(label: &str, root: &Path) -> Vec<PathBuf> {
    match label {
        l if l == claude::SOURCE => claude::discover(root),
        l if l == codex::SOURCE => codex::discover(root),
        _ => sessions::discover(root),
    }
}

pub fn events_in(label: &str, lines: &[String], text_cap: usize) -> Vec<crate::sessions::Ev> {
    match label {
        l if l == claude::SOURCE => claude::events_from_lines(lines, text_cap),
        l if l == codex::SOURCE => codex::events_from_lines(lines, text_cap),
        _ => sessions::events_from_lines(lines, text_cap),
    }
}

pub fn load(source: Source, opts: ScanOpts) -> (Vec<Session>, usize, usize) {
    let mut all = Vec::new();
    let mut unreadable = 0usize;
    let mut roots_used = 0usize;
    for (label, root) in roots(source) {
        if !root.exists() {
            continue;
        }
        roots_used += 1;
        let (mut sessions, bad) = match label {
            l if l == claude::SOURCE => claude::load_all(&root, opts),
            l if l == codex::SOURCE => codex::load_all(&root, opts),
            _ => sessions::load_all_from(&root, opts),
        };
        unreadable += bad;
        all.append(&mut sessions);
    }
    all.sort_by_key(|s| std::cmp::Reverse(s.end));
    // 没记金额的调用（Codex 全都没有）按用户自己填的价目估算
    let table = crate::pricing::Table::from_store(&crate::providers::load());
    crate::pricing::Table::apply(&table, &mut all);
    (all, unreadable, roots_used)
}

pub fn find(source: Source, prefix: &str) -> anyhow::Result<Option<Session>> {
    let opts = ScanOpts { keep_events: true, text_cap: 4_000 };
    let prefix = prefix.trim().to_lowercase();
    if prefix.is_empty() {
        return Ok(None);
    }
    let mut hits: Vec<Session> = Vec::new();
    let mut loose: Vec<(&'static str, PathBuf)> = Vec::new();

    for (label, root) in roots(source) {
        if !root.exists() {
            continue;
        }
        let files = if label == claude::SOURCE {
            claude::discover(&root)
        } else {
            sessions::discover(&root)
        };
        for path in files {
            let stem = if label == codex::SOURCE {
                codex::id_from_filename(&path).to_lowercase()
            } else {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase()
            };
            if stem.starts_with(&prefix) {
                if let Ok(s) = parse_file(label, &path, opts) {
                    hits.push(s);
                }
            } else {
                loose.push((label, path));
            }
        }
    }

    if hits.is_empty() {
        for (label, path) in loose {
            let head = head_of(&path, 2048).to_lowercase();
            if !head.contains(&prefix) {
                continue;
            }
            if let Ok(s) = parse_file(label, &path, opts) {
                hits.push(s);
            }
        }
    }

    match hits.len() {
        0 => Ok(None),
        1 => Ok(hits.pop()),
        _ => {
            let ids: Vec<String> = hits
                .iter()
                .map(|s| format!("{:<8} {:<7} {}", &s.id[..8.min(s.id.len())], s.source, crate::truncate(&s.title, 40)))
                .collect();
            anyhow::bail!("前缀 '{prefix}' 匹配到多个会话：\n  {}", ids.join("\n  "))
        }
    }
}

fn head_of(path: &Path, bytes: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let n = f.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).to_string()
}
