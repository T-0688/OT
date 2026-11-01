//! Read-only 集成 CC Switch（`~/.cc-switch/cc-switch.db`）。
//!
//! CC Switch 管的是「哪家 provider、什么 key、走不走本地代理」。它自己已经能把
//! provider 加/删/切做好，而且在 proxy 模式下还要维护 live-state 和契约，命令行
//! 去抢这件事没有意义。所以这里只做它做不了的那部分：**把它的额度、用量、请求
//! 记录搬到终端里**，全程 `SQLITE_OPEN_READ_ONLY`，一个字节都不写。

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

pub fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("OT_CCSWITCH_DB") {
        return PathBuf::from(p);
    }
    crate::home().join(".cc-switch").join("cc-switch.db")
}

pub fn available() -> bool {
    db_path().is_file()
}

fn open() -> Result<Connection> {
    let path = db_path();
    Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("打不开 CC Switch 数据库 {}", path.display()))
}

/// SQLite 是动态类型：金额列在这里有时是 TEXT（"21.6344136"）、有时是 REAL，
/// 用 Value 统一收口，否则 `get::<String>` 一失败就静默变成 0。
fn as_f64(v: rusqlite::types::Value) -> f64 {
    match v {
        rusqlite::types::Value::Integer(i) => i as f64,
        rusqlite::types::Value::Real(f) => f,
        rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn as_i64(v: rusqlite::types::Value) -> i64 {
    match v {
        rusqlite::types::Value::Integer(i) => i,
        rusqlite::types::Value::Real(f) => f as i64,
        rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
        _ => 0,
    }
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub id: String,
    pub app: String,
    pub name: String,
    pub current: bool,
    pub base_url: String,
    pub model: String,
    pub limit_daily: Option<f64>,
    pub limit_monthly: Option<f64>,
    pub healthy: Option<bool>,
    pub last_error: String,
}

#[derive(Debug, Clone, Default)]
pub struct Spend {
    pub today: f64,
    pub days30: f64,
    pub month: f64,
    pub requests: u64,
}

/// 从 settings_config 里把 base_url / 模型挖出来（claude 是 JSON env，codex 是 TOML 文本）。
fn endpoint_and_model(app: &str, raw: &str) -> (String, String) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if app.starts_with("claude") {
            if let Some(env) = v.get("env") {
                let get = |k: &str| env.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let base = get("ANTHROPIC_BASE_URL");
                let mut model = get("ANTHROPIC_MODEL");
                if model.is_empty() {
                    model = get("ANTHROPIC_DEFAULT_SONNET_MODEL");
                }
                return (base, model);
            }
        }
        if let Some(cfg) = v.get("config").and_then(|x| x.as_str()) {
            return (toml_value(cfg, "base_url"), toml_value(cfg, "model"));
        }
        if let Some(models) = v
            .get("modelCatalog")
            .and_then(|m| m.get("models"))
            .and_then(|m| m.as_array())
        {
            if let Some(first) = models.first().and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
                return (String::new(), first.to_string());
            }
        }
    }
    (String::new(), String::new())
}

/// 够用的 TOML 取值：找 `key = "value"` 的第一处。
fn toml_value(text: &str, key: &str) -> String {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim().trim_matches('"');
                if !rest.is_empty() {
                    return rest.to_string();
                }
            }
        }
    }
    String::new()
}

pub fn providers() -> Result<Vec<Provider>> {
    let con = open()?;
    let mut health: HashMap<(String, String), (bool, String)> = HashMap::new();
    if let Ok(mut stmt) = con.prepare("select provider_id, app_type, is_healthy, last_error from provider_health") {
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })?;
        for row in rows.flatten() {
            health.insert((row.1, row.0), (row.2 != "0" && !row.2.is_empty(), row.3));
        }
    }

    let mut stmt = con.prepare(
        "select id, app_type, name, is_current, settings_config, limit_daily_usd, limit_monthly_usd
         from providers order by app_type, sort_index",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, app, name, current, raw, lim_d, lim_m) = row;
        let (base_url, model) = endpoint_and_model(&app, &raw);
        let h = health.get(&(app.clone(), id.clone()));
        out.push(Provider {
            id: id.clone(),
            app: app.clone(),
            name,
            current: current != 0,
            base_url,
            model,
            limit_daily: lim_d.and_then(|s| s.parse::<f64>().ok()).filter(|v| *v > 0.0),
            limit_monthly: lim_m.and_then(|s| s.parse::<f64>().ok()).filter(|v| *v > 0.0),
            healthy: h.map(|x| x.0),
            last_error: h.map(|x| x.1.clone()).unwrap_or_default(),
        });
    }
    Ok(out)
}

/// 每个 provider 的今日 / 本月 / 近 30 天花费，来自 CC Switch 的日汇总表。
pub fn spend_by_provider() -> Result<HashMap<(String, String), Spend>> {
    let con = open()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let month_start = chrono::Local::now().format("%Y-%m-01").to_string();
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30)).format("%Y-%m-%d").to_string();

    let mut stmt = con.prepare(
        "select date, app_type, provider_id, round(sum(total_cost_usd), 6), sum(request_count)
         from usage_daily_rollups where date >= ?1 group by date, app_type, provider_id",
    )?;
    let rows = stmt.query_map([cutoff], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, rusqlite::types::Value>(3).unwrap_or(rusqlite::types::Value::Null),
            as_i64(r.get::<_, rusqlite::types::Value>(4).unwrap_or(rusqlite::types::Value::Null)),
        ))
    })?;

    let mut map: HashMap<(String, String), Spend> = HashMap::new();
    for (date, app, pid, cost, count) in rows.flatten() {
        let e = map.entry((app, pid)).or_default();
        let c = as_f64(cost);
        e.days30 += c;
        e.requests += count as u64;
        if date == today {
            e.today += c;
        }
        if date >= month_start {
            e.month += c;
        }
    }
    Ok(map)
}

