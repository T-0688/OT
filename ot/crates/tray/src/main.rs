#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! OT —— 一个窗口看完 Claude Code / Codex / omp 的会话、花费、供应商与守卫。
//!
//! 终端仍然是你自己的原生 Claude Code，OT 不接管它：
//!   * 只读转录 → 会话、调用、花费
//!   * 自己的 provider 表 → 切换、改模型（写 agent 自己的配置文件）
//!   * 托盘 + 通知 → 超预算、工具连败、跑完提醒

mod mobile;

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use ot_core::alerts::{self, Level};
use ot_core::balance;
use ot_core::providers;
use ot_core::sessions::{Ev, ScanOpts};
use ot_core::source::{self, Source};
use ot_core::usage;
use ot_core::watch;

struct AppState {
    watch: Mutex<watch::State>,
    latest: Mutex<Option<Snap>>,
    /// provider id → 上次成功查到的余额（查询失败时用它显示"上次"，避免整行消失）
    balances: Mutex<std::collections::HashMap<String, (f64, String)>>,
    /// 托盘上显示的余额文本，比如 "¥55.39"（后台线程每 5 分钟刷一次）
    balance_text: Mutex<String>,
}

// ------------------------------------------------------------------ 头部汇总

#[derive(Serialize, Clone)]
struct Snap {
    today: f64,
    week: f64,
    month: f64,
    tokens_today: u64,
    calls_today: usize,
    running: usize,
    fallbacks_today: usize,
    sessions_total: usize,
    provider_claude: String,
    provider_codex: String,
    live_claude: String,
    guard: watch::Settings,
}

fn week_start() -> String {
    use chrono::Datelike;
    let now = chrono::Local::now();
    let monday = now - chrono::Duration::days(now.weekday().num_days_from_monday() as i64);
    monday.format("%Y-%m-%d").to_string()
}

fn build_snap(state: &watch::State) -> Snap {
    let (sessions, _bad, _roots) = source::load(Source::Claude, ScanOpts { keep_events: false, text_cap: 0 });
    let today_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let days = usage::by_day(&sessions, Some(30));
    let today = days.iter().find(|b| b.key == today_key).cloned().unwrap_or_default();
    let week: f64 = days.iter().filter(|b| b.key >= week_start()).map(|b| b.cost).sum();
    let month: f64 = days.iter().map(|b| b.cost).sum();

    let cutoff = chrono::Utc::now() - chrono::Duration::hours(24);
    let fallbacks_today = sessions
        .iter()
        .flat_map(|s| s.models.iter())
        .filter(|m| (m.fallback || m.role.eq_ignore_ascii_case("fallback")) && m.ts >= cutoff)
        .count();

    let running = sessions
        .iter()
        .filter(|s| {
            std::fs::metadata(&s.path)
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map(|e| e.as_secs() < 120).unwrap_or(false))
                .unwrap_or(false)
        })
        .count();

    let store = providers::load();
    let name_of = |app: &str| {
        store
            .current_for(app)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "（未选）".into())
    };

    Snap {
        today: today.cost,
        week,
        month,
        tokens_today: today.tokens,
        calls_today: today.calls,
        running,
        fallbacks_today,
        sessions_total: sessions.len(),
        provider_claude: name_of("claude"),
        provider_codex: name_of("codex"),
        live_claude: providers::live_base_url("claude"),
        guard: state.settings.clone(),
    }
}

// ------------------------------------------------------------------ 会话

#[derive(Serialize, Clone)]
struct SessRow {
    id: String,
    source: String,
    project: String,
    title: String,
    cost: f64,
    cost_cny: f64,
    cost_exact: bool,
    tokens: u64,
    tools: usize,
    turns: usize,
    when: String,
    cwd: String,
    running: bool,
    fallback: usize,
}

#[tauri::command]
fn sessions(_source_arg: Option<String>, limit: Option<usize>, project: Option<String>) -> Vec<SessRow> {
    // 这个版本只跟 Claude Code 打交道
    let (mut all, _bad, _roots) = source::load(Source::Claude, ScanOpts { keep_events: false, text_cap: 0 });
    if let Some(p) = project.filter(|p| !p.trim().is_empty()) {
        let p = p.to_lowercase();
        all.retain(|s| s.project().to_lowercase().contains(&p) || s.title.to_lowercase().contains(&p));
    }
    all.truncate(limit.unwrap_or(200));
    all.into_iter()
        .map(|s| {
            let running = std::fs::metadata(&s.path)
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map(|e| e.as_secs() < 120).unwrap_or(false))
                .unwrap_or(false);
            SessRow {
                running,
                id: s.id.clone(),
                source: s.source.clone(),
                project: s.project(),
                title: ot_core::truncate(&s.title, 120),
                cost_cny: s.cost_cny(),
                cost: s.cost(),
                cost_exact: s.cost_exact(),
                tokens: s.tokens(),
                tools: s.tool_count(),
                turns: s.turns,
                when: ot_core::rel_time(s.end),
                cwd: s.cwd.clone(),
                fallback: s.fallbacks(),
            }
        })
        .collect()
}

#[derive(Serialize, Clone)]
struct ToolLine {
    name: String,
    target: String,
    dur: String,
    ok: bool,
}

#[derive(Serialize, Clone)]
struct TurnView {
    index: usize,
    when: String,
    user: String,
    replies: Vec<String>,
    tools: Vec<ToolLine>,
    cost: f64,
    tokens: u64,
    compacted: usize,
}

