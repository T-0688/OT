//! 供应商余额探针。
//!
//! 中转站普遍实现了同一套 `/v1/usage`：`GET {base}/v1/usage` + `Authorization: Bearer <key>`，
//! 返回里 `remaining` / `balance` / `quota.remaining` 是余额，`unit` 是币种。
//! 有的还会附带 `usage.today`（今天的实际花费）和 `daily_usage`（按天账单）。
//!
//! DeepSeek 官方是另一套：`GET /user/balance` → `balance_infos[0].total_balance`。

use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct Balance {
    pub amount: f64,
    pub unit: String,
    pub valid: bool,
    /// 供应商自己记的"今天花了多少"（有就显示，没有就 None）
    pub today_cost: Option<f64>,
    pub today_requests: Option<u64>,
    /// 这种探针打的是哪个地址（排查用）
    pub url: String,
}

fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// 中转站的 base 有时是 `https://host/anthropic`（Anthropic 兼容入口），
/// 但 `/v1/usage`、`/v1/models` 都在根上，所以这里把已知的兼容路径剥掉。
fn api_root(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/anthropic") {
        if let Some(o) = origin(base) {
            return format!("{o}/v1");
        }
    }
    if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1")
    }
}

fn get_json(url: &str, key: &str, timeout: u64) -> Result<serde_json::Value, String> {
    let resp = ureq::get(url)
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(Duration::from_secs(timeout))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => match code {
                401 | 403 => format!("HTTP {code}：这个 key 没有查余额的权限"),
                404 => "HTTP 404：这家没有 /v1/usage 接口".to_string(),
                c => format!("HTTP {c}"),
            },
            other => other.to_string(),
        })?;
    resp.into_json::<serde_json::Value>().map_err(|e| format!("返回不是 JSON：{e}"))
}

fn num_at(v: &serde_json::Value, path: &str) -> Option<f64> {
    let mut cur = v;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    cur.as_f64().or_else(|| cur.as_str().and_then(|s| s.parse().ok()))
}

fn str_at(v: &serde_json::Value, path: &str) -> Option<String> {
    let mut cur = v;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    cur.as_str().map(|s| s.to_string())
}

fn first_num(v: &serde_json::Value, paths: &[&str]) -> Option<f64> {
    paths.iter().find_map(|p| num_at(v, p))
}