#[derive(Debug, Clone)]
pub struct DayRow {
    pub date: String,
    pub app: String,
    pub provider_id: String,
    pub model: String,
    pub requests: u64,
    pub cost: f64,
}

pub fn daily(days: i64) -> Result<Vec<DayRow>> {
    let con = open()?;
    let cutoff = (chrono::Local::now() - chrono::Duration::days(days)).format("%Y-%m-%d").to_string();
    let mut stmt = con.prepare(
        "select date, app_type, provider_id, model, sum(request_count), round(sum(total_cost_usd), 6)
         from usage_daily_rollups where date >= ?1
         group by date, app_type, provider_id, model order by date desc",
    )?;
    let rows = stmt.query_map([cutoff], |r| {
        Ok(DayRow {
            date: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            app: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            provider_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            model: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            requests: as_i64(r.get::<_, rusqlite::types::Value>(4).unwrap_or(rusqlite::types::Value::Null)) as u64,
            cost: as_f64(r.get::<_, rusqlite::types::Value>(5).unwrap_or(rusqlite::types::Value::Null)),
        })
    })?;
    Ok(rows.flatten().collect())
}

#[derive(Debug, Clone)]
pub struct RequestRow {
    pub ts: i64,
    pub app: String,
    pub model: String,
    pub status: i64,
    pub latency_ms: i64,
    pub cost: f64,
    pub provider_id: String,
    pub error: String,
}

pub fn recent_requests(limit: usize) -> Result<Vec<RequestRow>> {
    let con = open()?;
    let mut stmt = con.prepare(
        "select created_at, app_type, model, status_code, latency_ms, total_cost_usd, provider_id, error_message
         from proxy_request_logs order by created_at desc limit ?1",
    )?;
    let rows = stmt.query_map([limit as i64], |r| {
        Ok(RequestRow {
            ts: as_i64(r.get::<_, rusqlite::types::Value>(0).unwrap_or(rusqlite::types::Value::Null)),
            app: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            model: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            status: as_i64(r.get::<_, rusqlite::types::Value>(3).unwrap_or(rusqlite::types::Value::Null)),
            latency_ms: as_i64(r.get::<_, rusqlite::types::Value>(4).unwrap_or(rusqlite::types::Value::Null)),
            cost: as_f64(r.get::<_, rusqlite::types::Value>(5).unwrap_or(rusqlite::types::Value::Null)),
            provider_id: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            error: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
        })
    })?;
    Ok(rows.flatten().collect())
}

/// 今日失败请求数 / 总数，给 `ot quota` 的健康一栏用。
pub fn today_request_stats() -> Result<(u64, u64)> {
    let con = open()?;
    let start = (chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(chrono::Local)
        .single()
        .map(|d| d.timestamp()))
        .unwrap_or(0);
    let mut stmt = con.prepare(
        "select count(*), sum(case when status_code >= 400 then 1 else 0 end)
         from proxy_request_logs where created_at >= ?1",
    )?;
    let row = stmt.query_row([start], |r| {
        Ok((
            as_i64(r.get::<_, rusqlite::types::Value>(0).unwrap_or(rusqlite::types::Value::Null)),
            as_i64(r.get::<_, rusqlite::types::Value>(1).unwrap_or(rusqlite::types::Value::Null)),
        ))
    })?;
    Ok((row.0 as u64, row.1 as u64))
}

/// 取这个 provider 的 API key（claude 是 env.ANTHROPIC_AUTH_TOKEN，codex 是 auth.OPENAI_API_KEY）。
pub fn provider_key(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    if let Some(k) = v.get("env").and_then(|e| e.get("ANTHROPIC_AUTH_TOKEN")).and_then(|x| x.as_str()) {
        return k.to_string();
    }
    if let Some(k) = v.get("env").and_then(|e| e.get("ANTHROPIC_API_KEY")).and_then(|x| x.as_str()) {
        return k.to_string();
    }
    v.get("auth")
        .and_then(|a| a.get("OPENAI_API_KEY"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// provider id → 原始 settings_config（`ot quota --live` 要用 key）。
pub fn raw_configs() -> Result<HashMap<(String, String), String>> {
    let con = open()?;
    let mut stmt = con.prepare("select app_type, id, settings_config from providers")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ))
    })?;
    let mut map = HashMap::new();
    for (app, id, raw) in rows.flatten() {
        map.insert((app, id), raw);
    }
    Ok(map)
}

/// 取 URL 的 scheme://host[:port]。
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// DeepSeek 的余额接口（`GET /user/balance`），返回 (金额, 币种)。
pub fn deepseek_balance(base_url: &str, key: &str) -> Result<(f64, String), String> {
    if key.is_empty() {
        return Err("没有 key".into());
    }
    let origin = origin(base_url).ok_or_else(|| format!("看不懂的地址 {base_url}"))?;
    let url = format!("{origin}/user/balance");
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(std::time::Duration::from_secs(8))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?;
    let body: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let infos = body.get("balance_infos").and_then(|v| v.as_array());
    let Some(first) = infos.and_then(|a| a.first()) else {
        return Err("返回里没有 balance_infos".into());
    };
    let total = first
        .get("total_balance")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let currency = first.get("currency").and_then(|v| v.as_str()).unwrap_or("CNY").to_string();
    Ok((total, currency))
}
