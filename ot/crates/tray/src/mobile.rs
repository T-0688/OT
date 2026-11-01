//! 手机端：OT 内置的 HTTP 服务。
//!
//! 手机不需要和电脑同一个 wifi 也能用：服务只监听本机，公网入口交给 frp / 隧道。
//! 所有请求都要带 token（`?token=…` 或 `X-OT-Token` 头），token 存在 state.json 里。
//!
//! 端点：
//!   GET  /                    手机页面（内嵌 HTML）
//!   GET  /api/sessions        会话列表
//!   GET  /api/session?id=…    单个会话的逐轮内容
//!   GET  /api/costs?days=30   花费汇总
//!   GET  /api/quota           余额（服务端缓存 60s）
//!   POST /api/send            远程发一条指令（`claude --resume <id> -p <文本>`）

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

use ot_core::sessions::ScanOpts;
use ot_core::source::{self, Source};

const PAGE: &str = include_str!("../ui/mobile.html");
const MANIFEST: &str = include_str!("../ui/manifest.webmanifest");
const SW: &str = include_str!("../ui/sw.js");
const ICON: &[u8] = include_bytes!("../icons/icon.png");

pub struct Config {
    pub port: u16,
    pub token: String,
}

pub fn token_path() -> std::path::PathBuf {
    ot_core::providers::store_path().parent().unwrap().join("mobile-token.txt")
}

/// 没有 token 就生成一个（32 位十六进制），存在 data 目录里。
pub fn ensure_token() -> String {
    let p = token_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        let s = s.trim().to_string();
        if s.len() >= 16 {
            return s;
        }
    }
    let mut bytes = [0u8; 16];
    // 不用额外依赖：拿系统时间和进程 id 凑种子，再混一个线性同余
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32;
    let mut x = seed | 1;
    for b in bytes.iter_mut() {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *b = (x >> 33) as u8;
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if let Some(dir) = ot_core::providers::store_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, &token);
    token
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(url_decode(v));
        }
    }
    None
}

fn json_response(v: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = v.to_string();
    Response::from_data(body.into_bytes()).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    )
}

fn html_response(body: &'static str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.as_bytes().to_vec()).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
    )
}

fn scans() -> Vec<ot_core::sessions::Session> {
    source::load(Source::Claude, ScanOpts { keep_events: false, text_cap: 4000 }).0
}

/// 转录文件两分钟内有写入 = 当作还在跑。
fn is_running(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|e| e.as_secs() < 120).unwrap_or(false))
        .unwrap_or(false)
}

/// 起一个后台线程跑服务；返回实际端口（0 表示随机分配）。
pub fn start(cfg: Config) -> std::io::Result<u16> {
    let server = Server::http(("0.0.0.0", cfg.port)).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::AddrInUse, format!("端口被占用：{e}"))
    })?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(cfg.port);
    let token = cfg.token.clone();
    let quota_cache: Arc<Mutex<Option<(Instant, Value)>>> = Arc::new(Mutex::new(None));

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let token = token.clone();
            let quota_cache = quota_cache.clone();
            std::thread::spawn(move || handle(request, &token, quota_cache));
        }
    });
    Ok(port)
}

