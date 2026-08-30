"""
把 CodeX 出的 sprite atlas 切成「左端／中段／右端」三段。

⚠️ **不要假設它是規則格線**。生成模型排出來的精靈大小、間距都不一致，
按 rows/cols 均分切會切歪——所以這裡用 alpha 投影去偵測每個精靈的實際邊界。

atlas 結構（依實際偵測結果對照，不是猜的）：
  第 1~2 列 = 左端頭（圓弧收尾）
  第 3~4 列 = 中段（要無縫平鋪）
  第 5~6 列 = 右端頭（靈氣發散）
每一列 4 張 = 4 格序列幀；兩列 = 2 種密度。

跑法：python scripts/ui-checks/slice-qi-atlas.py
"""
import os
import numpy as np
from PIL import Image

# 來源 atlas 收在 repo 裡（assets-src/），這樣整條流程從乾淨的 checkout 就跑得起來。
# 原始檔是 CodeX 生成的，他那邊的路徑會隨對話 session 變動，不能當長期依賴。
ATLAS = os.path.join('assets-src', 'xianxia', 'qi-atlas.png')
if not os.path.exists(ATLAS):
    raise SystemExit(f'找不到來源 atlas：{ATLAS}')
OUT = os.path.join('public', 'themes', 'xianxia', 'qi-parts')

ALPHA_MIN = 32    # 用來「分離精靈」的門檻。
# ⚠️ 不要用 128：實測 tail 那一列在 128 下會量到 5 段——其中一個間隙只有 17px，
#    那是**同一張圖內部**的空隙，不是兩張圖之間。用 128 會把一張圖切成兩半。
#    降到 32 之後穩定量到 4 段、最小欄間隙 36px。
# ⚠️ 但「裁切單張」要用低很多的門檻。發散的細芒 alpha 遠低於 128，
#    用 128 去裁會把最外圈的光絲整圈切掉——使用者回報「右端有被裁切的感覺」就是這個。
CROP_MIN = 6
PAD = 14          # 往外擴多少。精靈間距實測只有 30~36px，所以最多只能擴一半；
                  # 再多就會把隔壁的光暈吃進來。
# ⚠️ 因為間距就這麼窄，光暈本來就跨到隔壁去了，**完美分離做不到**。
#    被切到的部分改由 build-qi-parts.py 的外緣羽化處理，讓它淡出而不是硬斷。


def bands(mask_1d, min_len=8, gap=6):
    """把一維布林陣列切成連續區段，容忍 gap 以內的空隙。
    容忍空隙是必要的——精靈內部本來就可能有幾列幾乎全透明。"""
    idx = np.where(mask_1d)[0]
    if len(idx) == 0:
        return []
    out, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > gap:
            if prev - start + 1 >= min_len:
                out.append((start, prev + 1))
            start = i
        prev = i
    if prev - start + 1 >= min_len:
        out.append((start, prev + 1))
    return out


im = Image.open(ATLAS).convert('RGBA')
a = np.asarray(im)
alpha = a[..., 3]
solid = alpha >= ALPHA_MIN

print(f'atlas: {im.size[0]}x{im.size[1]}  有內容像素 {solid.mean()*100:.1f}%\n')

rows = bands(solid.any(axis=1), min_len=20, gap=10)
print(f'偵測到 {len(rows)} 個橫列：')
os.makedirs(OUT, exist_ok=True)

ROLE = ['cap', 'cap', 'mid', 'mid', 'tail', 'tail']
saved = []

for ri, (y0, y1) in enumerate(rows):
    strip = solid[y0:y1]
    cols = bands(strip.any(axis=0), min_len=20, gap=12)
    role = ROLE[ri] if ri < len(ROLE) else f'row{ri}'
    dens = 'a' if ri % 2 == 0 else 'b'
    print(f'  第{ri+1}列 y={y0}~{y1} (高 {y1-y0})  {len(cols)} 張  → {role}-{dens}')
    for ci, (x0, x1) in enumerate(cols):
        # 往外擴一點再取，讓淡到快看不見的光芒也留在框內；
        # 上下用整張圖的範圍去擴，因為發散會超出「列」的偵測邊界
        ex0 = max(0, x0 - PAD)
        ex1 = min(a.shape[1], x1 + PAD)
        ey0 = max(0, y0 - PAD)
        ey1 = min(a.shape[0], y1 + PAD)
        sub = a[ey0:ey1, ex0:ex1]
        # 用**低門檻**收緊，只切掉真正空無一物的部分
        sa = sub[..., 3] >= CROP_MIN
        rr = np.where(sa.any(axis=1))[0]
        cc = np.where(sa.any(axis=0))[0]
        if len(rr) == 0 or len(cc) == 0:
            continue
        sub = sub[rr[0]:rr[-1] + 1, cc[0]:cc[-1] + 1]
        name = f'{role}-{dens}-{ci}.png'
        Image.fromarray(sub).save(os.path.join(OUT, name), optimize=True)
        saved.append((name, sub.shape[1], sub.shape[0]))

print(f'\n切出 {len(saved)} 張 → {OUT}')
w = {}
for n, ww, hh in saved:
    key = n.rsplit('-', 1)[0]
    w.setdefault(key, []).append((ww, hh))
print('\n各組尺寸（同一組的尺寸要接近，差太多代表偵測有問題）：')
for k, v in w.items():
    ws = [x[0] for x in v]
    hs = [x[1] for x in v]
    print(f'  {k:<8} {len(v)} 張  寬 {min(ws)}~{max(ws)}  高 {min(hs)}~{max(hs)}')
