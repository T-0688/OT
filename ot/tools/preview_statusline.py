import io, json, subprocess, re, os, sys
from PIL import Image, ImageDraw, ImageFont

exe = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    r"~\AppData\Local\ot\bin\ot-statusline.exe")
payload = {
    "session_id": "preview-0001",
    "transcript_path": r"C:\Users\Kepler\.claude\projects\x\preview.jsonl",
    "cwd": r"D:\.Daily\DeepSeek Harness",
    "model": {"id": "deepseek-flash[1m]", "display_name": "deepseek-flash[1m]"},
    "workspace": {"current_dir": r"D:\.Daily\DeepSeek Harness"},
    "version": "2.1.316",
    "cost": {"total_cost_usd": 0.59},
    "context": {"used_tokens": 390000, "max_tokens": 1000000},
}
raw = subprocess.run([exe], input=json.dumps(payload).encode(), stdout=subprocess.PIPE).stdout.decode("utf-8", "replace")
print("私有区字符（除分隔符）:", [hex(ord(c)) for c in raw if 0xE000 <= ord(c) <= 0xF8FF and c != "\ue0b0"])

SEP = "\ue0b0"
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
            elif c == "49":
                bg = None
            elif c in ("38", "48") and codes[i + 1] == "2":
                rgb = (int(codes[i + 2]), int(codes[i + 3]), int(codes[i + 4]))
                i += 4
                fg = rgb if c == "38" else fg
                bg = rgb if c == "48" else bg
            i += 1
    elif tok:
        runs.append((tok, fg, bg))

font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 17)
text_w = [font.getlength(t) for t, _, _ in runs]
SEP_W = 10
H = 46
W = int(sum(text_w) + SEP_W * raw.count(SEP)) + 26
img = Image.new("RGB", (W, H), (18, 22, 20))
d = ImageDraw.Draw(img)
x = 12
prev_bg = None
for (text, f, b), w in zip(runs, text_w):
    if text == SEP:
        # 用三角形画分隔符：形状是前一段底色
        d.polygon([(x, 8), (x + SEP_W, 19), (x, 30)], fill=prev_bg or (18, 22, 20))
        x += SEP_W
        continue
    if b:
        d.rectangle([x, 8, x + w, 30], fill=b)
        prev_bg = b
    shown = "".join(ch if (ord(ch) < 0x2500 or 0x4E00 <= ord(ch) <= 0x9FFF or 0xFF00 <= ord(ch)) else "" for ch in text)
    d.text((x, 10), shown, font=font, fill=f)
    x += w
img.save(r"D:\.Daily\DeepSeek Harness\ot\statusline-preview.png")
print("preview saved")