fn handle(
    mut req: tiny_http::Request,
    token: &str,
    quota_cache: Arc<Mutex<Option<(Instant, Value)>>>,
) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    // 首页本身不需要 token：手机 App 里改不了地址和口令，页面会自己问一次。
    // 真正碰数据的接口照旧全部校验。
    let is_page = matches!(req.method(), &Method::Get) && (path == "/" || path == "/index.html");
    let q_token = query_param(&url, "token");
    let h_token = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-OT-Token"))
        .map(|h| h.value.as_str().to_string());
    let got = q_token.or(h_token).unwrap_or_default();
    if !is_page && got != token {
        let _ = req.respond(json_response(json!({ "error": "token 不对" })).with_status_code(401));
        return;
    }

    match (req.method(), path.as_str()) {
        (Method::Get, "/") => {
            let _ = req.respond(html_response(PAGE));
        }
        // PWA：让"添加到主屏幕"得到一个真正的 App 图标，不用装 APK
        (Method::Get, "/manifest.webmanifest") => {
            let _ = req.respond(
                Response::from_data(MANIFEST.as_bytes().to_vec()).with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"application/manifest+json"[..]).unwrap(),
                ),
            );
        }
        (Method::Get, "/icon.png") => {
            let _ = req.respond(
                Response::from_data(ICON.to_vec())
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap()),
            );
        }
        (Method::Get, "/sw.js") => {
            let _ = req.respond(
                Response::from_data(SW.as_bytes().to_vec()).with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"application/javascript"[..]).unwrap(),
                ),
            );
        }
        (Method::Get, "/api/sessions") => {
            let sessions = scans();
            let limit = query_param(&url, "limit")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(80);
            let list: Vec<Value> = sessions
                .iter()
                .take(limit)
                .map(|s| {
                    json!({
                        "id": s.id,
                        "project": s.project(),
                        "title": ot_core::truncate(&s.title, 120),
                        "cost": s.cost(),
                        "cost_cny": s.cost_cny(),
                        "tokens": s.tokens(),
                        "turns": s.usages.len(),
                        "tools": s.tool_count(),
                        "updated": s.end.or(s.start).map(|d| d.to_rfc3339()).unwrap_or_default(),
                        "running": is_running(&s.path),
                    })
                })
                .collect();
            let _ = req.respond(json_response(json!({ "sessions": list })));
        }
        (Method::Get, "/api/session") => {
            let Some(id) = query_param(&url, "id") else {
                let _ = req.respond(json_response(json!({ "error": "缺 id" })).with_status_code(400));
                return;
            };
            let found = source::find(Source::Claude, &id).ok().flatten();
            match found {
                Some(s) => {
                    let events: Vec<Value> = s
                        .events
                        .iter()
                        .map(|e| match e {
                            ot_core::sessions::Ev::User { ts, text } => json!({
                                "role": "user", "kind": "text", "text": text, "ts": ts.to_rfc3339()
                            }),
                            ot_core::sessions::Ev::Assistant { ts, text } => json!({
                                "role": "assistant", "kind": "text", "text": text, "ts": ts.to_rfc3339()
                            }),
                            ot_core::sessions::Ev::Tool { ts, name, target, ok, .. } => json!({
                                "role": "assistant", "kind": "tool",
                                "text": format!("{}{}", name, target.as_deref().map(|t| format!(" → {t}")).unwrap_or_default()),
                                "ok": ok, "ts": ts.to_rfc3339()
                            }),
                            ot_core::sessions::Ev::ToolFail { ts, name, text } => json!({
                                "role": "assistant", "kind": "tool",
                                "text": format!("{name} 失败：{text}"), "ok": false, "ts": ts.to_rfc3339()
                            }),
                            _ => return json!(null),
                        })
                        .filter(|v| !v.is_null())
                        .collect();
                    let _ = req.respond(json_response(json!({
                        "id": s.id,
                        "title": s.title,
                        "project": s.project(),
                        "cwd": s.cwd,
                        "running": is_running(&s.path),
                        "cost": s.cost(),
                        "cost_cny": s.cost_cny(),
                        "events": events,
                    })));
                }
                None => {
                    let _ = req.respond(json_response(json!({ "error": "没找到这个会话" })).with_status_code(404));
                }
            }
        }
        (Method::Get, "/api/costs") => {
            let days = query_param(&url, "days").and_then(|s| s.parse::<i64>().ok()).unwrap_or(30);
            let sessions = scans();
            let (total, tokens, calls, _exact) = ot_core::usage::total(&sessions);
            let total_cny: f64 = sessions.iter().map(|s| s.cost_cny()).sum();
            let by_day: Vec<Value> = ot_core::usage::by_day(&sessions, Some(days))
                .iter()
                .map(|b| json!({ "key": b.key, "cost": b.cost, "cost_cny": b.cost_cny, "tokens": b.tokens, "calls": b.calls }))
                .collect();
            let by_model: Vec<Value> = ot_core::usage::by_model(&sessions, Some(days))
                .iter()
                .map(|b| json!({ "key": b.key, "cost": b.cost, "cost_cny": b.cost_cny, "tokens": b.tokens, "calls": b.calls }))
                .collect();
            let _ = req.respond(json_response(json!({
                "days": days, "total": total, "total_cny": total_cny,
                "tokens": tokens, "calls": calls,
                "by_day": by_day, "by_model": by_model,
            })));
        }
        (Method::Get, "/api/quota") => {
            let fresh = {
                let c = quota_cache.lock().unwrap();
                c.as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(60)).map(|(_, v)| v.clone())
            };
            if let Some(v) = fresh {
                let _ = req.respond(json_response(v));
                return;
            }
            let store = ot_core::providers::load();
            let mut rows = Vec::new();
            for p in store.profiles.iter().filter(|p| p.app == "claude") {
                let cur = if p.currency.is_empty() { None } else { Some(p.currency.as_str()) };
                let bal = ot_core::balance::query_with_currency(&p.base_url, &p.api_key, cur);
                rows.push(match bal {
                    Ok(b) => json!({
                        "name": p.name,
                        "amount": b.amount,
                        "unit": b.unit,
                        "today": b.today_cost,
                        "current": store.current.get("claude") == Some(&p.id),
                    }),
                    Err(_) => json!({ "name": p.name, "error": true }),
                });
            }
            let v = json!({ "rows": rows });
            *quota_cache.lock().unwrap() = Some((Instant::now(), v.clone()));
            let _ = req.respond(json_response(v));
        }
        (Method::Post, "/api/send") => {
            let mut body = String::new();
            if req.as_reader().take(64 * 1024).read_to_string(&mut body).is_err() {
                let _ = req.respond(json_response(json!({ "error": "读不到请求体" })).with_status_code(400));
                return;
            }
            let Ok(v) = serde_json::from_str::<Value>(&body) else {
                let _ = req.respond(json_response(json!({ "error": "不是 JSON" })).with_status_code(400));
                return;
            };
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let prompt = v.get("prompt").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if id.is_empty() || prompt.trim().is_empty() {
                let _ = req.respond(json_response(json!({ "error": "id 和 prompt 都要填" })).with_status_code(400));
                return;
            }
            match run_remote(&id, &prompt) {
                Ok(out) => {
                    let _ = req.respond(json_response(json!({ "ok": true, "output": out })));
                }
                Err(e) => {
                    let _ = req.respond(json_response(json!({ "error": e })).with_status_code(500));
                }
            }
        }
        _ => {
            let _ = req.respond(json_response(json!({ "error": "没有这个接口" })).with_status_code(404));
        }
    }
}

/// 远程发一条：`claude --resume <id> -p <文本>`，把 stdout 原样返回。
fn run_remote(id: &str, prompt: &str) -> Result<String, String> {
    let out = std::process::Command::new("cmd")
        .args(["/c", "claude", "--resume", id, "-p", prompt])
        .env_remove("NO_COLOR")
        .env("TERM", "dumb")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("起不来 claude：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() && text.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("claude 退出码 {:?}：{}", out.status.code(), err.chars().take(300).collect::<String>()));
    }
    Ok(text)
}
