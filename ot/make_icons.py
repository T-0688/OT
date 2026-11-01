import os
from PIL import Image, ImageDraw

out = r"D:\.Daily\DeepSeek Harness\ot\crates\tray\icons"
os.makedirs(out, exist_ok=True)


def draw(size):
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(24, 26, 32, 255))
    # ">" prompt glyph
    w = int(s * 0.09)
    pts = [(int(s * 0.26), int(s * 0.30)), (int(s * 0.50), int(s * 0.50)), (int(s * 0.26), int(s * 0.70))]
    d.line(pts, fill=(94, 214, 208, 255), width=w, joint="curve")
    # "_" cursor
    d.line([(int(s * 0.56), int(s * 0.70)), (int(s * 0.76), int(s * 0.70))], fill=(94, 214, 208, 255), width=w)
    # red dot = guard
    d.ellipse([int(s * 0.72), int(s * 0.14), int(s * 0.86), int(s * 0.28)], fill=(240, 112, 96, 255))
    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 32, 48, 64, 128, 256]
imgs = {sz: draw(sz) for sz in sizes}
imgs[256].save(os.path.join(out, "icon.png"))
imgs[256].save(os.path.join(out, "icon.ico"), sizes=[(sz, sz) for sz in sizes])
print("icons written to", out)
