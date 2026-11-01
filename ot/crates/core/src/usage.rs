//! Cost / token aggregation across scanned sessions.

use std::collections::BTreeMap;

use crate::local_date;
use crate::sessions::{Session, UsageRec};

#[derive(Debug, Clone, Default)]
pub struct Bucket {
    pub key: String,
    pub cost: f64,
    pub cost_cny: f64,
    pub tokens: u64,
    pub calls: usize,
    pub exact: bool,
}

pub fn total(sessions: &[Session]) -> (f64, u64, usize, bool) {
    let mut cost = 0.0;
    let mut tokens = 0;
    let mut calls = 0;
    let mut exact = true;
    for s in sessions {
        cost += s.cost();
        tokens += s.tokens();
        calls += s.usages.len();
        exact &= s.cost_exact();
    }
    (cost, tokens, calls, exact)
}

fn push(buckets: &mut BTreeMap<String, Bucket>, key: impl Into<String>, u: &UsageRec) {
    let key = key.into();
    let b = buckets.entry(key.clone()).or_insert_with(|| Bucket {
        key,
        exact: true,
        ..Default::default()
    });
    b.cost += u.cost;
    b.cost_cny += u.cost_cny;
    b.tokens += u.total;
    b.calls += 1;
    b.exact &= u.cost_exact;
}

pub fn by_day(sessions: &[Session], days: Option<i64>) -> Vec<Bucket> {
    let cutoff = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
    let mut map = BTreeMap::new();
    for s in sessions {
        for u in &s.usages {
            if let Some(c) = cutoff {
                if u.ts < c {
                    continue;
                }
            }
            push(&mut map, local_date(u.ts), u);
        }
    }
    let mut v: Vec<Bucket> = map.into_values().collect();
    v.sort_by(|a, b| b.key.cmp(&a.key));
    v
}

pub fn by_project(sessions: &[Session], days: Option<i64>) -> Vec<Bucket> {
    let cutoff = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
    let mut map = BTreeMap::new();
    for s in sessions {
        for u in &s.usages {
            if let Some(c) = cutoff {
                if u.ts < c {
                    continue;
                }
            }
            push(&mut map, s.project(), u);
        }
    }
    let mut v: Vec<Bucket> = map.into_values().collect();
    v.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    v
}

pub fn by_model(sessions: &[Session], days: Option<i64>) -> Vec<Bucket> {
    let cutoff = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
    let mut map = BTreeMap::new();
    for s in sessions {
        for u in &s.usages {
            if let Some(c) = cutoff {
                if u.ts < c {
                    continue;
                }
            }
            push(&mut map, u.model.clone(), u);
        }
    }
    let mut v: Vec<Bucket> = map.into_values().collect();
    v.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    v
}

pub fn by_purpose(sessions: &[Session], days: Option<i64>) -> Vec<Bucket> {
    let cutoff = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
    let mut map = BTreeMap::new();
    for s in sessions {
        for u in &s.usages {
            if let Some(c) = cutoff {
                if u.ts < c {
                    continue;
                }
            }
            let key = if u.purpose.is_empty() { "(main)".to_string() } else { u.purpose.clone() };
            push(&mut map, key, u);
        }
    }
    let mut v: Vec<Bucket> = map.into_values().collect();
    v.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    v
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CacheStats {
    pub cache_read: u64,
    pub cache_write: u64,
    pub prompt_tokens: u64,
    pub calls: usize,
}

impl CacheStats {
    /// cache_read / (input + cache_read) — matches omp's own cacheRead metric.
    pub fn hit_rate(&self) -> f64 {
        let denom = self.prompt_tokens + self.cache_read;
        if denom == 0 {
            0.0
        } else {
            self.cache_read as f64 / denom as f64
        }
    }
}

pub fn cache_stats(sessions: &[Session], days: Option<i64>) -> CacheStats {
    let cutoff = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
    let mut st = CacheStats::default();
    for s in sessions {
        for u in &s.usages {
            if let Some(c) = cutoff {
                if u.ts < c {
                    continue;
                }
            }
            st.cache_read += u.cache_read;
            st.cache_write += u.cache_write;
            st.prompt_tokens += u.input;
            st.calls += 1;
        }
    }
    st
}

/// Per-day cost series, oldest → newest, for sparkline-ish output.
pub fn series(sessions: &[Session], days: i64) -> Vec<(String, f64)> {
    let mut v: Vec<(String, f64)> = by_day(sessions, Some(days))
        .into_iter()
        .map(|b| (b.key, b.cost))
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

#[derive(Debug, Clone)]
pub struct Latency {
    pub session_id: String,
    pub model: String,
    pub duration_ms: i64,
    pub ttft_ms: i64,
    pub tokens: u64,
    pub cost: f64,
    pub ts: chrono::DateTime<chrono::Utc>,
}

/// Slowest single model calls by wall-clock time.
pub fn slowest_calls(sessions: &[Session], n: usize) -> Vec<Latency> {
    let mut all: Vec<Latency> = Vec::new();
    for s in sessions {
        for u in &s.usages {
            if let Some(d) = u.duration_ms {
                all.push(Latency {
                    session_id: s.id.clone(),
                    model: u.model.clone(),
                    duration_ms: d,
                    ttft_ms: u.ttft_ms.unwrap_or(0),
                    tokens: u.total,
                    cost: u.cost,
                    ts: u.ts,
                });
            }
        }
    }
    all.sort_by_key(|l| std::cmp::Reverse(l.duration_ms));
    all.truncate(n);
    all
}

/// Average first-token latency per model — the number that decides "is this model
/// usable interactively", which omp's TUI only shows for the current turn.
pub fn ttft_by_model(sessions: &[Session]) -> Vec<(String, f64, f64, usize)> {
    let mut map: std::collections::BTreeMap<String, (i64, i64, usize)> = Default::default();
    for s in sessions {
        for u in &s.usages {
            let Some(ttft) = u.ttft_ms else { continue };
            let e = map.entry(u.model.clone()).or_insert((0, 0, 0));
            e.0 += ttft;
            e.1 += u.duration_ms.unwrap_or(0);
            e.2 += 1;
        }
    }
    let mut v: Vec<(String, f64, f64, usize)> = map
        .into_iter()
        .map(|(m, (ttft, dur, n))| {
            let n_f = n.max(1) as f64;
            (m, ttft as f64 / n_f, dur as f64 / n_f, n)
        })
        .collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v
}
