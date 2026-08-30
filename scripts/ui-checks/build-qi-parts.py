"""
把切好的三段精靈組成可用的動畫 WebP：qi-cap / qi-mid / qi-tail。

三個必須處理的問題（都是實測發現的，不是預設）：

1. **同一組各幀寬高不一致**（mid-a 295~327、tail-b 130~152）。
   動畫每一格必須等尺寸，所以統一放到共同畫布上，水平置中。

2. **中段兩端也是圓弧**。那是「一整條」的造型，直接拿去 background-repeat
   會每隔一段就出現一對圓頭。必須把兩端的圓弧裁掉、只留中間可平鋪的部分，
   再做左右接縫交叉淡化。

3. **三段的垂直對位**。cap/mid/tail 是分開生成的，條身高度不完全一樣；
   對不齊的話組起來會有階梯。所以以 mid 的條身高度為基準統一縮放。

跑法：python scripts/ui-checks/build-qi-parts.py
"""
import os
import math
import numpy as np
from PIL import Image

SRC = os.path.join('public', 'themes', 'xianxia', 'qi-parts')
OUT = os.path.join('public', 'themes', 'xianxia', 'qi-tiles')

BAR_H = 48          # 條身高度（顯示時會縮到 12px，留 4 倍給高 DPI）
FRAMES_OUT = 24     # CodeX 一組只給 4 幀，補到 24 幀
FRAME_MS = 50
DENSITY = 'a'       # a / b 兩種密度，先出 a


def load(group):
    """讀一組 4 幀，回傳 float32 陣列清單"""
    out = []
    for i in range(4):
        p = os.path.join(SRC, f'{group}-{i}.png')
        if os.path.exists(p):
            out.append(np.asarray(Image.open(p).convert('RGBA')).astype(np.float32))
    return out


def body_rows(a, coverage=0.75):
    """找「條身」的上下界：整列不透明度夠高的部分。
    tail 的發散會往外溢出，那些列覆蓋率低，不算條身。"""
    cov = (a[..., 3] / 255.0).mean(axis=1)
    r = np.where(cov >= coverage)[0]
    return (int(r[0]), int(r[-1] + 1)) if len(r) else (0, a.shape[0])


