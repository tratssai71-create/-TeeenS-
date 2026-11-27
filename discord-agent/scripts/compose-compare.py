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
def edges(im, w=360):
    # 白黒にして縮め、輪郭(明るさの変わり目)の強さを、少しぼかした地図にする
    g = np.asarray(im.convert("L").resize((w, max(8, int(im.height * w / im.width)))), dtype=np.float32)
    gx = np.abs(np.diff(g, axis=1, prepend=g[:, :1])); gy = np.abs(np.diff(g, axis=0, prepend=g[:1, :]))
    m = gx + gy
    for _ in range(2):  # 3x3の平均を2回(少しのずれを許す)
        p = np.pad(m, 1, mode="edge"); m = sum(p[i:i + m.shape[0], j:j + m.shape[1]] for i in range(3) for j in range(3)) / 9
    return m
def ncc(A, B):
    A = A - A.mean(); B = B - B.mean(); d = float(np.sqrt((A * A).sum() * (B * B).sum()))
    return float((A * B).sum() / d) if d > 1e-6 else None
def sim(a, b):
    # 見た目の近さ(0〜100)。輪郭の地図どうしの、相関。上下に少しずれても、いちばん合う位置で比べる(±12行)。
    # 両方とも、ほぼ何も無い(白)ときは100
    if a.height < 8 or b.height < 8: return 0.0
    A = edges(a); B = edges(b.resize(a.size))
    if A.std() < 0.5 and B.std() < 0.5: return 100.0
    best = None
    for sh in range(-12, 13, 2):
        if sh >= 0: x, y2 = A[sh:], B[:B.shape[0] - sh]
        else: x, y2 = A[:A.shape[0] + sh], B[-sh:]
        if x.shape[0] < 8: continue
        v = ncc(x, y2)
        if v is not None and (best is None or v > best): best = v
    return round(100 * max(0.0, best if best is not None else 0.0), 1)

while y < maxh:
    a = orig.crop((0, y, W, min(y + CH, orig.height))) if y < orig.height else Image.new("RGB", (W, 10), (240, 240, 240))
    b = studio.crop((0, y, W, min(y + CH, studio.height))) if y < studio.height else Image.new("RGB", (W, 10), (240, 240, 240))
    h = max(a.height, b.height)
    scores.append(sim(a, b))
    canvas = Image.new("RGB", (W * 2 + 24, h), (200, 200, 200))
    canvas.paste(a, (0, 0)); canvas.paste(b, (W + 24, 0))
    canvas = canvas.resize((int(canvas.width * scale), int(canvas.height * scale)))
    n += 1; canvas.save(os.path.join(out, f"compare-{n:02d}.png")); y += CH
# セクションごとの近さ(仕様書の幅1280pxの位置を、画像の画素にそろえて切り出す。STUDIO側は、全体の高さの比で、位置を合わせる)
sec_scores = []
try:
    spec = json.load(open(os.path.join(os.path.dirname(os.path.abspath(out)), "spec.json")))
    secs = spec["pc1280"]["sections"]; H1280 = max(1, secs[-1]["y"] + secs[-1]["h"])
    ko = orig.height / H1280; ks = studio.height / H1280
    for i, sec in enumerate(secs):
        if sec["h"] < 20: continue
        a = orig.crop((0, int(sec["y"] * ko), W, min(orig.height, int((sec["y"] + sec["h"]) * ko))))
        b = studio.crop((0, int(sec["y"] * ks), W, min(studio.height, int((sec["y"] + sec["h"]) * ks))))
        os.makedirs(os.path.join(out, "sections"), exist_ok=True)
        hh = max(a.height, b.height, 10)
        pair = Image.new("RGB", (W * 2 + 24, hh), (200, 200, 200)); pair.paste(a, (0, 0)); pair.paste(b, (W + 24, 0))
        pair = pair.resize((int(pair.width * 0.5), int(pair.height * 0.5)))
        img_path = os.path.join(out, "sections", f"sec-{i + 1:02d}.png"); pair.save(img_path)
        sec_scores.append({"n": i + 1, "tag": sec.get("tag"), "score": sim(a, b), "image": img_path})
except Exception as e:
    print("セクションごとの近さは、出せませんでした:", e)
json.dump({"scores": scores, "sections": sec_scores, "files": [f"compare-{i+1:02d}.png" for i in range(n)]}, open(os.path.join(out, "scores.json"), "w"))
print(f"できました: {n}枚(左=元のサイト / 右=STUDIO)→ {out}  元の高さ {orig.height//int(dpr)}px / STUDIOの高さ {studio.height//int(dpr)}px")
