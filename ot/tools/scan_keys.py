import re, os

exe = os.path.expanduser(r"~\.claude\micucodeline\micucodeline.exe")
data = open(exe, "rb").read()

# 找 serde 的字段名：短的小写标识符，出现在一起
cands = set()
for m in re.finditer(rb"[a-z_]{4,24}", data):
    s = m.group().decode()
    if s in {
        "session_id", "transcript_path", "cwd", "model", "workspace", "version",
        "output_style", "cost", "context", "display_name", "current_dir", "project_dir",
        "total_cost_usd", "total_duration_ms", "total_api_duration_ms", "total_lines_added",
        "total_lines_removed", "used_tokens", "max_tokens", "context_window", "input_tokens",
        "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        "context_usage", "used_percentage", "compact", "is_compacting", "permission_mode",
        "exceeds_200k_tokens", "session_name", "session_title",
    }:
        cands.add(s)
print("命中字段:", sorted(cands))