def pad_to(a, W, H, align='center'):
    """放到 W x H 的透明畫布上。align 決定水平怎麼靠。"""
    h, w = a.shape[:2]
    out = np.zeros((H, W, 4), np.float32)
    y = max(0, (H - h) // 2)
    if align == 'left':
        x = 0
    elif align == 'right':
        x = max(0, W - w)
    else:
        x = max(0, (W - w) // 2)
    hh, ww = min(h, H - y), min(w, W - x)
    out[y:y + hh, x:x + ww] = a[:hh, :ww]
    return out


def make_seamless(a, overlap_frac=0.25):
    """右端淡入左端，讓左右邊界一致 → 可以無縫橫向重複。

    ⚠️ 權重方向寫反的話接縫會**更糟**（第一版寫反，誤差從 17.9 變成 44.8）：
      O[0]       要等於 A[w-v]    （原圖右端重疊區的第一個像素）
      O[out_w-1] 是   A[w-v-1]    （它在原圖裡剛好是前一個像素）
    兩者在原圖中相鄰，首尾接起來才是連續的。"""
    h, w = a.shape[:2]
    v = max(2, int(w * overlap_frac))
    out = a[:, :w - v].copy()
    t = np.linspace(0.0, 1.0, v, np.float32).reshape(1, v, 1)
    out[:, :v] = a[:, :v] * t + a[:, w - v:] * (1.0 - t)
    return out


def match_tone(a, ref):
    """把 a 的色調對齊 ref。

    三段是分開生成的，色調本來就不一樣——直接拼會在接縫處出現色差方塊。
    只用不透明像素算平均值，透明區的 RGB 是垃圾值不能算進來。"""
    def mean_rgb(x):
        m = x[..., 3] > 200
        return x[..., :3][m].mean(axis=0) if m.any() else np.array([1., 1., 1.])
    src, dst = mean_rgb(a), mean_rgb(ref)
    gain = np.clip(dst / np.maximum(src, 1e-3), 0.6, 1.6)
    out = a.copy()
    out[..., :3] = np.clip(out[..., :3] * gain, 0, 255)
    return out


def feather(a, side, frac=0.35):
    """把某一側的 alpha 做漸層，讓它淡入中段而不是硬碰硬接上。

    沒有這層的話，cap/tail 的矩形邊界會在條子上變成一條直線——
    實測就是這樣，接縫比色差還明顯。"""
    h, w = a.shape[:2]
    n = max(1, int(w * frac))
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out = a.copy()
    if side == 'right':
        out[:, w - n:, 3] *= ramp[::-1]
    else:
        out[:, :n, 3] *= ramp
    return out


def interpolate(frames, n_out):
    """把 N 幀補成 n_out 幀，讓動畫流暢。

    CodeX 一組只給 4 幀，直接播就是一秒閃四次，使用者回報「不夠流暢」。
    用相鄰兩幀線性插值，最後一幀回接第 0 幀，所以補完仍然是**完美循環**。

    ⚠️ 這是交叉淡化，不是真的重新繪製中間動作。變化幅度大的地方會看起來像
    疊影而不是位移——但比 4 幀硬切流暢得多，而且不需要重新生圖。
    要真正的中間動作只能請 CodeX 出更多幀。"""
    n = len(frames)
    out = []
    for i in range(n_out):
        t = i / n_out * n
        b = int(math.floor(t)) % n
        f = t - math.floor(t)
        out.append(frames[b] * (1.0 - f) + frames[(b + 1) % n] * f)
    return out


def feather_outer(a, sides, frac=0.16):
    """把「外緣」的 alpha 收成漸層，讓被切到的地方淡出而不是硬斷。

    為什麼一定要有這層：atlas 裡精靈間距只有 30~36px，光暈本來就跨到隔壁，
    切圖時無論門檻多低都一定會切到一點。使用者看到的「被裁切的感覺」
    來自**邊界上還有明顯的 alpha**（實測 tail 右緣殘留到 60~78），
    不是來自「少了什麼」——所以讓邊界淡出就解決了。

    ⚠️ mid 不能羽化上下緣：它要填滿整條軌道，上下留透明邊會讓軌道底色
    透出來變成黑邊（先前踩過）。所以呼叫端要自己決定羽化哪幾邊。"""
    out = a.copy()
    h, w = a.shape[:2]
    if 'top' in sides:
        n = max(1, int(h * frac))
        out[:n, :, 3] *= np.linspace(0., 1., n, dtype=np.float32)[:, None]
    if 'bottom' in sides:
        n = max(1, int(h * frac))
        out[h - n:, :, 3] *= np.linspace(1., 0., n, dtype=np.float32)[:, None]
    if 'left' in sides:
        n = max(1, int(w * frac))
        out[:, :n, 3] *= np.linspace(0., 1., n, dtype=np.float32)[None, :]
    if 'right' in sides:
        n = max(1, int(w * frac))
        out[:, w - n:, 3] *= np.linspace(1., 0., n, dtype=np.float32)[None, :]
    return out


def save_anim(frames, name, size):
    imgs = [Image.fromarray(np.clip(f, 0, 255).astype(np.uint8), 'RGBA')
                 .resize(size, Image.LANCZOS) for f in frames]
    p = os.path.join(OUT, name)
    imgs[0].save(p, format='WEBP', save_all=True, append_images=imgs[1:],
                 duration=FRAME_MS, loop=0, quality=84, method=6)
    return p, os.path.getsize(p) / 1024


os.makedirs(OUT, exist_ok=True)

mids = load(f'mid-{DENSITY}')
caps = load(f'cap-{DENSITY}')
tails = load(f'tail-{DENSITY}')
if not (mids and caps and tails):
    raise SystemExit('缺少切好的素材，先跑 slice-qi-atlas.py')

# ── 以 mid 的條身高度當基準 ──
m0, m1 = body_rows(mids[0])
mid_body_h = m1 - m0
scale = BAR_H / mid_body_h
print(f'mid 條身高 {mid_body_h}px → 目標 {BAR_H}px，縮放 {scale:.3f}\n')

# ── 中段：裁掉兩端圓弧 → 統一寬度 → 接縫交叉淡化 ──
CAP_CUT = 0.20      # 兩端各裁掉 20%，把圓頭去掉
mid_frames = []
for f in mids:
    y0, y1 = body_rows(f)
    core = f[y0:y1]                       # 只留條身，去掉上下透明邊
    w = core.shape[1]
    core = core[:, int(w * CAP_CUT):int(w * (1 - CAP_CUT))]
    mid_frames.append(core)

MID_W = min(f.shape[1] for f in mid_frames)
mid_frames = [make_seamless(f[:, :MID_W]) for f in mid_frames]
MID_W2 = min(f.shape[1] for f in mid_frames)
mid_frames = [f[:, :MID_W2] for f in mid_frames]

seam = np.abs(mid_frames[0][:, 0, :] - mid_frames[0][:, -1, :]).mean()
p, kb = save_anim(interpolate(mid_frames, FRAMES_OUT), 'qi-mid-anim.webp', (384, BAR_H))
print(f'中段  qi-mid-anim.webp   384x{BAR_H}  {kb:>6.1f} KB   接縫誤差 {seam:.1f}')

# ── 左端：保留圓弧，靠左對齊 ──
# 色調對齊中段、內側（右邊）羽化，否則接縫會是一條直線
caps = [feather_outer(feather(match_tone(f, mids[0]), 'right'), ('top', 'bottom', 'left')) for f in caps]
cap_h = max(f.shape[0] for f in caps)
cap_w = max(f.shape[1] for f in caps)
cap_frames = [pad_to(f, cap_w, cap_h, 'left') for f in caps]
# 條身要跟 mid 一樣高：依同一個 scale 換算出畫布高
cap_out_h = max(1, int(round(cap_h * scale)))
cap_out_w = max(1, int(round(cap_w * scale)))
p, kb = save_anim(interpolate(cap_frames, FRAMES_OUT), 'qi-cap-anim.webp', (cap_out_w, cap_out_h))
print(f'左端  qi-cap-anim.webp   {cap_out_w}x{cap_out_h}  {kb:>6.1f} KB')

# ── 右端：發散會往外溢出，靠左對齊（左邊接中段）──
# 同上，但羽化的是內側（左邊）
# 羽化寬度給小一點：發散本體就在左半邊，削太多會把它吃掉
tails = [feather_outer(feather(match_tone(f, mids[0]), 'left', frac=0.18), ('top', 'bottom', 'right')) for f in tails]
tail_h = max(f.shape[0] for f in tails)
tail_w = max(f.shape[1] for f in tails)
tail_frames = [pad_to(f, tail_w, tail_h, 'left') for f in tails]
tail_out_h = max(1, int(round(tail_h * scale)))
tail_out_w = max(1, int(round(tail_w * scale)))
p, kb = save_anim(interpolate(tail_frames, FRAMES_OUT), 'qi-tail-anim.webp', (tail_out_w, tail_out_h))
print(f'右端  qi-tail-anim.webp  {tail_out_w}x{tail_out_h}  {kb:>6.1f} KB')

print('\n三段的條身都以 mid 為基準縮放，組起來垂直對得齊。')
print('中段的接縫誤差要小；大的話 background-repeat 會看得到直線。')
