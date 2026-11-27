# compare-images.js の続き: STUDIOのスクロール画像をつなげて、元の全体画像と、左右に並べた画像(compare-NN.png)にする
import json, sys, os
from PIL import Image
import numpy as np
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
n = 0; y = 0; maxh = max(orig.height, studio.height); scores = []
def sim(a, b):
    # 見た目の近さ(0〜100)。縮小した白黒画像の、明るさの差の平均から出す。位置が少しずれると、下がる
    w = 300
    def g(im):
        im = im.convert("L"); return np.asarray(im.resize((w, max(1, int(im.height * w / im.width)))), dtype=np.float32)
    ga, gb = g(a), g(b); h = min(ga.shape[0], gb.shape[0])
    if h < 4: return 0.0
    return round(100 * (1 - float(np.mean(np.abs(ga[:h] - gb[:h]))) / 255), 1)
while y < maxh:
    a = orig.crop((0, y, W, min(y + CH, orig.height))) if y < orig.height else Image.new("RGB", (W, 10), (240, 240, 240))
    b = studio.crop((0, y, W, min(y + CH, studio.height))) if y < studio.height else Image.new("RGB", (W, 10), (240, 240, 240))
    h = max(a.height, b.height)
    scores.append(sim(a, b))
    canvas = Image.new("RGB", (W * 2 + 24, h), (200, 200, 200))
    canvas.paste(a, (0, 0)); canvas.paste(b, (W + 24, 0))
    canvas = canvas.resize((int(canvas.width * scale), int(canvas.height * scale)))
    n += 1; canvas.save(os.path.join(out, f"compare-{n:02d}.png")); y += CH
json.dump({"scores": scores, "files": [f"compare-{i+1:02d}.png" for i in range(n)]}, open(os.path.join(out, "scores.json"), "w"))
print(f"できました: {n}枚(左=元のサイト / 右=STUDIO)→ {out}  元の高さ {orig.height//int(dpr)}px / STUDIOの高さ {studio.height//int(dpr)}px")
