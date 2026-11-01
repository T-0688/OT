import re, os

exe = os.path.expanduser(r"~\.claude\micucodeline\micucodeline.exe")
data = open(exe, "rb").read()
print("exe 大小: %.1f MB" % (len(data) / 1048576))

for needle in [b"branding", b"Branding", b"MICU", b"hide_branding", b"no_branding"]:
    hits = [m.start() for m in re.finditer(needle, data)]
    print(f"{needle.decode()}: {len(hits)} 次")
    for pos in hits[:4]:
        chunk = data[max(0, pos - 80): pos + 80]
        txt = re.sub(rb"[^\x20-\x7e]", b".", chunk).decode()
        print("   ...", txt)
