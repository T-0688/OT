from PIL import Image
src = Image.open(r"build\icon.png").convert("RGBA")
for size in (192, 512):
    src.resize((size, size), Image.LANCZOS).save(rf"build\icon-{size}.png")
print("ok", src.size)
