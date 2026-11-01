import io, os, re, shutil, datetime

cfg = os.path.expanduser(r"~\.claude\micucodeline\config.toml")
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(cfg, cfg + f".bak-{stamp}")
print("备份:", cfg + f".bak-{stamp}")

lines = io.open(cfg, encoding="utf-8").read().splitlines()
out = []
i = 0
dropped = []
while i < len(lines):
    line = lines[i]
    if line.strip() == "[[segments]]":
        # 收集这一整块
        j = i + 1
        while j < len(lines) and lines[j].strip() != "[[segments]]":
            j += 1
        block = lines[i:j]
        m = None
        for b in block:
            mm = re.match(r'\s*id\s*=\s*"([^"]+)"', b)
            if mm:
                m = mm.group(1)
                break
        if m == "branding":
            dropped.append(m)
            i = j
            continue
        if m == "directory":
            block = [re.sub(r"enabled\s*=\s*\w+", "enabled = false", b) if re.match(r"\s*enabled\s*=", b) else b for b in block]
            dropped.append("directory(enabled=false)")
        out.extend(block)
        i = j
        continue
    out.append(line)
    i += 1

io.open(cfg, "w", encoding="utf-8", newline="\n").write("\n".join(out).rstrip() + "\n")
print("处理:", dropped)