#[derive(Serialize, Clone)]
struct Detail {
    id: String,
    source: String,
    title: String,
    cwd: String,
    project: String,
    range: String,
    stats: String,
    file: String,
    size_mb: f64,
    turns: Vec<TurnView>,
    exit: Option<String>,
    models: Vec<String>,
    error: Option<String>,
}

fn empty_detail(id: String, error: Option<String>) -> Detail {
    Detail {
        id,
        source: String::new(),
        title: String::new(),
        cwd: String::new(),
        project: String::new(),
        range: String::new(),
        stats: String::new(),
        file: String::new(),
        size_mb: 0.0,
        turns: Vec::new(),
        exit: None,
        models: Vec::new(),
        error,
    }
}

#[tauri::command]
fn session_delete_plan(id: String) -> Result<ot_core::purge::Plan, String> {
    ot_core::purge::plan(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_delete(id: String) -> Result<usize, String> {
    ot_core::purge::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_detail(id: String) -> Detail {
    let found = match source::find(Source::Claude, &id) {
        Ok(s) => s,
        Err(e) => return empty_detail(id, Some(e.to_string())),
    };
    let Some(mut s) = found else {
        return empty_detail(id.clone(), Some(format!("没找到会话 {id}")));
    };
    let table = ot_core::pricing::Table::from_store(&providers::load());
    ot_core::pricing::apply_one(&table, &mut s);

    let mut turns: Vec<TurnView> = Vec::new();
    for ev in &s.events {
        match ev {
            Ev::User { ts, text } => turns.push(TurnView {
                index: turns.len() + 1,
                when: ot_core::local_time(*ts),
                user: text.clone(),
                replies: Vec::new(),
                tools: Vec::new(),
                cost: 0.0,
                tokens: 0,
                compacted: 0,
            }),
            Ev::Assistant { text, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.replies.push(text.clone());
                }
            }
            Ev::Tool { name, target, duration_ms, ok, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.tools.push(ToolLine {
                        name: name.clone(),
                        target: target.clone().unwrap_or_default(),
                        dur: duration_ms.map(ot_core::fmt_dur).unwrap_or_default(),
                        ok: *ok,
                    });
                }
            }
            Ev::Usage { cost, tokens, .. } => {
                if let Some(t) = turns.last_mut() {
                    t.cost += *cost;
                    t.tokens += *tokens;
                }
            }
            Ev::Compact { .. } => {
                if let Some(t) = turns.last_mut() {
                    t.compacted += 1;
                }
            }
            _ => {}
        }
    }

    let mut models: Vec<String> = s.usages.iter().map(|u| u.model.clone()).collect();
    models.sort();
    models.dedup();

    Detail {
        id: s.id.clone(),
        source: s.source.clone(),
        title: s.title.clone(),
        cwd: s.cwd.clone(),
        project: s.project(),
        range: format!(
            "{} → {}",
            s.start.map(ot_core::local_time).unwrap_or_default(),
            s.end.map(ot_core::local_time).unwrap_or_default()
        ),
        stats: format!(
            "{} 轮 · {} 次工具 · {} token · {} · 缓存 {}%",
            s.turns,
            s.tool_count(),
            ot_core::fmt_tokens(s.tokens()),
            ot_core::fmt_money(s.cost(), s.cost_exact(), "USD"),
            {
                let read: u64 = s.usages.iter().map(|u| u.cache_read).sum();
                let inp: u64 = s.usages.iter().map(|u| u.input).sum();
                if inp + read == 0 { 0 } else { (read as f64 / (inp + read) as f64 * 100.0) as u64 }
            }
        ),
        file: s.path.to_string_lossy().to_string(),
        size_mb: s.size as f64 / 1_048_576.0,
        turns,
        exit: s.exit.clone(),
        models,
        error: None,
    }
}

// ------------------------------------------------------------------ 花费

#[derive(Serialize, Clone)]
struct Bucket {
    key: String,
    cost: f64,
    cost_cny: f64,
    tokens: u64,
    calls: usize,
}

#[derive(Serialize, Clone)]
struct CostPayload {
    days: i64,
    range: String,
    total: f64,
    total_cny: f64,
    tokens: u64,
    calls: usize,
    cache_pct: f64,
    by_day: Vec<Bucket>,
    by_model: Vec<Bucket>,
    by_project: Vec<Bucket>,
}

fn to_buckets(v: Vec<usage::Bucket>) -> Vec<Bucket> {
    v.into_iter()
        .map(|b| Bucket { key: b.key, cost: b.cost, cost_cny: b.cost_cny, tokens: b.tokens, calls: b.calls })
        .collect()
}

/// 时间区间：今天 / 昨天 / 24 小时 / 7 天 / 30 天 / 全部。
/// 返回 (起点, 终点)，都是 UTC；终点 None 表示到此刻。
fn range_bounds(range: &str) -> (Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>) {
    use chrono::{Duration, Local, TimeZone, Utc};
    let now = Utc::now();
    let today0 = Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| Local.from_local_datetime(&d).single())
        .map(|d| d.with_timezone(&Utc));
    match range {
        "today" => (today0, None),
        "yesterday" => {
            let Some(start) = today0 else { return (None, None) };
            (Some(start - Duration::days(1)), Some(start))
        }
        "24h" => (Some(now - Duration::hours(24)), None),
        "7d" => (Some(now - Duration::days(7)), None),
        "30d" => (Some(now - Duration::days(30)), None),
        _ => (None, None),
    }
}

/// 时间落在 [start, end) 里吗？None 表示不设边界。
fn in_range(
    ts: chrono::DateTime<chrono::Utc>,
    start: Option<chrono::DateTime<chrono::Utc>>,
    end: Option<chrono::DateTime<chrono::Utc>>,
) -> bool {
    start.map(|t| ts >= t).unwrap_or(true) && end.map(|t| ts < t).unwrap_or(true)
}

