//! omp config.yml (model roles) and models.yml (price/context table).
//!
//! omp validates config.yml strictly and **skips the whole file** when it does not
//! parse, so every write here is: read → textual edit → YAML re-parse → verify the
//! role landed → backup the old file → atomic replace.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_yaml::Value;

pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const ROLES: [&str; 4] = ["default", "smol", "slow", "plan"];

/// `magpie/imported/gpt-6-astra:high` → ("magpie", "imported/gpt-6-astra", Some("high")).
///
/// The thinking level is a trailing `:<level>` only when `<level>` is a known
/// level word — model ids are allowed to contain dots and slashes.
pub fn split_model(spec: &str) -> (String, String, Option<String>) {
    let spec = spec.trim();
    let (body, level) = match spec.rsplit_once(':') {
        Some((b, l)) if THINKING_LEVELS.contains(&l.to_ascii_lowercase().as_str()) => {
            (b, Some(l.to_ascii_lowercase()))
        }
        _ => (spec, None),
    };
    match body.split_once('/') {
        Some((p, i)) => (p.to_string(), i.to_string(), level),
        None => (String::new(), body.to_string(), level),
    }
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[derive(Debug, Clone)]
pub struct Roles {
    pub map: BTreeMap<String, String>,
    pub text: String,
    pub path: PathBuf,
    pub hash: u64,
    pub exists: bool,
}

impl Roles {
    pub fn get(&self, role: &str) -> Option<&str> {
        self.map.get(role).map(|s| s.as_str())
    }
}

pub fn read_roles_at(path: &Path) -> Result<Roles> {
    let exists = path.exists();
    let text = if exists {
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?
    } else {
        String::new()
    };
    let hash = fnv1a(text.as_bytes());
    let mut map = BTreeMap::new();
    if !text.trim().is_empty() {
        let yaml: Value = serde_yaml::from_str(&text)
            .with_context(|| format!("{} is not valid YAML (omp would skip it entirely)", path.display()))?;
        if let Some(roles) = yaml.get("modelRoles").and_then(Value::as_mapping) {
            for (k, v) in roles {
                if let (Some(k), Some(v)) = (k.as_str(), v.as_str()) {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
    Ok(Roles { map, text, path: path.to_path_buf(), hash, exists })
}

pub fn read_roles() -> Result<Roles> {
    read_roles_at(&crate::config_path())
}

fn yaml_scalar(value: &str) -> String {
    let needs_quote = value.is_empty()
        || value.contains(char::is_whitespace)
        || value.contains('#')
        || value.starts_with(['&', '*', '!', '|', '>', '%', '@', '`', '"', '\'']);
    if needs_quote {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        value.to_string()
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Replace/insert one role inside the `modelRoles:` block without touching the rest.
fn edit_roles_text(text: &str, role: &str, value: Option<&str>) -> String {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let header = lines.iter().position(|l| l.trim_start().starts_with("modelRoles:"));

    let Some(h) = header else {
        if let Some(v) = value {
            let mut out = text.to_string();
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("modelRoles:\n");
            out.push_str(&format!("  {role}: {}\n", yaml_scalar(v)));
            return out;
        }
        return text.to_string();
    };

    let base = indent_of(&lines[h]);
    let child_indent = base + 2;
    let mut block_end = h + 1;
    while block_end < lines.len() {
        let line = &lines[block_end];
        if line.trim().is_empty() {
            block_end += 1;
            continue;
        }
        if indent_of(line) > base {
            block_end += 1;
        } else {
            break;
        }
    }

    let key_pos = (h + 1..block_end).find(|&i| {
        lines[i].trim_start().starts_with(&format!("{role}:")) && indent_of(&lines[i]) == child_indent
    });

    match (key_pos, value) {
        (Some(i), Some(v)) => {
            lines[i] = format!("{}{}: {}", " ".repeat(child_indent), role, yaml_scalar(v));
        }
        (Some(i), None) => {
            lines.remove(i);
        }
        (None, Some(v)) => {
            lines.insert(h + 1, format!("{}{}: {}", " ".repeat(child_indent), role, yaml_scalar(v)));
        }
        (None, None) => {}
    }

    let mut out = lines.join("\n");
    if text.ends_with('\n') || !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

pub fn backup_dir() -> PathBuf {
    crate::local_app_dir().join("backup")
}

pub fn set_role_at(path: &Path, role: &str, value: Option<&str>, expected_hash: Option<u64>) -> Result<PathBuf> {
    if !ROLES.contains(&role) {
        bail!("role must be one of {:?}", ROLES);
    }
    if let Some(v) = value {
        if v.trim().is_empty() {
            bail!("model value cannot be empty");
        }
        let (provider, id, _) = split_model(v);
        if provider.is_empty() || id.is_empty() {
            bail!("model '{}' should look like `provider/model[:level]`", v);
        }
    }

    let current = read_roles_at(path)?;
    if let Some(expected) = expected_hash {
        if expected != current.hash {
            bail!("config.yml changed on disk since it was read — re-run and review the diff");
        }
    }

    let next = edit_roles_text(&current.text, role, value);

    // omp must be able to parse the result, and the role must actually carry the value.
    let parsed: Value = serde_yaml::from_str(&next).context("edited config is not valid YAML")?;
    let landed = parsed
        .get("modelRoles")
        .and_then(|m| m.get(role))
        .and_then(Value::as_str);
    if let Some(v) = value {
        if landed != Some(v) {
            bail!("internal edit error: {} did not land in modelRoles", role);
        }
    } else if landed.is_some() {
        bail!("internal edit error: {} still present", role);
    }

    std::fs::create_dir_all(backup_dir()).ok();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = backup_dir().join(format!("config-{stamp}.yml"));
    if current.exists {
        std::fs::write(&backup, &current.text)?;
    }

    // atomic replace: write sibling then rename
    let tmp = path.with_extension("yml.ot-tmp");
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).ok();
    std::fs::write(&tmp, next.as_bytes())?;
    std::fs::rename(&tmp, path)?;

    Ok(backup)
}

#[derive(Debug, Clone, Default)]
pub struct ModelEntry {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub cost_in: f64,
    pub cost_out: f64,
    pub cost_cache_read: f64,
    pub context_window: u64,
}

pub fn load_models_at(path: &Path) -> Vec<ModelEntry> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(yaml) = serde_yaml::from_str::<Value>(&text) else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(providers) = yaml.get("providers").and_then(Value::as_mapping) {
        for (pname, pval) in providers {
            let Some(pname) = pname.as_str() else { continue };
            let Some(models) = pval.get("models").and_then(Value::as_sequence) else { continue };
            for m in models {
                out.push(entry(pname, m));
            }
        }
    }
    if let Some(models) = yaml.get("models").and_then(Value::as_sequence) {
        for m in models {
            out.push(entry("", m));
        }
    }
    out
}

fn entry(provider: &str, m: &Value) -> ModelEntry {
    let cost = m.get("cost");
    ModelEntry {
        provider: provider.to_string(),
        id: m.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        name: m.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        cost_in: cost.and_then(|c| c.get("input")).and_then(Value::as_f64).unwrap_or(0.0),
        cost_out: cost.and_then(|c| c.get("output")).and_then(Value::as_f64).unwrap_or(0.0),
        cost_cache_read: cost.and_then(|c| c.get("cacheRead")).and_then(Value::as_f64).unwrap_or(0.0),
        context_window: m
            .get("contextWindow")
            .and_then(Value::as_u64)
            .or_else(|| m.get("maxTokens").and_then(Value::as_u64))
            .unwrap_or(0),
    }
}

pub fn load_models() -> Vec<ModelEntry> {
    load_models_at(&crate::models_path())
}

/// Loose match on `provider/id` so `gpt-6-astra` finds `magpie/imported/gpt-6-astra`.
pub fn resolve<'a>(models: &'a [ModelEntry], spec: &str) -> Option<&'a ModelEntry> {
    let (provider, id, _) = split_model(spec);
    let id_lc = id.to_lowercase();
    models
        .iter()
        .find(|m| {
            let same_provider = provider.is_empty() || m.provider.eq_ignore_ascii_case(&provider);
            let mid = m.id.to_lowercase();
            same_provider && (mid == id_lc || mid.ends_with(&id_lc) || id_lc.ends_with(&mid))
        })
        .or_else(|| {
            models.iter().find(|m| {
                let mid = m.id.to_lowercase();
                mid.ends_with(&id_lc)
            })
        })
}

pub fn describe(models: &[ModelEntry], spec: &str) -> String {
    match resolve(models, spec) {
        Some(m) => {
            let mut parts = Vec::new();
            if m.cost_in > 0.0 || m.cost_out > 0.0 {
                parts.push(format!("${}/M in, ${}/M out", m.cost_in, m.cost_out));
            }
            if m.context_window > 0 {
                parts.push(format!("{} ctx", crate::fmt_tokens(m.context_window)));
            }
            if parts.is_empty() {
                m.id.clone()
            } else {
                parts.join(" · ")
            }
        }
        None => "not in models.yml (omp falls back to provider default)".to_string(),
    }
}

// ---------------------------------------------------------------- Claude Code

/// Claude Code picks a model per alias (`sonnet` / `opus` / `haiku` / `fable`) and
/// resolves it through `env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL`. The default alias is
/// `settings.json → model`, or the account default when absent.
pub const CLAUDE_ALIASES: [&str; 4] = ["sonnet", "opus", "haiku", "fable"];

pub fn claude_settings_path() -> PathBuf {
    crate::home().join(".claude").join("settings.json")
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeConfig {
    pub path: PathBuf,
    pub text: String,
    pub hash: u64,
    pub exists: bool,
    pub model: Option<String>,
    pub env_models: BTreeMap<String, String>,
}

pub fn read_claude_at(path: &Path) -> Result<ClaudeConfig> {
    let exists = path.exists();
    let text = if exists {
        std::fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?
    } else {
        String::new()
    };
    let hash = fnv1a(text.as_bytes());
    let mut cfg = ClaudeConfig {
        path: path.to_path_buf(),
        text: text.clone(),
        hash,
        exists,
        ..Default::default()
    };
    if !text.trim().is_empty() {
        let json: serde_json::Value = serde_json::from_str(&text)
            .with_context(|| format!("{} 不是合法 JSON（Claude Code 会忽略整份配置）", path.display()))?;
        cfg.model = json.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
        if let Some(env) = json.get("env").and_then(|v| v.as_object()) {
            for (k, v) in env {
                if let (Some(alias), Some(id)) = (alias_of_env(k), v.as_str()) {
                    cfg.env_models.insert(alias, id.to_string());
                }
            }
        }
    }
    Ok(cfg)
}

pub fn read_claude() -> Result<ClaudeConfig> {
    read_claude_at(&claude_settings_path())
}

fn alias_of_env(key: &str) -> Option<String> {
    let rest = key.strip_prefix("ANTHROPIC_DEFAULT_")?.strip_suffix("_MODEL")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_ascii_lowercase())
}

/// `key` is `default` (writes `model`) or an alias (writes the env mapping).
pub fn set_claude_model_at(
    path: &Path,
    key: &str,
    value: Option<&str>,
    expected_hash: Option<u64>,
) -> Result<PathBuf> {
    let key = key.trim().to_ascii_lowercase();
    if key != "default" && !CLAUDE_ALIASES.contains(&key.as_str()) {
        bail!("Claude Code 的模型键只能是 default|sonnet|opus|haiku|fable（收到 {key}）");
    }
    if let Some(v) = value {
        if v.trim().is_empty() {
            bail!("模型值不能为空");
        }
    }

    let current = read_claude_at(path)?;
    if let Some(expected) = expected_hash {
        if expected != current.hash {
            bail!("settings.json 在读取后被改过，请重新读取并确认 diff");
        }
    }

    let mut json: serde_json::Value = if current.text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&current.text).context("settings.json 不是合法 JSON")?
    };
    if !json.is_object() {
        bail!("settings.json 顶层必须是对象");
    }

    match (key.as_str(), value) {
        ("default", Some(v)) => {
            json["model"] = serde_json::Value::String(v.to_string());
        }
        ("default", None) => {
            if let Some(obj) = json.as_object_mut() {
                obj.remove("model");
            }
        }
        (alias, Some(v)) => {
            let upper = alias.to_ascii_uppercase();
            if json.get("env").map(|e| !e.is_object()).unwrap_or(false) {
                bail!("settings.json 的 env 字段不是对象，拒绝改动");
            }
            if json.get("env").is_none() {
                json["env"] = serde_json::json!({});
            }
            json["env"][format!("ANTHROPIC_DEFAULT_{upper}_MODEL")] = serde_json::Value::String(v.to_string());
            // keep the human-readable companion name in sync when it already exists
            let name_key = format!("ANTHROPIC_DEFAULT_{upper}_MODEL_NAME");
            if json["env"].get(&name_key).is_some() {
                json["env"][name_key] = serde_json::Value::String(strip_bracket_suffix(v));
            }
        }
        (alias, None) => {
            let upper = alias.to_ascii_uppercase();
            if let Some(env) = json.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.remove(&format!("ANTHROPIC_DEFAULT_{upper}_MODEL"));
                env.remove(&format!("ANTHROPIC_DEFAULT_{upper}_MODEL_NAME"));
            }
        }
    }

    let next = serde_json::to_string_pretty(&json)? + "\n";
    let reparsed: serde_json::Value = serde_json::from_str(&next).context("编辑后的 JSON 不合法")?;
    if let Some(v) = value {
        if key == "default" {
            if reparsed.get("model").and_then(|m| m.as_str()) != Some(v) {
                bail!("内部错误：model 没有写进去");
            }
        } else if reparsed
            .get("env")
            .and_then(|e| e.get(format!("ANTHROPIC_DEFAULT_{}_MODEL", key.to_ascii_uppercase())))
            .and_then(|m| m.as_str())
            != Some(v)
        {
            bail!("内部错误：env 映射没有写进去");
        }
    }

    std::fs::create_dir_all(backup_dir()).ok();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = backup_dir().join(format!("claude-settings-{stamp}.json"));
    if current.exists {
        std::fs::write(&backup, &current.text)?;
    }

    let tmp = path.with_extension("json.ot-tmp");
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).ok();
    std::fs::write(&tmp, next.as_bytes())?;
    std::fs::rename(&tmp, path)?;

    Ok(backup)
}

