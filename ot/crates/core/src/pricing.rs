//! 自己填的价目表：多少钱 / 百万 token。
//!
//! 存在每个 provider 的 `prices` 里（key 是模型名，`*` 表示该供应商的兜底价）。
//! 转录里已经带真实金额的（Claude Code 的 cost-state、omp 的 model_usage）不动；
//! 只有**没记金额**的调用（Codex 全都没有）才按这张表估算，并且一律按"≈"显示。

use serde::{Deserialize, Serialize};

use crate::providers::Store;
use crate::sessions::{Session, UsageRec};

/// 谷时价（可选）。DeepSeek 是"空闲时段 = 高峰时段的一半"，
/// 但不同厂商结构可能不同，所以这里存的是绝对值，不是折扣系数。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct OffPeak {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Price {
    /// 每百万 input token（高峰时段价；不分峰谷时就是唯一价）
    pub input: f64,
    /// 每百万 output token
    pub output: f64,
    /// 每百万 cache-read token（留 0 就按 input 价算，不额外折价）
    #[serde(default)]
    pub cache_read: f64,
    /// 谷时价；None 表示这家不分峰谷
    #[serde(default)]
    pub off: Option<OffPeak>,
}

/// 北京时间的高峰时段：周一至周五 9:00-12:00、14:00-18:00。
/// 周末和法定节假日全天都是空闲时段——节假日没有日历数据，这里按工作日算，
/// 也就是说节假日会被当成高峰，估算偏高而不是偏低。
pub fn is_peak(ts: chrono::DateTime<chrono::Utc>) -> bool {
    use chrono::{Datelike, Timelike};
    let local = ts.with_timezone(&chrono::Local);
    let weekday = local.weekday().num_days_from_monday();
    if weekday >= 5 {
        return false; // 周六周日
    }
    let h = local.hour();
    (9..12).contains(&h) || (14..18).contains(&h)
}

impl Price {
    pub fn is_zero(&self) -> bool {
        self.input <= 0.0
            && self.output <= 0.0
            && self.cache_read <= 0.0
            && self.off.map(|o| o.input <= 0.0 && o.output <= 0.0 && o.cache_read <= 0.0).unwrap_or(true)
    }

    pub fn cost(&self, input: u64, output: u64, cache_read: u64) -> f64 {
        let m = 1_000_000.0;
        let cache_rate = if self.cache_read > 0.0 { self.cache_read } else { self.input };
        input as f64 / m * self.input
            + output as f64 / m * self.output
            + cache_read as f64 / m * cache_rate
    }

    /// 按调用时刻取实际生效的那一档。
    pub fn at(&self, ts: chrono::DateTime<chrono::Utc>) -> Price {
        let Some(off) = self.off else { return *self };
        if is_peak(ts) {
            return *self;
        }
        Price { input: off.input, output: off.output, cache_read: off.cache_read, off: None }
    }

    /// 按调用时刻计价（峰谷自动切换）。
    pub fn cost_at(&self, ts: chrono::DateTime<chrono::Utc>, input: u64, output: u64, cache_read: u64) -> f64 {
        self.at(ts).cost(input, output, cache_read)
    }
}

#[derive(Debug, Clone)]
struct Entry {
    app: String,
    /// 小写模型名；`*` 是兜底
    model: String,
    price: Price,
    /// 这档价用的是哪种货币（USD / CNY）
    currency: String,
}

#[derive(Debug, Clone, Default)]
pub struct Table {
    entries: Vec<Entry>,
}

impl Table {
    pub fn from_store(store: &Store) -> Self {
        let mut entries = Vec::new();
        for p in &store.profiles {
            for (model, price) in &p.prices {
                if price.is_zero() {
                    continue;
                }
                entries.push(Entry {
                    app: p.app.clone(),
                    model: model.trim().to_lowercase(),
                    price: *price,
                    currency: if p.currency.is_empty() { "USD".into() } else { p.currency.clone() },
                });
            }
        }
        Self { entries }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// usage 里的 provider（anthropic / openai / 供应商名）→ 先缩小到对应 app，再找模型。
    fn app_hint(provider: &str) -> Option<&'static str> {
        let p = provider.to_lowercase();
        if p.contains("anthropic") || p.contains("claude") {
            Some("claude")
        } else if p.contains("openai") || p.contains("codex") || p.contains("gpt") {
            Some("codex")
        } else {
            None
        }
    }

    pub fn lookup(&self, provider: &str, model: &str) -> Option<(Price, String)> {
        let model = model.trim().to_lowercase();
        let hint = Self::app_hint(provider);

        let pick = |pred: &dyn Fn(&Entry) -> bool| -> Option<(Price, String)> {
            if let Some(app) = hint {
                if let Some(e) = self.entries.iter().find(|e| e.app == app && pred(e)) {
                    return Some((e.price, e.currency.clone()));
                }
            }
            self.entries.iter().find(|e| pred(e)).map(|e| (e.price, e.currency.clone()))
        };

        // 1) 同名模型
        if let Some(p) = pick(&|e| e.model == model) {
            return Some(p);
        }
        // 2) 模型名互相包含（gpt-6-astra / gpt-6-astra[1m] 这类）
        if let Some(p) = pick(&|e| {
            e.model != "*" && !e.model.is_empty() && (model.contains(&e.model) || e.model.contains(&model))
        }) {
            return Some(p);
        }
        // 3) 该供应商的兜底价
        pick(&|e| e.model == "*")
    }