/// 只留区间内的调用（克隆会话，按 usage 时间过滤）。
fn filter_sessions(
    sessions: Vec<ot_core::sessions::Session>,
    start: Option<chrono::DateTime<chrono::Utc>>,
    end: Option<chrono::DateTime<chrono::Utc>>,
) -> Vec<ot_core::sessions::Session> {
    sessions
        .into_iter()
        .filter_map(|mut s| {
            s.usages.retain(|u| in_range(u.ts, start, end));
            if s.usages.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .collect()
}

#[tauri::command]
fn costs(range: Option<String>) -> CostPayload {
    let range = range.unwrap_or_else(|| "30d".into());
    let (start, end) = range_bounds(&range);
    let (sessions, _bad, _roots) = source::load(Source::Claude, ScanOpts { keep_events: false, text_cap: 0 });
    let sessions = filter_sessions(sessions, start, end);
    let days = match range.as_str() {
        "today" | "yesterday" | "24h" => 1,
        "7d" => 7,
        "30d" => 30,
        _ => 3650,
    };
    let (total, tokens, calls, _exact) = usage::total(&sessions);
    let total_cny: f64 = sessions.iter().map(|s| s.cost_cny()).sum();
    let cache = usage::cache_stats(&sessions, None);
    CostPayload {
        days,
        range,
        total,
        total_cny,
        tokens,
        calls,
        cache_pct: cache.hit_rate() * 100.0,
        by_day: to_buckets(usage::by_day(&sessions, None)),
        by_model: to_buckets(usage::by_model(&sessions, None)),
        by_project: to_buckets(usage::by_project(&sessions, None)),
    }
}

// ------------------------------------------------------------------ 供应商

#[derive(Serialize, Clone)]
struct ProfileRow {
    id: String,
    app: String,
    name: String,
    base_url: String,
    key_masked: String,
    current: bool,
    models: Vec<(String, String)>,
    limit_daily: Option<f64>,
    limit_monthly: Option<f64>,
    local: bool,
    currency: String,
    /// (模型, 峰输入, 峰输出, 峰缓存, 谷输入, 谷输出, 谷缓存)
    prices: Vec<(String, f64, f64, f64, Option<f64>, Option<f64>, Option<f64>)>,
}

#[derive(Serialize, Clone)]
struct ProviderPayload {
    store_path: String,
    profiles: Vec<ProfileRow>,
    live_claude: String,
    live_codex: String,
}

#[tauri::command]
fn provider_list() -> ProviderPayload {
    let store = providers::load();
    let mut rows: Vec<ProfileRow> = store
        .profiles
        .iter()
        .filter(|p| p.app == "claude")
        .map(|p| ProfileRow {
            id: p.id.clone(),
            app: p.app.clone(),
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            key_masked: providers::mask(&p.api_key),
            current: store.current.get(&p.app) == Some(&p.id),
            models: p.models.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            limit_daily: p.limit_daily,
            limit_monthly: p.limit_monthly,
            local: providers::is_local(&p.base_url),
            currency: if p.currency.is_empty() { "USD".into() } else { p.currency.clone() },
            prices: p
                .prices
                .iter()
                .map(|(m, pr)| {
                    let off = pr.off;
                    (
                        m.clone(),
                        pr.input,
                        pr.output,
                        pr.cache_read,
                        off.map(|o| o.input),
                        off.map(|o| o.output),
                        off.map(|o| o.cache_read),
                    )
                })
                .collect(),
        })
        .collect();
    rows.sort_by(|a, b| a.app.cmp(&b.app).then(a.name.cmp(&b.name)));
    ProviderPayload {
        store_path: providers::store_path().to_string_lossy().to_string(),
        profiles: rows,
        live_claude: providers::live_base_url("claude"),
        live_codex: providers::live_base_url("codex"),
    }
}

#[tauri::command]
fn provider_use(id: String) -> Result<String, String> {
    let mut store = providers::load();
    let profile = store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("没找到 {id}"))?;
    let backups = providers::apply(&profile).map_err(|e| e.to_string())?;
    store.current.insert(profile.app.clone(), profile.id.clone());
    providers::save(&store).map_err(|e| e.to_string())?;
    let mut msg = format!("已切到 {} / {}", profile.app, profile.name);
    if !backups.is_empty() {
        msg.push_str(&format!("，备份 {} 个", backups.len()));
    }
    if providers::is_local(&profile.base_url) {
        msg.push_str("（地址是本机，代理停掉就断）");
    }
    Ok(msg)
}

/// 拉取这个供应商 key 能用的模型列表；同 origin 的另一把 key 也能兜底。
#[tauri::command]
fn provider_models(id: String) -> Result<Vec<String>, String> {
    let store = providers::load();
    let p = store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "没找到供应商".to_string())?;
    let origin = |u: &str| {
        u.split_once("://")
            .map(|(s, r)| format!("{s}://{}", r.split('/').next().unwrap_or(r)))
            .unwrap_or_default()
    };
    let mine = origin(&p.base_url);
    let mut keys: Vec<String> = vec![p.api_key.clone()];
    for other in store.profiles.iter() {
        if other.id != p.id && !other.api_key.trim().is_empty() && origin(&other.base_url) == mine {
            keys.push(other.api_key.clone());
        }
    }
    let mut last_err = String::from("没有 key");
    for k in keys {
        if k.trim().is_empty() {
            continue;
        }
        match balance::list_models(&p.base_url, &k) {
            Ok(mut list) => {
                // 已经配在角色上的模型也带上，免得下拉里看不到
                for v in p.models.values() {
                    if !v.trim().is_empty() && !list.iter().any(|x| x == v) {
                        list.push(v.clone());
                    }
                }
                for m in p.prices.keys() {
                    if m != "*" && !list.iter().any(|x| x == m) {
                        list.push(m.clone());
                    }
                }
                list.sort();
                list.dedup();
                return Ok(list);
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[derive(Serialize, Clone)]
struct ModelStatRow {
    model: String,
    requests: u64,
    tokens: u64,
    charged: f64,
    price_in: Option<f64>,
    price_out: Option<f64>,
}

/// 供应商自己记的按模型用量与扣款，用来反推单价。key 兜底逻辑同 provider_models。
#[tauri::command]
fn provider_stats(id: String) -> Result<Vec<ModelStatRow>, String> {
    let store = providers::load();
    let p = store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "没找到供应商".to_string())?;
    let origin = |u: &str| {
        u.split_once("://")
            .map(|(s, r)| format!("{s}://{}", r.split('/').next().unwrap_or(r)))
            .unwrap_or_default()
    };
    let mine = origin(&p.base_url);
    let mut keys: Vec<String> = vec![p.api_key.clone()];
    for other in store.profiles.iter() {
        if other.id != p.id && !other.api_key.trim().is_empty() && origin(&other.base_url) == mine {
            keys.push(other.api_key.clone());
        }
    }
    let mut last_err = String::from("没有 key");
    for k in keys {
        if k.trim().is_empty() {
            continue;
        }
        match balance::model_stats(&p.base_url, &k) {
            Ok(stats) => {
                return Ok(stats
                    .into_iter()
                    .map(|s| {
                        let charged = if s.actual_cost > 0.0 { s.actual_cost } else { s.cost };
                        let (price_in, price_out) = match s.suggested() {
                            Some((a, b)) => (Some(a), Some(b)),
                            None => (None, None),
                        };
                        ModelStatRow {
                            model: s.model,
                            requests: s.requests,
                            tokens: s.total,
                            charged,
                            price_in,
                            price_out,
                        }
                    })
                    .collect());
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[tauri::command]
fn provider_add(
    app: String,
    name: String,
    base_url: String,
    key: String,
    currency: Option<String>,
) -> Result<(), String> {
    if !providers::APPS.contains(&app.as_str()) {
        return Err("app 只能是 claude / codex".into());
    }
    if name.trim().is_empty() || base_url.trim().is_empty() {
        return Err("名字和地址都要填".into());
    }
    let mut store = providers::load();
    let profile = providers::Profile {
        id: providers::new_id(&app, &name),
        app,
        name,
        base_url,
        api_key: key,
        currency: match currency.as_deref() {
            Some("CNY") => "CNY".into(),
            _ => "USD".into(),
        },
        ..Default::default()
    };
    store.profiles.retain(|p| p.id != profile.id);
    store.profiles.push(profile);
    providers::save(&store).map_err(|e| e.to_string())
}

#[tauri::command]
fn provider_rm(id: String) -> Result<(), String> {
    let mut store = providers::load();
    store.profiles.retain(|p| p.id != id);
    for app in providers::APPS {
        if let Some(cur) = store.current.get(app) {
            if !store.profiles.iter().any(|p| &p.id == cur) {
                store.current.remove(app);
            }
        }
    }
    providers::save(&store).map_err(|e| e.to_string())
}

#[tauri::command]
fn provider_set_model(id: String, role: String, model: String) -> Result<(), String> {
    let mut store = providers::load();
    let Some(p) = store.profiles.iter_mut().find(|p| p.id == id) else {
        return Err("没找到这个供应商".into());
    };
    p.models.insert(role, model);
    let snapshot = p.clone();
    let is_current = store.current.get(&snapshot.app) == Some(&snapshot.id);
    providers::save(&store).map_err(|e| e.to_string())?;
    if is_current {
        providers::apply(&snapshot).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ------------------------------------------------------------------ 额度

#[derive(Serialize, Clone)]
struct QuotaRow {
    /// 用到这家的应用，例如 "claude/codex"
    apps: String,
    name: String,
    current: bool,
    today: f64,
    month: f64,
    calls: u64,
    limit_daily: Option<f64>,
    limit_monthly: Option<f64>,
    healthy: Option<bool>,
    balance: Option<String>,
    base_url: String,
    id: String,
    /// 这个供应商填了几条价目
    priced: usize,
}

#[derive(Serialize, Clone)]
struct QuotaPayload {
    from_ccswitch: bool,
    days: i64,
    total_today: f64,
    total_today_cny: f64,
    total_month: f64,
    total_month_cny: f64,
    window_cost: f64,
    window_cost_cny: f64,
    requests_today: u64,
    failed_today: u64,
    rows: Vec<QuotaRow>,
    /// 没有余额接口 / 查不了的数量（默认隐藏，只报个数）
    skipped: usize,
}

#[tauri::command]
fn quota(days: Option<i64>, live: Option<bool>, state: State<AppState>) -> QuotaPayload {
    let days = days.unwrap_or(30);
    // 余额默认就查：没人想看一堆查不了的占位行
    let live = live.unwrap_or(true);
    let store = providers::load();
    let (sessions, _bad, _roots) = source::load(Source::Claude, ScanOpts { keep_events: false, text_cap: 0 });

    let today_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let month_prefix = chrono::Local::now().format("%Y-%m").to_string();
    let by_day = usage::by_day(&sessions, Some(days));
    let total_today: f64 = by_day.iter().filter(|b| b.key == today_key).map(|b| b.cost).sum();
    let total_today_cny: f64 = by_day.iter().filter(|b| b.key == today_key).map(|b| b.cost_cny).sum();
    let total_month: f64 = by_day
        .iter()
        .filter(|b| b.key.starts_with(&month_prefix))
        .map(|b| b.cost)
        .sum();
    let total_month_cny: f64 = by_day
        .iter()
        .filter(|b| b.key.starts_with(&month_prefix))
        .map(|b| b.cost_cny)
        .sum();
    let window_cost: f64 = by_day.iter().map(|b| b.cost).sum();
    let window_cost_cny: f64 = by_day.iter().map(|b| b.cost_cny).sum();

    let today_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(chrono::Local)
        .single()
        .map(|d| d.with_timezone(&chrono::Utc));
    let mut requests_today = 0u64;
    for s in &sessions {
        for u in &s.usages {
            if let Some(start) = today_start {
                if u.ts >= start {
                    requests_today += 1;
                }
            }
        }
    }

    let mut rows: Vec<QuotaRow> = store
        .profiles
        .iter()
        .filter(|p| p.app == "claude")
        .map(|p| QuotaRow {
            apps: p.app.clone(),
            name: p.name.clone(),
            current: store.current.get(&p.app) == Some(&p.id),
            today: 0.0,
            month: 0.0,
            calls: 0,
            limit_daily: p.limit_daily,
            limit_monthly: p.limit_monthly,
            healthy: None,
            balance: None,
            base_url: p.base_url.clone(),
            id: p.id.clone(),
            priced: p.prices.len(),
        })
        .collect();

    let mut skipped = 0usize;
    if live {
        // 每家要试的 key：自己的，再加同 origin 的（同一家的另一把 key 也能查余额）
        let origin = |u: &str| {
            u.split_once("://")
                .map(|(s, r)| format!("{s}://{}", r.split('/').next().unwrap_or(r)))
                .unwrap_or_default()
        };
        let jobs: Vec<(usize, String, Vec<String>, String)> = rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let me = origin(&r.base_url);
                let mut keys: Vec<String> = Vec::new();
                for p in store.profiles.iter() {
                    if origin(&p.base_url) != me || p.api_key.trim().is_empty() {
                        continue;
                    }
                    if p.app == r.apps && p.name == r.name {
                        keys.insert(0, p.api_key.clone());
                    } else {
                        keys.push(p.api_key.clone());
                    }
                }
                (i, r.base_url.clone(), keys, store.profiles.iter().find(|p| p.name == r.name).map(|p| p.currency.clone()).unwrap_or_default())
            })
            .collect();

        // 并行查，总耗时 ≈ 最慢的一家，而不是加起来
        let results: Vec<(usize, Result<balance::Balance, String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .into_iter()
                .map(|(i, base, keys, currency)| {
                    scope.spawn(move || {
                        let mut last = String::from("没有 key");
                        let cur = if currency.is_empty() { None } else { Some(currency.as_str()) };
                        for k in keys {
                            match balance::query_with_currency(&base, &k, cur) {
                                Ok(b) => return (i, Ok(b)),
                                Err(e) => last = e,
                            }
                        }
                        (i, Err(last))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or((0, Err("线程挂了".into())))).collect()
        });

        let mut cache = state.balances.lock().unwrap();
        for (i, res) in results {
            if i >= rows.len() {
                continue;
            }
            match res {
                Ok(b) => {
                    let money = if b.unit == "CNY" {
                        format!("￥{:.2}", b.amount)
                    } else {
                        format!("${:.2}", b.amount)
                    };
                    let today = match b.today_cost {
                        Some(c) if c > 0.0 => format!(" · 今日 ${c:.2}"),
                        _ => String::new(),
                    };
                    let text = format!("{money}{today}{}", if b.valid { "" } else { "（已停用）" });
                    cache.insert(rows[i].id.clone(), (b.amount, text.clone()));
                    rows[i].balance = Some(text);
                }
                Err(e) => {
                    // 查不到但有上次的成功值 → 显示上次的，别让整行凭空消失
                    if let Some((_, text)) = cache.get(&rows[i].id) {
                        rows[i].balance = Some(format!("{text}（上次）"));
                    } else {
                        rows[i].balance = Some(format!("查询失败（{e}）"));
                    }
                }
            }
        }
        drop(cache);

        // 同一家供应商可能在 claude / codex 各配一条，额度页只按供应商展示
        let origin_of = |u: &str| {
            u.split_once("://")
                .map(|(s, r)| format!("{s}://{}", r.split('/').next().unwrap_or(r)))
                .unwrap_or_default()
        };
        let mut grouped: Vec<QuotaRow> = Vec::new();
        for r in rows.into_iter() {
            let hit = grouped.iter_mut().find(|g| {
                g.name.eq_ignore_ascii_case(&r.name) && origin_of(&g.base_url) == origin_of(&r.base_url)
            });
            match hit {
                Some(g) => {
                    if !g.apps.split('/').any(|a| a == r.apps) {
                        g.apps = format!("{}/{}", g.apps, r.apps);
                    }
                    g.current |= r.current;
                    if g.balance.is_none() {
                        g.balance = r.balance;
                    }
                    if g.limit_daily.is_none() {
                        g.limit_daily = r.limit_daily;
                    }
                    if g.limit_monthly.is_none() {
                        g.limit_monthly = r.limit_monthly;
                    }
                    g.priced = g.priced.max(r.priced);
                }
                None => grouped.push(r),
            }
        }
        rows = grouped;

        // 从来没有成功过的才隐藏（真没接口/没 key 的那种）
        rows.retain(|r| {
            let ok = r
                .balance
                .as_deref()
                .map(|b| !b.starts_with("查询失败"))
                .unwrap_or(false);
            if !ok {
                skipped += 1;
            }
            ok
        });
    } else {
        for r in rows.iter_mut() {
            r.balance = None;
        }
    }

    rows.sort_by(|a, b| b.current.cmp(&a.current).then(b.month.total_cmp(&a.month)));

    QuotaPayload {
        from_ccswitch: false,
        days,
        total_today,
        total_today_cny,
        total_month,
        total_month_cny,
        window_cost,
        window_cost_cny,
        requests_today,
        failed_today: 0,
        rows,
        skipped,
    }
}

#[tauri::command]
fn provider_set_price(
    id: String,
    model: String,
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    off_input: Option<f64>,
    off_output: Option<f64>,
    off_cache_read: Option<f64>,
) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空（用 * 表示该供应商的兜底价）".into());
    }
    if input < 0.0 || output < 0.0 || cache_read.unwrap_or(0.0) < 0.0 {
        return Err("价格不能是负数".into());
    }
    let mut store = providers::load();
    let Some(p) = store.profiles.iter_mut().find(|p| p.id == id) else {
        return Err("没找到这个供应商".into());
    };
    // 三个谷时价都给了才认为这家分峰谷
    let off = match (off_input, off_output) {
        (Some(i), Some(o)) if i > 0.0 || o > 0.0 => Some(ot_core::pricing::OffPeak {
            input: i.max(0.0),
            output: o.max(0.0),
            cache_read: off_cache_read.unwrap_or(0.0).max(0.0),
        }),
        _ => None,
    };
    p.prices.insert(model, ot_core::pricing::Price { input, output, cache_read: cache_read.unwrap_or(0.0), off });
    providers::save(&store).map_err(|e| e.to_string())
}

#[tauri::command]
fn provider_del_price(id: String, model: String) -> Result<(), String> {
    let mut store = providers::load();
    let Some(p) = store.profiles.iter_mut().find(|p| p.id == id) else {
        return Err("没找到这个供应商".into());
    };
    p.prices.remove(&model);
    providers::save(&store).map_err(|e| e.to_string())
}
// ------------------------------------------------------------------ 守卫 / 托盘

fn tooltip(snap: &Snap, balance: &str) -> String {
    let money = ot_core::fmt_cost(snap.today, &snap.guard.currency);
    let mut parts = vec!["OT".to_string()];

    let model = providers::live_model();
    if !model.is_empty() {
        parts.push(model);
    }
    parts.push(format!("今日 {money}"));
    if !balance.is_empty() {
        parts.push(format!("余额 {balance}"));
    }
    if snap.running > 0 {
        parts.push(format!("{} 个在跑", snap.running));
    }
    parts.join(" · ")
}

fn menu_for(app: &AppHandle, snap: Option<&Snap>, paused: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let cur = snap.map(|s| s.guard.currency.clone()).unwrap_or_else(|| "USD".into());
    let money = |v: f64| ot_core::fmt_cost(v, &cur);
    let today = MenuItem::with_id(
        app,
        "today",
        match snap {
            Some(s) => format!(
                "今日 {}   ·   {} 次调用 · {} token",
                money(s.today),
                s.calls_today,
                ot_core::fmt_tokens(s.tokens_today)
            ),
            None => "今日 —".into(),
        },
        false,
        None::<&str>,
    )?;
    let week = MenuItem::with_id(
        app,
        "week",
        match snap {
            Some(s) => format!("本周 {}   ·   近 30 天 {}", money(s.week), money(s.month)),
            None => "本周 —".into(),
        },
        false,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(
        app,
        "status",
        match snap {
            Some(s) => format!("{} 个在跑 · {} 个会话 · 降级 {}", s.running, s.sessions_total, s.fallbacks_today),
            None => "…".into(),
        },
        false,
        None::<&str>,
    )?;
    let prov = MenuItem::with_id(
        app,
        "prov",
        match snap {
            Some(s) => format!("claude {} · codex {}", s.provider_claude, s.provider_codex),
            None => String::new(),
        },
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "打开 OT…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        if paused { "恢复守卫" } else { "暂停守卫" },
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(app, "refresh", "刷新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[&today, &week, &status, &prov, &sep1, &open, &toggle, &refresh, &sep2, &quit, &sep3],
    )
}

fn recompute(app: &AppHandle) {
    let state = app.state::<AppState>();
    let guard_state = state.watch.lock().unwrap().clone();
    let snap = build_snap(&guard_state);
    *state.latest.lock().unwrap() = Some(snap.clone());
    if let Some(tray) = app.tray_by_id("main") {
        let balance = state.balance_text.lock().unwrap().clone();
        let _ = tray.set_tooltip(Some(tooltip(&snap, &balance)));
        if let Ok(menu) = menu_for(app, Some(&snap), snap.guard.paused) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    let _ = app.emit("snapshot", &snap);
}

fn notify(app: &AppHandle, level: Level, title: &str, body: &str) {
    let prefix = match level {
        Level::Info => "",
        Level::Warn => "⚠ ",
        Level::Error => "✖ ",
    };
    let _ = app.notification().builder().title(format!("{prefix}{title}")).body(body).show();
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Option<Snap> {
    let snap = state.latest.lock().unwrap().clone();
    snap
}

#[tauri::command]
fn refresh(app: AppHandle) -> Option<Snap> {
    recompute(&app);
    let state = app.state::<AppState>();
    let snap = state.latest.lock().unwrap().clone();
    snap
}

#[tauri::command]
fn save_guard(app: AppHandle, patch: serde_json::Value) -> Result<watch::Settings, String> {
    let state = app.state::<AppState>();
    let mut guard = state.watch.lock().unwrap();
    if let Some(v) = patch.get("budget_per_turn").and_then(|v| v.as_f64()) {
        guard.settings.budget_per_turn = v;
    }
    if let Some(v) = patch.get("cache_hit_min").and_then(|v| v.as_f64()) {
        guard.settings.cache_hit_min = v;
    }
    if let Some(v) = patch.get("context_pct").and_then(|v| v.as_f64()) {
        guard.settings.context_pct = v;
    }
    if let Some(v) = patch.get("max_failures").and_then(|v| v.as_u64()) {
        guard.settings.max_failures = v as u32;
    }
    if let Some(v) = patch.get("notify_turn_end").and_then(|v| v.as_bool()) {
        guard.settings.notify_turn_end = v;
    }
    if let Some(v) = patch.get("notify_finish").and_then(|v| v.as_bool()) {
        guard.settings.notify_finish = v;
    }
    if let Some(v) = patch.get("paused").and_then(|v| v.as_bool()) {
        guard.settings.paused = v;
    }
    if let Some(v) = patch.get("currency").and_then(|v| v.as_str()) {
        guard.settings.currency = v.to_uppercase();
    }
    let settings = guard.settings.clone();
    watch::save(&guard).map_err(|e| e.to_string())?;
    drop(guard);
    recompute(&app);
    Ok(settings)
}

#[derive(Serialize, Clone)]
struct NewSessionResult {
    dir: String,
}

/// 新建一个 Claude Code 会话：在选定目录里开终端，带上自定义名称和可选的首句。
#[tauri::command]
fn new_session(dir: String, name: String, prompt: Option<String>) -> Result<NewSessionResult, String> {
    let path = std::path::PathBuf::from(dir.trim());
    if dir.trim().is_empty() {
        return Err("先选一个工作目录".into());
    }
    if !path.is_dir() {
        return Err(format!("目录不存在：{}", path.display()));
    }
    ot_core::new_claude_session(&path, &name, prompt.as_deref()).map_err(|e| format!("打开终端失败：{e}"))?;
    Ok(NewSessionResult { dir: path.display().to_string() })
}

/// 系统自带的选目录对话框。
#[tauri::command]
fn pick_dir(start: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("选择工作目录");
    if let Some(s) = start.filter(|s| !s.trim().is_empty()) {
        if std::path::Path::new(&s).is_dir() {
            dialog = dialog.set_directory(s);
        }
    }
    dialog.pick_folder().map(|p| p.display().to_string())
}

#[tauri::command]
fn open_session(cwd: String, source_name: String, id: String) -> Result<(), String> {
    let (dir, _sub) = ot_core::resolve_cwd(&cwd);
    ot_core::open_resume_at(&dir, &source_name, &id).map_err(|e| format!("打开终端失败：{e}"))
}

#[tauri::command]
fn open_store_dir() -> Result<(), String> {
    let dir = providers::store_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn toggle_guard(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut guard = state.watch.lock().unwrap();
    guard.settings.paused = !guard.settings.paused;
    let _ = watch::save(&guard);
    drop(guard);
    recompute(app);
}

fn on_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "quit" => app.exit(0),
        "open" => show_main(app),
        "refresh" => recompute(app),
        "toggle" => toggle_guard(app),
        _ => {}
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // OT_TAB=cost|provider|quota|guard 可以直接开在某一页（截图/排查用）
    let start_tab = std::env::var("OT_TAB").unwrap_or_default();
    let live_default = std::env::var("OT_LIVE").map(|v| v == "1" || v == "true").unwrap_or(false);
    let init = format!(
        "window.__OT_TAB = {}; window.__OT_LIVE = {};",
        serde_json::to_string(&start_tab).unwrap_or_else(|_| "\"\"".into()),
        live_default
    );
    let _ = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("OT")
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .focused(true)
        .initialization_script(&init)
        .build();
}

/// 拿本机内网 IP：连一个外部地址看出口地址（不真的发包）。
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("223.5.5.5:80").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            watch: Mutex::new(watch::load()),
            latest: Mutex::new(None),
            balances: Mutex::new(std::collections::HashMap::new()),
            balance_text: Mutex::new(String::new()),
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            refresh,
            save_guard,
            sessions,
            session_detail,
            session_delete_plan,
            session_delete,
            costs,
            provider_list,
            provider_use,
            provider_models,
            provider_stats,
            provider_add,
            provider_rm,
            provider_set_model,
            provider_set_price,
            provider_del_price,
            quota,
            open_session,
            new_session,
            pick_dir,
            open_store_dir
        ])
        .on_window_event(|window, event| {
            // 点关闭不退出，收进托盘继续在后台跑（手机端要靠它）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // 后台刷余额：托盘上要显示"余额 xxx"
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    let store = providers::load();
                    if let Some(p) = store
                        .profiles
                        .iter()
                        .find(|p| p.app == "claude" && store.current.get("claude") == Some(&p.id))
                    {
                        let cur = if p.currency.is_empty() { None } else { Some(p.currency.as_str()) };
                        if let Ok(b) = balance::query_with_currency(&p.base_url, &p.api_key, cur) {
                            let text = if b.unit == "CNY" {
                                format!("¥{:.2}", b.amount)
                            } else {
                                format!("${:.2}", b.amount)
                            };
                            *handle.state::<AppState>().balance_text.lock().unwrap() = text;
                            recompute(&handle);
                        }
                    }
                    std::thread::sleep(Duration::from_secs(300));
                });
            }

            // 手机端：本机 7788，公网入口交给 frp/隧道；token 存在 data 目录
            let token = mobile::ensure_token();
            let port = std::env::var("OT_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(7788);
            match mobile::start(mobile::Config { port, token: token.clone() }) {
                Ok(p) => {
                    let ip = local_ip().unwrap_or_else(|| "127.0.0.1".into());
                    println!("手机端已启动：http://{ip}:{p}/?token={token}");
                }
                Err(e) => eprintln!("手机端没起来：{e}"),
            }

            let handle = app.handle().clone();
            recompute(&handle);
            let paused = handle.state::<AppState>().watch.lock().unwrap().settings.paused;
            let menu = menu_for(&handle, None, paused)?;
            TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?)
                .tooltip("OT")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(on_menu)
                .build(app)?;

            // 托盘图标左键 → 开窗口
            if let Some(tray) = app.tray_by_id("main") {
                let h = handle.clone();
                tray.on_tray_icon_event(move |_tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, button_state, .. } = event {
                        if button == tauri::tray::MouseButton::Left
                            && button_state == tauri::tray::MouseButtonState::Up
                        {
                            show_main(&h);
                        }
                    }
                });
            }

            // 启动就开窗（关掉窗口后仍驻留托盘）
            let open_app = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                show_main(&open_app);
            });

            // 守卫线程
            let guard_app = handle.clone();
            std::thread::spawn(move || {
                let mut last_save = std::time::Instant::now();
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    let state = guard_app.state::<AppState>();
                    let mut guard = match state.watch.lock() {
                        Ok(g) => g,
                        Err(_) => continue,
                    };
                    let polled = watch::poll_sources(&mut guard, &source::roots(Source::Claude));
                    if !polled.is_empty() {
                        let models = ot_core::config::load_models();
                        for a in alerts::evaluate(&mut guard, &polled, &models) {
                            notify(&guard_app, a.level, &a.title, &a.body);
                        }
                    }
                    if last_save.elapsed() > Duration::from_secs(20) {
                        let _ = watch::save(&guard);
                        last_save = std::time::Instant::now();
                    }
                }
            });

            // 头部数字
            let ui_app = handle.clone();
            std::thread::spawn(move || loop {
                recompute(&ui_app);
                std::thread::sleep(Duration::from_secs(20));
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("OT 启动失败");
}

#[cfg(test)]
mod tray_text_tests {
    use super::*;

    fn snap(today: f64, running: usize) -> Snap {
        Snap {
            today,
            week: today,
            month: today,
            tokens_today: 0,
            calls_today: 0,
            running,
            fallbacks_today: 0,
            sessions_total: 2,
            provider_claude: "Micu-国产".into(),
            provider_codex: String::new(),
            live_claude: String::new(),
            guard: watch::Settings { currency: "USD".into(), ..Default::default() },
        }
    }

    #[test]
    fn tooltip_has_model_usage_balance() {
        let t = tooltip(&snap(0.06, 0), "¥55.39");
        assert!(t.starts_with("OT · "), "开头是 OT：{t}");
        assert!(t.contains("今日 "), "要有用量：{t}");
        assert!(t.contains("余额 ¥55.39"), "要有余额：{t}");
    }

    #[test]
    fn tooltip_without_balance_is_short() {
        let t = tooltip(&snap(1.5, 2), "");
        assert!(t.contains("2 个在跑"), "要有在跑数量：{t}");
        assert!(!t.contains("余额"), "没余额就别占位：{t}");
    }
}
#[cfg(test)]
mod range_tests {
    use super::*;

    #[test]
    fn ranges_are_ordered_and_sane() {
        use chrono::Utc;
        let now = Utc::now();
        // 今天：起点是今天零点，终点到此刻
        let (s, e) = range_bounds("today");
        assert!(s.is_some() && e.is_none());
        assert!(s.unwrap() <= now);
        // 昨天：有起有终，且终点 = 今天零点
        let (s1, e1) = range_bounds("yesterday");
        assert!(s1.is_some() && e1.is_some());
        assert!(e1.unwrap() <= now);
        assert!(s1.unwrap() < e1.unwrap());
        // 24 小时：起点在 23~25 小时前之间
        let (s2, _) = range_bounds("24h");
        let hours = (now - s2.unwrap()).num_hours();
        assert!((23..=25).contains(&hours), "24h 起点偏差太大：{hours}h");
        // 7 天 / 30 天 / 全部
        assert!((now - range_bounds("7d").0.unwrap()).num_days() == 6);
        assert!((now - range_bounds("30d").0.unwrap()).num_days() == 29);
        assert!(range_bounds("all").0.is_none());
    }

    #[test]
    fn in_range_handles_bounds() {
        use chrono::{Duration, Utc};
        let now = Utc::now();
        // 无边界：永远在
        assert!(in_range(now, None, None));
        // 24 小时内：一小时内算，48 小时前不算
        let start = Some(now - Duration::hours(24));
        assert!(in_range(now - Duration::hours(1), start, None));
        assert!(!in_range(now - Duration::hours(48), start, None));
        // 昨天这种有起有终的：终点不含
        let s = Some(now - Duration::days(1));
        let e = Some(now);
        assert!(in_range(now - Duration::hours(12), s, e));
        assert!(!in_range(now, s, e));
    }
}
