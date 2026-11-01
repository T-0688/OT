import json, subprocess, re, os

exe = os.path.expanduser(r"~\.claude\micucodeline\micucodeline.exe")
payload = {
    "session_id": "p",
    "transcript_path": r"C:\Users\Kepler\.claude\projects\x\p.jsonl",
    "cwd": r"D:\.Daily\DeepSeek Harness",
    "model": {"id": "deepseek-flash[1m]", "display_name": "deepseek-flash[1m]"},
    "workspace": {"current_dir": r"D:\.Daily\DeepSeek Harness", "project_dir": r"D:\.Daily\DeepSeek Harness"},
    "version": "2.1.316",
    "output_style": {"name": "default"},
    "cost": {"total_cost_usd": 0.59, "total_duration_ms": 347000, "total_api_duration_ms": 120000,
             "total_lines_added": 1, "total_lines_removed": 1},
    "context": {"used_tokens": 39300, "max_tokens": 1000000},
}
out = subprocess.run([exe], input=json.dumps(payload).encode(), stdout=subprocess.PIPE).stdout.decode("utf-8", "replace")
plain = re.sub(r"\x1b\[[0-9;]*m", "", out)
print("纯文本:", plain.replace("\ue0b0", " | ").replace("", " | "))
print("--- 分段 ---")
for i, seg in enumerate(re.split(r"[\ue0b0\ue0b1]", out)):
    t = re.sub(r"\x1b\[[0-9;]*m", "", seg).strip()
    bgs = re.findall(r"48;2;(\d+;\d+;\d+)", seg)
    fgs = re.findall(r"38;2;(\d+;\d+;\d+)", seg)
    if t:
        print(f"[{i}] bg={bgs[:1]} fg={fgs[:1]} text={t!r}")
