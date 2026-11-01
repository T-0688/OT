import io, json, subprocess, re, os
from PIL import Image, ImageDraw, ImageFont

exe = os.path.expanduser(r"~\.claude\micucodeline\micucodeline.exe")
payload = {
    "session_id": "preview-0001",
    "transcript_path": r"C:\Users\Kepler\.claude\projects\x\preview.jsonl",
    "cwd": r"D:\.Daily\DeepSeek Harness",
    "model": {"id": "deepseek-flash[1m]", "display_name": "deepseek-flash[1m]"},
    "workspace": {"current_dir": r"D:\.Daily\DeepSeek Harness", "project_dir": r"D:\.Daily\DeepSeek Harness"},
    "version": "2.1.316",
    "output_style": {"name": "default"},
    "cost": {
        "total_cost_usd": 0.59,
        "total_duration_ms": 347000,
        "total_api_duration_ms": 120000,
        "total_lines_added": 1,
        "total_lines_removed": 1,
    },
    "context": {"used_tokens": 39300, "max_tokens": 1000000},
}

p = subprocess.run([exe], input=json.dumps(payload).encode("utf-8"),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
raw = p.stdout.decode("utf-8", "replace")
print("exit:", p.returncode, "bytes:", len(raw))
print("stderr:", p.stderr.decode("utf-8", "replace")[:200])

# 有没有用上新配色
for rgb in ["48;2;26;46;41", "48;2;31;56;49", "48;2;41;76;65"]:
    print(f"包含 {rgb}:", rgb in raw)

# ---- 把 ANSI 渲染成图，方便肉眼确认 ----
tokens = re.split(r"(\x1b\[[0-9;]*m)", raw)
fg, bg = (200, 200, 200), None
runs = []
for tok in tokens:
    if tok.startswith("\x1b["):
        codes = [c for c in tok[2:-1].split(";") if c]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == "0":
                fg, bg = (200, 200, 200), None
            elif c in ("38", "48"):
                if codes[i + 1] == "2":
                    r, g, b = (int(codes[i + 2]), int(codes[i + 3]), int(codes[i + 4]))
                    i += 4
                    if c == "38":
                        fg = (r, g, b)
                    else:
                        bg = (r, g, b)
            i += 1
    else:
        if tok:
            runs.append((tok, fg, bg))

font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 17)
SCALE, PAD = 1.0, 6
widths = []
for text, _, _ in runs:
    w = font.getlength(text)
    widths.append(w)
W = int(sum(widths)) + 2 * PAD + 40
H = 46
img = Image.new("RGB", (W, H), (18, 22, 20))
d = ImageDraw.Draw(img)
x = PAD
for (text, f, b), w in zip(runs, widths):
    if b:
        d.rectangle([x, 8, x + w, 8 + 22], fill=b)
    # Nerd 字体字形画不出来，用 · 占位
    shown = "".join(ch if ord(ch) < 0x2500 or 0x4E00 <= ord(ch) <= 0x9FFF else "·" for ch in text)
    d.text((x, 10), shown, font=font, fill=f)
    x += w
img.save(r"D:\.Daily\DeepSeek Harness\ot\statusline-preview.png")
print("preview saved")