fn strip_bracket_suffix(v: &str) -> String {
    match v.split_once('[') {
        Some((head, _)) => head.to_string(),
        None => v.to_string(),
    }
}

#[cfg(test)]
mod tests {    use super::*;

    const SAMPLE: &str = "shellPath: C:\\Windows\\system32\\bash.exe\nmodelRoles:\n  slow: deepseek/deepseek-flash:max\n  default: magpie/imported/gpt-6-astra:high\nsymbolPreset: unicode\ntheme:\n  dark: titanium\n";

    #[test]
    fn split_model_handles_thinking_suffix_and_slashes() {
        assert_eq!(
            split_model("magpie/imported/gpt-6-astra:high"),
            ("magpie".into(), "imported/gpt-6-astra".into(), Some("high".into()))
        );
        assert_eq!(
            split_model("deepseek/deepseek-flash"),
            ("deepseek".into(), "deepseek-flash".into(), None)
        );
        // a colon that is not a thinking level must stay in the model id
        assert_eq!(split_model("local/qwen2.5:7b"), ("local".into(), "qwen2.5:7b".into(), None));
    }

    #[test]
    fn edit_only_touches_the_role() {
        let out = edit_roles_text(SAMPLE, "plan", Some("ccs/gpt-6-sol:medium"));
        assert!(out.starts_with("shellPath:"));
        assert!(out.contains("  slow: deepseek/deepseek-flash:max\n"));
        assert!(out.contains("  default: magpie/imported/gpt-6-astra:high\n"));
        assert!(out.contains("  plan: ccs/gpt-6-sol:medium\n"));
        assert!(out.ends_with("theme:\n  dark: titanium\n"));
        let parsed: Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["modelRoles"]["plan"].as_str(), Some("ccs/gpt-6-sol:medium"));
    }

    #[test]
    fn set_then_unset_roundtrips_to_original() {
        let dir = std::env::temp_dir().join(format!("ot-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yml");
        std::fs::write(&path, SAMPLE).unwrap();

        let before = read_roles_at(&path).unwrap();
        set_role_at(&path, "smol", Some("deepseek/deepseek-flash:low"), Some(before.hash)).unwrap();
        let mid = read_roles_at(&path).unwrap();
        assert_eq!(mid.get("smol"), Some("deepseek/deepseek-flash:low"));

        set_role_at(&path, "smol", None, Some(mid.hash)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SAMPLE);

        // a stale hash must be rejected
        let stale = before.hash ^ 0xdead_beef;
        let err = set_role_at(&path, "smol", Some("a/b"), Some(stale));
        assert!(err.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_short_model_ids() {
        let models = vec![
            ModelEntry { provider: "magpie".into(), id: "imported/gpt-6-astra".into(), context_window: 922_000, ..Default::default() },
            ModelEntry { provider: "deepseek".into(), id: "deepseek-flash".into(), context_window: 1_048_576, ..Default::default() },
        ];
        assert!(resolve(&models, "magpie/imported/gpt-6-astra:high").is_some());
        assert!(resolve(&models, "gpt-6-astra").is_some());
        assert!(resolve(&models, "deepseek/deepseek-flash").is_some());
        assert!(resolve(&models, "nope/model").is_none());
    }
}