/// 中转站那套 `/v1/usage`。
fn query_usage_api(base_url: &str, key: &str) -> Result<Balance, String> {
    if key.trim().is_empty() {
        return Err("没有 key".into());
    }
    let url = format!("{}/usage", api_root(base_url));
    let body = get_json(&url, key, 10)?;

    let amount = first_num(&body, &["remaining", "balance", "quota.remaining", "credits", "total_balance"])
        .ok_or_else(|| "返回里没有 remaining/balance".to_string())?;
    let unit = str_at(&body, "unit")
        .or_else(|| str_at(&body, "quota.unit"))
        .or_else(|| str_at(&body, "currency"))
        .unwrap_or_else(|| "USD".into());
    let valid = body
        .get("isValid")
        .or_else(|| body.get("is_active"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let today_cost = first_num(&body, &["usage.today.actual_cost", "usage.today.cost"]);
    let today_requests = num_at(&body, "usage.today.requests").map(|n| n as u64);

    Ok(Balance { amount, unit, valid, today_cost, today_requests, url })
}

fn query_deepseek(base_url: &str, key: &str) -> Result<Balance, String> {
    let origin = origin(base_url).ok_or_else(|| format!("看不懂的地址 {base_url}"))?;
    let url = format!("{origin}/user/balance");
    let body = get_json(&url, key, 10)?;
    let first = body
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "返回里没有 balance_infos".to_string())?;
    let amount = first
        .get("total_balance")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let unit = first.get("currency").and_then(|v| v.as_str()).unwrap_or("CNY").to_string();
    Ok(Balance { amount, unit, valid: true, today_cost: None, today_requests: None, url })
}

/// 自动挑协议：DeepSeek 官方走 /user/balance，其余按中转站的 /v1/usage。
pub fn query(base_url: &str, key: &str) -> Result<Balance, String> {
    query_with_currency(base_url, key, None)
}

/// `currency` 是供应商记录的币种（"CNY" / "USD" / None）。
/// one-api 那套接口字段名带 `_usd`，但实际单位跟站点一致，所以用这个提示纠正显示。
pub fn query_with_currency(base_url: &str, key: &str, currency: Option<&str>) -> Result<Balance, String> {
    if base_url.to_lowercase().contains("deepseek") {
        return query_deepseek(base_url, key);
    }
    match query_usage_api(base_url, key) {
        Ok(b) => Ok(b),
        // 米醋这类 one-api / new-api 部署没有 /v1/usage，
        // 但它们实现了 OpenAI 的 dashboard 计费接口，退回去再试一次。
        Err(e) => match dashboard_billing(base_url, key, currency) {
            Ok(b) => Ok(b),
            Err(_) => Err(e),
        },
    }
}

/// OpenAI 兼容的「额度 + 用量」接口（one-api / new-api 系中转站都实现了）：
///   `GET /v1/dashboard/billing/subscription` → `hard_limit_usd` 是**总额度**
///   `GET /v1/dashboard/billing/usage`        → `total_usage` 是**已用**，单位是分，
///                                             而且很多部署不认日期参数，返回的是累计值
/// 所以余额 = 总额度 − 已用/100（拿站点后台对过：70 − 14.61 = 55.39）。
fn dashboard_billing(base_url: &str, key: &str, currency: Option<&str>) -> Result<Balance, String> {
    if key.trim().is_empty() {
        return Err("没有 key".into());
    }
    let root = api_root(base_url);
    let sub_url = format!("{root}/dashboard/billing/subscription");
    let sub = get_json(&sub_url, key, 10)?;
    let limit = first_num(&sub, &["hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"])
        .ok_or_else(|| "返回里没有 hard_limit_usd".to_string())?;

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let used = get_json(
        &format!("{root}/dashboard/billing/usage?start_date={today}&end_date={today}"),
        key,
        10,
    )
    .ok()
    .and_then(|v| first_num(&v, &["total_usage"]))
    .map(|cents| cents / 100.0)
    .unwrap_or(0.0);

    let remaining = (limit - used).max(0.0);
    let unit = match currency {
        Some("CNY") => "CNY",
        Some("USD") => "USD",
        _ => "USD",
    }
    .to_string();

    Ok(Balance { amount: remaining, unit, valid: true, today_cost: None, today_requests: None, url: sub_url })
}

#[derive(Debug, Clone, Default)]
pub struct ModelStat {
    pub model: String,
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    pub cost: f64,
    /// 供应商实际扣的钱（有就用它，没有退回 cost）
    pub actual_cost: f64,
}

impl ModelStat {
    fn charged(&self) -> f64 {
        if self.actual_cost > 0.0 {
            self.actual_cost
        } else {
            self.cost
        }
    }

    /// 反推一档单价（$/百万 token）。
    ///
    /// 只有一个总金额、两个未知量，所以按"输出 ≈ 4 × 输入"折算：
    ///   charged = (input + cache_read + cache_write) × p + output × 4p
    /// 解出 p，再返回 (p, 4p)。缓存按输入价算（cache_read 填 0 时代码就是这么走的）。
    /// 这样算出来的两档单价代回去，总额刚好等于供应商的扣款。
    pub fn suggested(&self) -> Option<(f64, f64)> {
        let charged = self.charged();
        if charged <= 0.0 {
            return None;
        }
        let weight = (self.input + self.cache_read + self.cache_write) as f64 + 4.0 * self.output as f64;
        if weight <= 0.0 {
            return None;
        }
        let p = charged / weight * 1_000_000.0;
        Some((p, p * 4.0))
    }
}

/// 读这家 key 能用的模型：`GET {base}/v1/models`，兼容 `data[].id`、`models[].id`、`[ "id" ]`。
pub fn list_models(base_url: &str, key: &str) -> Result<Vec<String>, String> {
    if key.trim().is_empty() {
        return Err("没有 key".into());
    }
    let url = format!("{}/models", api_root(base_url));
    let body = get_json(&url, key, 10)?;

    let mut out: Vec<String> = Vec::new();
    let push = |v: &serde_json::Value, out: &mut Vec<String>| {
        if let Some(s) = v.as_str() {
            out.push(s.to_string());
        } else if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            out.push(id.to_string());
        } else if let Some(id) = v.get("model").and_then(|x| x.as_str()) {
            out.push(id.to_string());
        }
    };

    if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
        for it in arr {
            push(it, &mut out);
        }
    } else if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
        for it in arr {
            push(it, &mut out);
        }
    } else if let Some(arr) = body.as_array() {
        for it in arr {
            push(it, &mut out);
        }
    }

    out.retain(|s| !s.trim().is_empty());
    out.sort();
    out.dedup();
    if out.is_empty() {
        return Err("返回里没有模型列表".into());
    }
    Ok(out)
}