    /// 给没有金额的调用补上估算值。返回补了几条。
    pub fn apply(&self, sessions: &mut [Session]) -> usize {
        if self.entries.is_empty() {
            return 0;
        }
        let mut filled = 0usize;
        for s in sessions.iter_mut() {
            for u in s.usages.iter_mut() {
                if u.cost_exact {
                    continue;
                }
                let Some((price, currency)) = self.lookup(&u.provider, &u.model) else { continue };
                let cost = price.cost_at(u.ts, u.input, u.output, u.cache_read);
                if cost <= 0.0 {
                    continue;
                }
                if currency == "CNY" {
                    u.cost_cny = cost;
                } else {
                    u.cost = cost;
                }
                filled += 1;
            }
        }
        filled
    }
}

/// 单个会话也补一遍（详情页直接读一个会话时）。
pub fn apply_one(table: &Table, session: &mut Session) -> usize {
    if table.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    for u in session.usages.iter_mut() {
        if u.cost_exact {
            continue;
        }
        if let Some((price, currency)) = table.lookup(&u.provider, &u.model) {
            let cost = price.cost_at(u.ts, u.input, u.output, u.cache_read);
            if cost > 0.0 {
                if currency == "CNY" {
                    u.cost_cny = cost;
                } else {
                    u.cost = cost;
                }
                n += 1;
            }
        }
    }
    n
}

/// 给一条 usage 估个价（UI 里预览用）。
pub fn estimate(price: &Price, u: &UsageRec) -> f64 {
    price.cost_at(u.ts, u.input, u.output, u.cache_read)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Table {
        Table {
            entries: vec![
                Entry { app: "codex".into(), model: "gpt-6-astra".into(), price: Price { input: 1.0, output: 4.0, cache_read: 0.1, off: None }, currency: "USD".into() },
                Entry { app: "codex".into(), model: "*".into(), price: Price { input: 2.0, output: 8.0, cache_read: 0.0, off: None }, currency: "USD".into() },
                Entry { app: "claude".into(), model: "claude-sonnet-5".into(), price: Price { input: 3.0, output: 15.0, cache_read: 0.3, off: None }, currency: "USD".into() },
            ],
        }
    }

    #[test]
    fn matches_exact_then_suffix_then_fallback() {
        let t = table();
        let (exact, _cur) = t.lookup("openai", "gpt-6-astra").unwrap();
        assert!((exact.input - 1.0).abs() < 1e-9);

        // 带后缀的模型名也算命中同一档
        let (suffix, _) = t.lookup("openai", "gpt-6-astra[1m]").unwrap();
        assert!((suffix.input - 1.0).abs() < 1e-9);

        // 没单独定价的模型走该 app 的兜底
        let (fb, _) = t.lookup("openai", "gpt-5-unknown").unwrap();
        assert!((fb.input - 2.0).abs() < 1e-9);

        assert!(t.lookup("openai", "claude-sonnet-5").is_some(), "跨 app 也能兜到");
    }

    #[test]
    fn price_math_is_per_million() {
        let p = Price { input: 3.0, output: 15.0, cache_read: 0.3, off: None };
        let c = p.cost(1_000_000, 1_000_000, 0);
        assert!((c - 18.0).abs() < 1e-9);
        let c2 = p.cost(1_000_000, 0, 1_000_000);
        assert!((c2 - 3.3).abs() < 1e-9);
    }

    #[test]
    fn peak_window_is_weekday_business_hours() {
        use chrono::TimeZone;
        // 2026-11-02 是周一
        let mon_10 = chrono::Local.with_ymd_and_hms(2026, 11, 2, 10, 0, 0).unwrap().with_timezone(&chrono::Utc);
        let mon_13 = chrono::Local.with_ymd_and_hms(2026, 11, 2, 13, 0, 0).unwrap().with_timezone(&chrono::Utc);
        let mon_15 = chrono::Local.with_ymd_and_hms(2026, 11, 2, 15, 0, 0).unwrap().with_timezone(&chrono::Utc);
        let mon_19 = chrono::Local.with_ymd_and_hms(2026, 11, 2, 19, 0, 0).unwrap().with_timezone(&chrono::Utc);
        let sat_10 = chrono::Local.with_ymd_and_hms(2026, 11, 7, 10, 0, 0).unwrap().with_timezone(&chrono::Utc);
        assert!(is_peak(mon_10), "工作日 10 点是高峰");
        assert!(!is_peak(mon_13), "午休算空闲");
        assert!(is_peak(mon_15), "工作日 15 点又是高峰");
        assert!(!is_peak(mon_19), "晚上算空闲");
        assert!(!is_peak(sat_10), "周末全天空闲");
    }

    #[test]
    fn off_peak_price_applies_by_hour() {
        use chrono::{TimeZone, Utc};
        let p = Price {
            input: 2.0,
            output: 8.0,
            cache_read: 0.04,
            off: Some(OffPeak { input: 1.0, output: 4.0, cache_read: 0.02 }),
        };
        let peak = Local_utc(2026, 11, 2, 10);
        let off = Local_utc(2026, 11, 2, 22);
        // 1M 输入 + 1M 输出
        assert!((p.cost_at(peak, 1_000_000, 1_000_000, 0) - 10.0).abs() < 1e-9);
        assert!((p.cost_at(off, 1_000_000, 1_000_000, 0) - 5.0).abs() < 1e-9, "谷时正好一半");
        let _ = Utc::now();
    }

    fn Local_utc(y: i32, m: u32, d: u32, h: u32) -> chrono::DateTime<chrono::Utc> {
        use chrono::TimeZone;
        chrono::Local.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap().with_timezone(&chrono::Utc)
    }

    #[test]
    fn cache_read_zero_falls_back_to_input_rate() {
        let p = Price { input: 2.0, output: 8.0, cache_read: 0.0, off: None };
        let c = p.cost(0, 0, 1_000_000);
        assert!((c - 2.0).abs() < 1e-9);
    }
}
