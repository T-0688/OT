//! Threshold rules for the background guard. Stateless per event batch, with the
//! little bit of memory that rules need (turn cost, failure streak, cooldowns).

use crate::config::{resolve, ModelEntry};
use crate::sessions::Ev;
use crate::watch::{Polled, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub struct Alert {
    pub level: Level,
    pub title: String,
    pub body: String,
}

const COOLDOWN_SECS: i64 = 600;

fn cooling(state: &mut State, key: &str) -> bool {
    let now = chrono::Utc::now().timestamp();
    if let Some(last) = state.alerted.get(key) {
        if now - *last < COOLDOWN_SECS {
            return true;
        }
    }
    state.alerted.insert(key.to_string(), now);
    false
}

fn fmt_cost(state: &State, cost: f64) -> String {
    crate::fmt_cost(cost, &state.settings.currency)
}

pub fn evaluate(state: &mut State, polled: &[Polled], models: &[ModelEntry]) -> Vec<Alert> {
    if state.settings.paused {
        return Vec::new();
    }
    let mut alerts = Vec::new();

    for batch in polled {
        let sid = batch.session_id.clone();
        for ev in &batch.events {
            match ev {
                Ev::Usage { model, cost, tokens, stop, .. } => {
                    let running = state.turn_cost.entry(sid.clone()).or_insert(0.0);
                    *running += *cost;

                    if stop != "toolUse" {
                        let turn_total = *running;
                        *running = 0.0;
                        if state.settings.notify_turn_end && turn_total > 0.0 {
                            alerts.push(Alert {
                                level: Level::Info,
                                title: "一轮结束".into(),
                                body: format!(
                                    "{} · {} · {} tok",
                                    crate::truncate(&sid, 8),
                                    fmt_cost(state, turn_total),
                                    crate::fmt_tokens(*tokens)
                                ),
                            });
                        }
                        if state.settings.budget_per_turn > 0.0
                            && turn_total >= state.settings.budget_per_turn
                            && !cooling(state, &format!("budget:{sid}"))
                        {
                            alerts.push(Alert {
                                level: Level::Warn,
                                title: "单轮超预算".into(),
                                body: format!(
                                    "{} spent {} on one turn (limit {})",
                                    crate::truncate(&sid, 8),
                                    fmt_cost(state, turn_total),
                                    fmt_cost(state, state.settings.budget_per_turn)
                                ),
                            });
                        }
                    }

                    if let Some(flash) = check_context(state, models, model, *tokens) {
                        alerts.push(flash);
                    }
                }
                Ev::ToolFail { name, text, .. } => {
                    state.fail_streak += 1;
                    if state.fail_streak >= state.settings.max_failures
                        && !cooling(state, &format!("fail:{sid}"))
                    {
                        alerts.push(Alert {
                            level: Level::Error,
                            title: format!("连续 {} 次工具失败", state.fail_streak),
                            body: format!("最近一次：{} — {}", name, crate::truncate(text, 120)),
                        });
                    }
                }
                Ev::Tool { ok: true, .. } => {
                    state.fail_streak = 0;
                }
                Ev::Compact { .. } => {
                    alerts.push(Alert {
                        level: Level::Warn,
                        title: "上下文已压缩".into(),
                        body: format!("{} 归档了旧轮次，看一眼摘要", crate::truncate(&sid, 8)),
                    });
                }
                Ev::Exit { reason, .. } => {
                    if state.settings.notify_finish {
                        alerts.push(Alert {
                            level: Level::Info,
                            title: "会话结束".into(),
                            body: format!("{}（{}）", crate::truncate(&sid, 8), reason),
                        });
                    }
                }
                _ => {}
            }
        }
    }

    alerts
}

fn check_context(state: &mut State, models: &[ModelEntry], model: &str, prompt_tokens: u64) -> Option<Alert> {
    if prompt_tokens == 0 {
        return None;
    }
    let entry = resolve(models, model);
    let window = entry.map(|e| e.context_window).unwrap_or(0);
    if window == 0 {
        return None;
    }
    let ratio = prompt_tokens as f64 / window as f64;
    if ratio < state.settings.context_pct {
        return None;
    }
    let key = format!("ctx:{model}");
    if cooling(state, &key) {
        return None;
    }
    Some(Alert {
        level: Level::Warn,
        title: "上下文快满了".into(),
        body: format!(
            "{} / {}（{:.0}%），agent 很快会压缩",
            crate::fmt_tokens(prompt_tokens),
            crate::fmt_tokens(window),
            ratio * 100.0
        ),
    })
}
