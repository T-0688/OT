import io, re, shutil, datetime, subprocess, os, json

cfg = os.path.expanduser(r"~\.claude\micucodeline\config.toml")
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
bak = cfg + f".bak-{stamp}"
shutil.copy2(cfg, bak)
print("已备份:", bak)

# 低饱深绿：背景从墨绿到稍亮的青绿，文字浅灰绿
BG = {
    "model":          (26, 46, 41),
    "context_window": (31, 56, 49),
    "usage":          (36, 66, 57),
    "cost":           (41, 76, 65),
    "session":        (46, 86, 74),
    "output_style":   (44, 80, 68),
    "cwd":            (33, 60, 52),
    "directory":      (38, 70, 61),
    "git":            (43, 80, 69),
    "used":           (48, 90, 77),
    "balance":        (53, 100, 85),
    "branding":       (62, 112, 94),
}
TEXT = (214, 226, 219)
ICON = (168, 196, 182)

lines = io.open(cfg, encoding="utf-8").read().splitlines()
out = []
cur_id = None
cur_section = None
for line in lines:
    s = line.strip()
    if s == "[[segments]]":
        cur_id = None
        cur_section = None
    elif s.startswith("id = "):
        m = re.search(r'id\s*=\s*"([^"]+)"', s)
        if m:
            cur_id = m.group(1)
    elif s.startswith("[segments.colors."):
        cur_section = s[len("[segments.colors."):-1]
    elif s.startswith("[") and not s.startswith("[segments.colors."):
        cur_section = None

    # 换颜色值：紧跟在对应小节下的 r/g/b
    m = re.match(r"^(\s*)r = (\d+)$", line)
    if m and cur_id in BG and cur_section:
        target = {"background": BG[cur_id], "text": TEXT, "icon": ICON}[cur_section]
        out.append(f"{m.group(1)}r = {target[0]}")
        continue
    m = re.match(r"^(\s*)g = (\d+)$", line)
    if m and cur_id in BG and cur_section:
        target = {"background": BG[cur_id], "text": TEXT, "icon": ICON}[cur_section]
        out.append(f"{m.group(1)}g = {target[1]}")
        continue
    m = re.match(r"^(\s*)b = (\d+)$", line)
    if m and cur_id in BG and cur_section:
        target = {"background": BG[cur_id], "text": TEXT, "icon": ICON}[cur_section]
        out.append(f"{m.group(1)}b = {target[2]}")
        continue
    out.append(line)

io.open(cfg, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("配色已写入")
