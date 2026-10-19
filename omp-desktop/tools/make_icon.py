"""生成应用图标：build/icon.png (512) + build/icon.ico (多尺寸)。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build"
OUT.mkdir(parents=True, exist_ok=True)
S = 512

# 背景：圆角矩形 + 竖向渐变
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
t = (yy / S).clip(0, 1)
top = np.array([19, 22, 30], dtype=np.float32)
bottom = np.array([9, 11, 15], dtype=np.float32)
bg = (top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]).astype(np.uint8)

# 圆环：以中心为原点，半径区间内做渐变
cx = cy = S / 2
r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
r_out, r_in = S * 0.36, S * 0.27
ring = (r <= r_out) & (r >= r_in)

# 沿角度做蓝 → 紫渐变
ang = (np.arctan2(yy - cy, xx - cx) / (2 * np.pi)) % 1.0
c1 = np.array([124, 156, 255], dtype=np.float32)   # accent
c2 = np.array([180, 140, 255], dtype=np.float32)   # purple
ring_rgb = (c1[None, None, :] * (1 - ang[..., None]) + c2[None, None, :] * ang[..., None]).astype(np.uint8)

img = bg.copy()
img[ring] = ring_rgb[ring]

pil = Image.fromarray(img, "RGB").convert("RGBA")

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
pil.putalpha(mask)

# 高光点（右上角）
d = ImageDraw.Draw(pil)
d.ellipse([S * 0.66, S * 0.20, S * 0.76, S * 0.30], fill=(255, 255, 255, 235))

pil.save(OUT / "icon.png")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
pil.save(OUT / "icon.ico", sizes=sizes)
print("wrote", OUT / "icon.png", "and", OUT / "icon.ico")