/// 读供应商自己记的按模型用量：`GET {base}/v1/usage` 里的 `model_stats`。
pub fn model_stats(base_url: &str, key: &str) -> Result<Vec<ModelStat>, String> {
    if key.trim().is_empty() {
        return Err("没有 key".into());
    }
    let url = format!("{}/usage", api_root(base_url));
    let body = get_json(&url, key, 15)?;
    let Some(arr) = body.get("model_stats").and_then(|v| v.as_array()) else {
        return Err("这家没有返回 model_stats".into());
    };
    let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let f = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let mut out = Vec::new();
    for it in arr {
        let model = it.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if model.is_empty() {
            continue;
        }
        out.push(ModelStat {
            model,
            requests: n(it, "requests"),
            input: n(it, "input_tokens"),
            output: n(it, "output_tokens"),
            cache_read: n(it, "cache_read_tokens"),
            cache_write: n(it, "cache_creation_tokens"),
            total: n(it, "total_tokens"),
            cost: f(it, "cost"),
            actual_cost: f(it, "actual_cost"),
        });
    }
    out.sort_by(|a, b| b.requests.cmp(&a.requests));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_remaining_and_today() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"balance":104.9,"remaining":104.94,"unit":"USD","isValid":true,
                "usage":{"today":{"actual_cost":1.25,"requests":7}}}"#,
        )
        .unwrap();
        assert_eq!(first_num(&body, &["remaining"]), Some(104.94));
        assert_eq!(first_num(&body, &["usage.today.actual_cost"]), Some(1.25));
        assert_eq!(num_at(&body, "usage.today.requests"), Some(7.0));
        assert_eq!(str_at(&body, "unit"), Some("USD".into()));
    }

    #[test]
    fn suggested_price_reproduces_the_bill() {
        // 米醋 gpt-6-astra 的实际数字（取个约数）：1.04e7 in / 3.8e5 out / 7.9e7 cache，扣 $68.93
        let s = ModelStat {
            model: "gpt-6-astra".into(),
            requests: 579,
            input: 10_383_627,
            output: 383_553,
            cache_read: 79_243_097,
            cache_write: 0,
            total: 90_010_277,
            cost: 229.76,
            actual_cost: 68.93,
        };
        let (pin, pout) = s.suggested().unwrap();
        // 代回去应该正好等于扣款
        let back = (s.input + s.cache_read) as f64 / 1e6 * pin + s.output as f64 / 1e6 * pout;
        assert!((back - 68.93).abs() < 0.01, "回算 {back}");
        assert!((pout - pin * 4.0).abs() < 1e-9);
    }

    #[test]
    fn falls_back_across_shapes() {
        let body: serde_json::Value =
            serde_json::from_str(r#"{"quota":{"remaining":"12.5","unit":"CNY"}}"#).unwrap();
        assert_eq!(first_num(&body, &["remaining", "quota.remaining"]), Some(12.5));
        assert_eq!(str_at(&body, "quota.unit"), Some("CNY".into()));
    }
}
