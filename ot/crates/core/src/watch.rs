//! Incremental tailing state: per-file byte cursors, settings, and a small
//! polling loop the tray runs every couple of seconds.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::sessions::Ev;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Alert when a single turn costs more than this (in `currency`).
    pub budget_per_turn: f64,
    /// Alert when a call's cache hit rate falls below this (0..1) with a large prompt.
    pub cache_hit_min: f64,
    /// Alert after this many consecutive tool failures.
    pub max_failures: u32,
    /// Alert when prompt tokens reach this fraction of the model's context window.
    pub context_pct: f64,
    pub notify_turn_end: bool,
    pub notify_finish: bool,
    pub paused: bool,
    pub currency: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            budget_per_turn: 2.0,
            cache_hit_min: 0.15,
            max_failures: 3,
            context_pct: 0.85,
            notify_turn_end: true,
            notify_finish: true,
            paused: false,
            currency: "USD".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub cursors: BTreeMap<String, u64>,
    pub settings: Settings,
    /// alert key → unix seconds of the last emission (cooldown)
    pub alerted: BTreeMap<String, i64>,
    pub fail_streak: u32,
    pub turn_cost: BTreeMap<String, f64>,
    pub initialized: bool,
}

pub fn load() -> State {
    let path = crate::state_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return State::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(state: &State) -> std::io::Result<()> {
    let dir = crate::local_app_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(state)?;
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, dir.join("state.json"))?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Polled {
    pub path: String,
    pub source: String,
    pub session_id: String,
    pub events: Vec<Ev>,
}

/// Read everything appended since the last poll, across every configured store.
/// On the very first run we park the cursors at the end of each file so history is
/// not replayed as alerts.
pub fn poll(state: &mut State) -> Vec<Polled> {
    poll_sources(state, &crate::source::roots(crate::source::detect()))
}

pub fn poll_sources(state: &mut State, roots: &[(&'static str, std::path::PathBuf)]) -> Vec<Polled> {
    let mut out = Vec::new();
    let mut all_files: Vec<(&'static str, std::path::PathBuf)> = Vec::new();
    for (label, root) in roots {
        for path in crate::source::files_in(label, root) {
            all_files.push((label, path));
        }
    }

    if !state.initialized {
        for (_, path) in &all_files {
            let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            state.cursors.insert(path.to_string_lossy().to_string(), len);
        }
        state.initialized = true;
        return out;
    }

    for (label, path) in all_files {
        let key = path.to_string_lossy().to_string();
        let mut offset = *state.cursors.get(&key).unwrap_or(&0);
        let lines = match crate::sessions::read_new_lines(&path, &mut offset) {
            Ok(l) => l,
            Err(_) => continue,
        };
        state.cursors.insert(key.clone(), offset);
        if lines.is_empty() {
            continue;
        }
        let events = crate::source::events_in(label, &lines, 300);
        if events.is_empty() {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.rsplit_once('_').map(|(_, id)| id.to_string()))
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string()
            });
        out.push(Polled { path: key, source: label.to_string(), session_id, events });
    }
    out
}

pub fn rewind(state: &mut State) {
    state.cursors.clear();
    state.initialized = false;
    state.turn_cost.clear();
    state.fail_streak = 0;
}
