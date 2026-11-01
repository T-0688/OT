//! 自己的 provider 库：替代 CC Switch 的「加/删/切 provider、改模型映射」。
//!
//! 存储：`%LOCALAPPDATA%\ot\providers.json`（明文 key，和 CC Switch 的做法一致）。
//! 切换 = 直接把选中的 provider 写进 agent 自己的配置文件，**不经过本地代理**：
//!
//!   claude → `~/.claude/settings.json` 的 `env`（base_url / token / 各角色模型）
//!   codex  → `~/.codex/config.toml` + `~/.codex/auth.json`
//!
//! 每次写入前备份到 `%LOCALAPPDATA%\ot\backup\`，写后重新读回来校验。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::fnv1a;

pub const APPS: [&str; 2] = ["claude", "codex"];
pub const ROLES: [&str; 5] = ["default", "sonnet", "opus", "haiku", "fable"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub app: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// 角色 → 模型（claude 用 sonnet/opus/haiku/fable/default）
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    /// codex 的原始 config.toml（从 CC Switch 导入时保留，切换时原样写入）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config: Option<String>,
    #[serde(default)]
    pub note: String,
    /// 日/月限额（美元）；CC Switch 卸载后这两个数就由 ot 自己保管
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_daily: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_monthly: Option<f64>,
    /// 自己填的价目：模型名 → 美元/百万 token；`*` 是这个供应商的兜底价
    /// 价目用哪种货币：USD / CNY（空 = USD，兼容老数据）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub currency: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prices: BTreeMap<String, crate::pricing::Price>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Store {
    pub version: u32,
    #[serde(default)]
    pub current: BTreeMap<String, String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl Default for Store {
    fn default() -> Self {
        Self { version: 1, current: BTreeMap::new(), profiles: Vec::new() }
    }
}

pub fn store_path() -> PathBuf {
    crate::local_app_dir().join("providers.json")
}

pub fn load() -> Store {
    let Ok(text) = std::fs::read_to_string(store_path()) else {
        return Store::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(store: &Store) -> Result<()> {
    let dir = crate::local_app_dir();
    std::fs::create_dir_all(&dir)?;

    // 这个文件里放着 key，任何写入前都留一份快照，出事能翻回来
    if store_path().exists() {
        let backup_dir = dir.join("backup");
        std::fs::create_dir_all(&backup_dir).ok();
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
        std::fs::copy(store_path(), backup_dir.join(format!("providers-{stamp}.json"))).ok();
    }
    let json = serde_json::to_string_pretty(store)? + "\n";
    let tmp = dir.join("providers.json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, store_path())?;
    Ok(())
}

pub fn new_id(app: &str, name: &str) -> String {
    let h = fnv1a(format!("{app}|{name}").as_bytes());
    format!("{app}-{h:x}")
}

impl Store {
    pub fn find(&self, name_or_id: &str) -> Option<&Profile> {
        let key = name_or_id.to_lowercase();
        self.profiles
            .iter()
            .find(|p| p.id.eq_ignore_ascii_case(name_or_id) || p.name.to_lowercase() == key)
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|p| p.name.to_lowercase().contains(&key))
            })
    }

    pub fn current_for(&self, app: &str) -> Option<&Profile> {
        let id = self.current.get(app)?;
        self.profiles.iter().find(|p| &p.id == id && p.app == app)
    }
}

/// 从 CC Switch 的库里把 provider 搬过来（一次性）。
pub fn import_from_ccswitch() -> Result<usize> {
    if !crate::ccswitch::available() {
        bail!("没找到 CC Switch 的数据库，没法导入");
    }
    let mut store = load();
    let raws = crate::ccswitch::raw_configs()?;
    let providers = crate::ccswitch::providers()?;
    let mut n = 0usize;
    for p in providers {
        if !APPS.contains(&p.app.as_str()) {
            continue;
        }
        if store.profiles.iter().any(|x| x.app == p.app && x.name == p.name) {
            continue;
        }
        let raw = raws.get(&(p.app.clone(), p.id.clone())).cloned().unwrap_or_default();
        let mut profile = profile_from_ccswitch(&p.app, &p.name, &raw);
        profile.limit_daily = p.limit_daily;
        profile.limit_monthly = p.limit_monthly;
        store.profiles.push(profile);
        n += 1;
    }
    // 当前选中的也带过来
    for p in crate::ccswitch::providers()? {
        if p.current && APPS.contains(&p.app.as_str()) {
            if let Some(hit) = store.profiles.iter().find(|x| x.app == p.app && x.name == p.name) {
                store.current.insert(p.app.clone(), hit.id.clone());
            }
        }
    }
    save(&store)?;
    Ok(n)
}

fn profile_from_ccswitch(app: &str, name: &str, raw: &str) -> Profile {
    let mut profile = Profile {
        id: new_id(app, name),
        app: app.to_string(),
        name: name.to_string(),
        ..Default::default()
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return profile;
    };
    if app == "claude" {
        if let Some(env) = v.get("env").and_then(|e| e.as_object()) {
            let get = |k: &str| env.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            profile.base_url = get("ANTHROPIC_BASE_URL");
            profile.api_key = {
                let t = get("ANTHROPIC_AUTH_TOKEN");
                if t.is_empty() { get("ANTHROPIC_API_KEY") } else { t }
            };
            for role in ROLES {
                let key = if role == "default" {
                    "ANTHROPIC_MODEL".to_string()
                } else {
                    format!("ANTHROPIC_DEFAULT_{}_MODEL", role.to_uppercase())
                };
                let val = get(&key);
                if !val.is_empty() {
                    profile.models.insert(role.to_string(), val);
                }
            }
        }
    } else {
        if let Some(k) = v.get("auth").and_then(|a| a.get("OPENAI_API_KEY")).and_then(|x| x.as_str()) {
            profile.api_key = k.to_string();
        }
        if let Some(cfg) = v.get("config").and_then(|x| x.as_str()) {
            profile.base_url = toml_first(cfg, "base_url");
            if let Some(m) = nontrivial(toml_first(cfg, "model")) {
                profile.models.insert("default".into(), m);
            }
            profile.codex_config = Some(cfg.to_string());
        }
        if let Some(first) = v
            .get("modelCatalog")
            .and_then(|m| m.get("models"))
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
        {
            profile.models.entry("default".into()).or_insert_with(|| first.to_string());
        }
    }
    profile
}

fn nontrivial(s: String) -> Option<String> {
    if s.is_empty() || s == "custom" || s == "magpie" {
        None
    } else {
        Some(s)
    }
}

/// 够用的 TOML 取值：第一处 `key = "value"`。
fn toml_first(text: &str, key: &str) -> String {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                return rest.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

pub fn claude_settings_path() -> PathBuf {
    crate::home().join(".claude").join("settings.json")
}

pub fn codex_dir() -> PathBuf {
    crate::home().join(".codex")
}

fn backup_path(tag: &str, ext: &str) -> PathBuf {
    let dir = crate::local_app_dir().join("backup");
    std::fs::create_dir_all(&dir).ok();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    dir.join(format!("{tag}-{stamp}.{ext}"))
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp = path.with_extension("ot-tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn strip_brackets(v: &str) -> String {
    v.split_once('[').map(|(h, _)| h.to_string()).unwrap_or_else(|| v.to_string())
}

/// 把 provider 写进 claude 的 settings.json（保留 statusLine / permissions 等其它字段）。
pub fn apply_claude(p: &Profile) -> Result<Vec<PathBuf>> {
    let path = claude_settings_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut json: serde_json::Value = serde_json::from_str(&text).context("settings.json 不是合法 JSON")?;
    if !json.is_object() {
        json = serde_json::json!({});
    }
    if json.get("env").map(|e| !e.is_object()).unwrap_or(false) {
        bail!("settings.json 的 env 不是对象，先手动处理");
    }
    if json.get("env").is_none() {
        json["env"] = serde_json::json!({});
    }

    json["env"]["ANTHROPIC_BASE_URL"] = serde_json::Value::String(p.base_url.clone());
    json["env"]["ANTHROPIC_AUTH_TOKEN"] = serde_json::Value::String(p.api_key.clone());
    // 直连时不能留 PROXY_MANAGED 这类占位符
    if let Some(obj) = json["env"].as_object_mut() {
        obj.remove("ANTHROPIC_API_KEY");
    }
    for role in ROLES {
        let Some(model) = p.models.get(role) else { continue };
        if role == "default" {
            json["env"]["ANTHROPIC_MODEL"] = serde_json::Value::String(model.clone());
        } else {
            let up = role.to_uppercase();
            json["env"][format!("ANTHROPIC_DEFAULT_{up}_MODEL")] = serde_json::Value::String(model.clone());
            json["env"][format!("ANTHROPIC_DEFAULT_{up}_MODEL_NAME")] =
                serde_json::Value::String(strip_brackets(model));
        }
    }

    let next = serde_json::to_string_pretty(&json)? + "\n";
    let mut backups = Vec::new();
    if path.exists() {
        let b = backup_path("claude-settings", "json");
        std::fs::write(&b, &text)?;
        backups.push(b);
    }
    atomic_write(&path, &next)?;

    // 读回来确认
    let after: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let got = after["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("");
    if got != p.base_url {
        bail!("写入后校验失败：base_url 是 {got}");
    }
    Ok(backups)
}

/// 把 provider 写进 codex 的 config.toml + auth.json。
pub fn apply_codex(p: &Profile) -> Result<Vec<PathBuf>> {
    let dir = codex_dir();
    let cfg_path = dir.join("config.toml");
    let auth_path = dir.join("auth.json");
    let mut backups = Vec::new();

    let current = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    let next = match &p.codex_config {
        Some(raw) if !raw.trim().is_empty() => raw.clone(),
        _ => patch_codex_toml(&current, p),
    };
    if !next.trim().is_empty() {
        if cfg_path.exists() {
            let b = backup_path("codex-config", "toml");
            std::fs::write(&b, &current)?;
            backups.push(b);
        }
        atomic_write(&cfg_path, &next)?;
    }

    let auth = serde_json::json!({ "OPENAI_API_KEY": p.api_key });
    if auth_path.exists() {
        let b = backup_path("codex-auth", "json");
        std::fs::copy(&auth_path, &b)?;
        backups.push(b);
    }
    atomic_write(&auth_path, &(serde_json::to_string_pretty(&auth)? + "\n"))?;

    Ok(backups)
}

/// 只改 base_url / model 两处，保留 [tui]、marketplaces 等其它段落。
fn patch_codex_toml(current: &str, p: &Profile) -> String {
    let mut lines: Vec<String> = if current.is_empty() {
        vec![
            "model_provider = \"custom\"".to_string(),
            "disable_response_storage = true".to_string(),
            String::new(),
            "[model_providers.custom]".to_string(),
            "name = \"custom\"".to_string(),
            "wire_api = \"responses\"".to_string(),
            "requires_openai_auth = true".to_string(),
        ]
    } else {
        current.lines().map(|l| l.to_string()).collect()
    };

    let mut seen_base = false;
    let mut in_provider = false;
    for line in lines.iter_mut() {
        let t = line.trim().to_string();
        let t = t.as_str();
        if t.starts_with('[') {
            in_provider = t.starts_with("[model_providers.");
        }
        if in_provider && t.starts_with("base_url") && t.contains('=') {
            *line = format!("base_url = \"{}\"", p.base_url);
            seen_base = true;
        }
        if !in_provider && t.starts_with("model ") && t.contains('=') {
            if let Some(m) = p.models.get("default") {
                *line = format!("model = \"{m}\"");
            }
        }
    }
    if !seen_base {
        let at = lines
            .iter()
            .position(|l| l.trim().starts_with("[model_providers."))
            .map(|i| i + 1)
            .unwrap_or(lines.len());
        lines.insert(at, format!("base_url = \"{}\"", p.base_url));
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

pub fn apply(p: &Profile) -> Result<Vec<PathBuf>> {
    match p.app.as_str() {
        "claude" => apply_claude(p),
        "codex" => apply_codex(p),
        other => bail!("暂不支持 app={other}（只做了 claude / codex）"),
    }
}

/// 把当前配置文件里的 base_url 读出来，用来判断「到底在用哪家」。
/// 当前 claude 实际用的模型（读 ~/.claude/settings.json 的 env）。
pub fn live_model() -> String {
    let Ok(text) = std::fs::read_to_string(claude_settings_path()) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return String::new();
    };
    for key in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"] {
        if let Some(m) = v["env"][key].as_str() {
            if !m.trim().is_empty() {
                return m.to_string();
            }
        }
    }
    String::new()
}

pub fn live_base_url(app: &str) -> String {
    match app {
        "claude" => {
            let Ok(text) = std::fs::read_to_string(claude_settings_path()) else {
                return String::new();
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                return String::new();
            };
            v["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("").to_string()
        }
        "codex" => {
            let Ok(text) = std::fs::read_to_string(codex_dir().join("config.toml")) else {
                return String::new();
            };
            toml_first(&text, "base_url")
        }
        _ => String::new(),
    }
}

pub fn is_local(url: &str) -> bool {
    url.contains("127.0.0.1") || url.contains("localhost") || url.contains("0.0.0.0")
}

pub fn mask(key: &str) -> String {
    if key.len() <= 12 {
        return "***".into();
    }
    format!("{}…{}", &key[..6], &key[key.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_only_base_url_and_model() {
        let current = "model_provider = \"custom\"\nmodel = \"old-model\"\n\n[model_providers.custom]\nname = \"x\"\nbase_url = \"https://old.example\"\n\n[tui]\nstatus_line = true\n";
        let p = Profile {
            app: "codex".into(),
            base_url: "https://new.example".into(),
            models: BTreeMap::from([("default".to_string(), "gpt-6".to_string())]),
            ..Default::default()
        };
        let out = patch_codex_toml(current, &p);
        assert!(out.contains("model = \"gpt-6\""));
        assert!(out.contains("base_url = \"https://new.example\""));
        assert!(out.contains("[tui]\nstatus_line = true"), "其它段落必须保留");
        assert!(!out.contains("old.example"));
    }

    #[test]
    fn inserts_base_url_when_missing() {
        let current = "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"x\"\n";
        let p = Profile { app: "codex".into(), base_url: "https://n.example".into(), ..Default::default() };
        let out = patch_codex_toml(current, &p);
        assert!(out.contains("base_url = \"https://n.example\""));
    }

    #[test]
    fn settings_merge_keeps_other_keys() {
        // 只测纯逻辑：json 合并后的 env 不应丢掉 statusLine 等字段
        let text = r#"{"env":{"FOO":"bar"},"statusLine":{"type":"command"}}"#;
        let mut json: serde_json::Value = serde_json::from_str(text).unwrap();
        json["env"]["ANTHROPIC_BASE_URL"] = serde_json::Value::String("https://x".into());
        assert_eq!(json["env"]["FOO"], "bar");
        assert_eq!(json["statusLine"]["type"], "command");
    }
}
