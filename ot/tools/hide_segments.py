import io, os, re, shutil, datetime

cfg = os.path.expanduser(r"~\.claude\micucodeline\config.toml")
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(cfg, cfg + f".bak-{stamp}")
print("备份:", cfg + f".bak-{stamp}")

lines = io.open(cfg, encoding="utf-8").read().splitlines()
out, cur_id, seen = [], None, False
for line in lines:
    s = line.strip()
    if s == "[[segments]]":
        cur_id, seen = None, False
    m = re.match(r'id\s*=\s*"([^"]+)"', s)
    if m:
        cur_id = m.group(1)
    if cur_id in ("session", "branding") and re.match(r"enabled\s*=", s) and not seen:
        out.append(re.sub(r"enabled\s*=\s*\w+", "enabled = false", line))
        seen = True
        print("关闭:", cur_id)
        continue
    out.append(line)

io.open(cfg, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
