# compare-images.js の続き: STUDIOのスクロール画像をつなげて、元の全体画像と、左右に並べた画像(compare-NN.png)にする
import json, sys, os
from PIL import Image
out = sys.argv[1]
meta = json.load(open(os.path.join(out, "slices.json")))
dpr = meta["dpr"]; W = int(meta["width"] * dpr); H = int(meta["total"] * dpr)
studio = Image.new("RGB", (W, H), (255, 255, 255))
for sl in meta["slices"]:
    im = Image.open(sl["file"]).convert("RGB")
    studio.paste(im, (0, int(sl["offsetCss"] * dpr)))
studio.save(os.path.join(out, "studio-full.png"))
orig = Image.open(os.path.join(out, "original-full.png")).convert("RGB")
CH = int(1500 * dpr)  # 1枚あたり、元の高さ1500px分
scale = 0.5           # 並べて見やすいよう、半分の大きさにする
n = 0; y = 0; maxh = max(orig.height, studio.height)
while y < maxh:
    a = orig.crop((0, y, W, min(y + CH, orig.height))) if y < orig.height else Image.new("RGB", (W, 10), (240, 240, 240))
    b = studio.crop((0, y, W, min(y + CH, studio.height))) if y < studio.height else Image.new("RGB", (W, 10), (240, 240, 240))
    h = max(a.height, b.height)
    canvas = Image.new("RGB", (W * 2 + 24, h), (200, 200, 200))
    canvas.paste(a, (0, 0)); canvas.paste(b, (W + 24, 0))
    canvas = canvas.resize((int(canvas.width * scale), int(canvas.height * scale)))
    n += 1; canvas.save(os.path.join(out, f"compare-{n:02d}.png")); y += CH
print(f"できました: {n}枚(左=元のサイト / 右=STUDIO)→ {out}  元の高さ {orig.height//int(dpr)}px / STUDIOの高さ {studio.height//int(dpr)}px")
