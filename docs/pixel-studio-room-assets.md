# Pixel Studio — Room Scene Art Assets

> 本文件列出 Dungeon Pixel Studio Widget 改版所需的所有美術資產。
> 角色 sprite（worker-gemini/openai/ollama）及基礎 prop（torch/neon/smoke/alarm）已生成，**不需要重做**。
> 下方列出所有**需要新生成**的資產，附完整英文 prompt，可直接送 AI 生成。

---

## Global Style Rules（所有 prompt 適用）

- **Style**: 16-bit pixel art, isometric 2.5D perspective
- **Mood**: Dark dungeon with warm torch glow + cool cyan/green monitor glow
- **Palette**: Dark stone (#1b1d23) / warm wood (#6f4523) / amber torch (#f57c21) / neon cyan (#34f4d0) / purple rune (#9b5cff)
- **No anti-aliasing**, hard pixel edges only
- **No dithering**
- All character/prop sprites: **transparent background PNG**
- Room background: **solid (no transparency)**, fills the full canvas

---

## 已生成 ✅（不需要重做）

| 檔案 | 說明 |
|------|------|
| `worker-gemini-idle/working/busy/overloaded` | Gemini 巫師角色，4 個狀態 |
| `worker-openai-idle/working/busy/overloaded` | OpenAI 賽博龐克工程師，4 個狀態 |
| `worker-ollama-idle/working/busy/overloaded` | Ollama 隱士法師，4 個狀態 |
| `torch-anim` | 牆掛火把動畫，4 幀 |
| `neon-sign-anim` | 霓虹燈招牌動畫，2 幀 |
| `smoke-anim` | 煙霧效果，4 幀 |
| `alarm-light-anim` | 警示燈，2 幀 |

**以下所有資產放置路徑：`public/game-assets/sprites/pixel-studio/`**

---

## 需要新生成的資產

---

### 1. 房間背景 `studio-room-bg.png`

**🔴 最優先，其他所有實作都依賴這張圖的構圖**

**File**: `studio-room-bg.png` | **Size**: 800×600px | **Frames**: 1 (static)

> 重點：三張桌子的位置決定角色 sprite 的疊加座標，圖生出來後需要量測三張桌子椅子的中心點像素座標。

```
isometric pixel art dungeon coding studio room, 800x600 pixels, solid background no transparency,
dark stone brick walls with mortar lines, uneven worn stone floor with subtle color variation,
warm atmospheric interior lit by torch fire and monitor glow,

THREE WOODEN DESKS with these exact positions and roles:
- LEFT DESK (Gemini): positioned front-left of room, wooden desk with glowing BLUE-PURPLE crystal ball on desk surface, empty high-back wooden chair pulled in, small potted green plant beside desk, stack of spell books on corner,
- CENTER-RIGHT DESK (OpenAI): positioned center-right of room, wooden desk with DARK TERMINAL MONITOR showing green scrolling code, empty wooden chair, pair of headphones hanging on monitor corner, coffee mug, mechanical keyboard,
- BACK DESK (Ollama): positioned back-left elevated area, worn ancient wooden desk with OLD BATTERED LAPTOP showing purple rune glow, empty wooden chair, ancient scroll and thick tome on desk,

WALL DECORATIONS on back wall:
- neon sign frame (dark, no text — sign sprite handled separately) centered high on back wall,
- cork quest board pinned with paper notes on right side of back wall, papers slightly yellowed,
- purple vertical banner on left wall reading CODE vertically in pixel font,
- crossed torch brackets flanking the neon sign frame,

WALL PROPS on stone walls:
- two iron wall torch brackets with warm amber glow circles on left and right walls,
- wooden shelves with glowing potion bottles (cyan, green, purple) and skull decoration,

FLOOR PROPS:
- wooden barrel cluster in bottom-left corner with rope binding,
- treasure chest (closed, iron clasp) in bottom-right corner,
- small stone floor runes faintly glowing purple near Ollama desk,

LIGHTING:
- warm amber torch light casting soft shadows on stone walls,
- each desk has a cool blue-green monitor screen glow on desk surface and front of chair,
- purple rune ambient glow near back-left area,
- overall room feels like a dungeon that has been converted into a tech startup,

16-bit RPG pixel art style, isometric top-down 2.5D view, 45-degree angle,
high detail environment art, dark dungeon atmosphere, solid dark stone background,
NO CHARACTERS, NO PEOPLE, ALL CHAIRS ARE EMPTY, empty seats only
```

---

### 2. 汗珠動畫 `sweat-anim.png`

**File**: `sweat-anim.png` | **Size**: 24×12px | **Frames**: 3 horizontal (8×12px each)

```
pixel art sprite sheet, 3 frames side by side, each frame 8x12 pixels,
total size 24x12 pixels, anime-style sweat drop bead animation,
light blue teardrop shape with white highlight pixel, cartoon pixel art,
frame 1: small drop appearing at top, just a few pixels,
frame 2: full large drop, teardrop shape with highlight,
frame 3: drop stretched and falling downward, slightly faded,
transparent background, 16-bit pixel art style, clean hard edges
```

---

### 3. 桌子名牌 `nameplate-gemini.png` / `nameplate-openai.png` / `nameplate-ollama.png`

**File**: `nameplate-{provider}.png` | **Size**: 80×16px | **Frames**: 1 (static)

> 三張分開生成，只改文字內容。放在各 worker 腳下或桌子前緣。

**nameplate-gemini.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank with carved text,
dark wood grain texture (#6f4523), text reads "GEMINI" in pixel font,
text color: bright cyan (#34f4d0) with subtle glow halo,
iron nail holes at both ends, slight 3D beveled wood edge,
transparent background, 16-bit pixel art style, hard pixel edges
```

**nameplate-openai.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank with carved text,
dark wood grain texture (#6f4523), text reads "OPENAI" in pixel font,
text color: neon green (#6ef08d) with subtle glow halo,
iron nail holes at both ends, slight 3D beveled wood edge,
transparent background, 16-bit pixel art style, hard pixel edges
```

**nameplate-ollama.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank with carved text,
dark wood grain texture (#6f4523), text reads "OLLAMA" in pixel font,
text color: purple (#9b5cff) with subtle glow halo,
iron nail holes at both ends, slight 3D beveled wood edge,
transparent background, 16-bit pixel art style, hard pixel edges
```

---

### 4. 螢幕光暈 `monitor-glow.png`

**File**: `monitor-glow.png` | **Size**: 96×48px | **Frames**: 2 horizontal (48×48px each)

> 疊在桌面上模擬螢幕發光的光暈效果，隨狀態改色（idle=dim blue, busy=bright amber）。

```
pixel art monitor screen glow overlay sprite sheet, 2 frames side by side,
each frame 48x48 pixels, total size 96x48 pixels,
soft rectangular glow cast onto a desk surface, isometric angle,
no monitor body, only the projected light patch on a flat surface,
frame 1: dim cool blue-cyan glow (#35c7ff at low opacity), idle state,
frame 2: bright warm amber glow (#f2a33a at higher opacity), active/busy state,
the glow shape is an isometric parallelogram matching a desk surface angle,
transparent background outside glow area, 16-bit pixel art style
```

---

### 5. 任務板紙張紋理 `quest-board-bg.png`

**File**: `quest-board-bg.png` | **Size**: 192×256px | **Frames**: 1 (static)

> 作為右側任務板的背景底圖，文字內容由 CSS 疊加。

```
pixel art cork board texture, 192x256 pixels,
warm cork surface with subtle grain texture, natural beige-brown (#b8884a) tone,
dark wooden frame border (4px) with nail/tack details at corners,
slightly worn and aged appearance,
four small colored push-pin dots in corners (red, blue, yellow, green) for decoration,
no text, no notes, empty cork surface ready for content overlay,
transparent outside the wooden frame, 16-bit pixel art style, static
```

---

### 6. 水晶球脈衝動畫 `crystal-pulse.png`（選填）

**File**: `crystal-pulse.png` | **Size**: 64×24px | **Frames**: 4 horizontal (16×24px each)

> 置於 Gemini 桌上的水晶球脈衝發光動畫，隨 job 數量改變亮度。

```
pixel art sprite sheet, 4 frames side by side, each frame 16x24 pixels,
total size 64x24 pixels, magical crystal ball sitting on a small brass stand,
round orb shape with inner light glow animation,
frame 1: dim purple-blue inner glow, nearly dark,
frame 2: soft pulsing blue-purple light, medium brightness,
frame 3: bright white-blue flash at center, maximum glow, light radiating out,
frame 4: fading back to dim purple,
transparent background, 16-bit RPG pixel art style, magical aesthetic
```

---

### 7. 任務完成特效 `spark-anim.png`（選填）

**File**: `spark-anim.png` | **Size**: 128×32px | **Frames**: 4 horizontal (32×32px each)

> Job 完成時在角色頭頂播放的短暫 sparkle 特效。

```
pixel art sprite sheet, 4 frames side by side, each frame 32x32 pixels,
total size 128x32 pixels, magical sparkle burst animation,
small star-shaped light particles, yellow-gold and cyan colors,
frame 1: single center bright pixel, barely visible,
frame 2: four-pointed star burst expanding,
frame 3: larger eight-pointed sparkle with trailing pixels,
frame 4: particles dispersing outward and fading,
transparent background, 16-bit pixel art style, celebratory feel
```

---

## 生成順序

| 優先 | 檔案 | 原因 |
|------|------|------|
| 🔴 1st | `studio-room-bg.png` | 決定所有角色的疊加座標，必須先有才能實作 |
| 🟡 2nd | `nameplate-gemini/openai/ollama.png` | 三張一起生，小尺寸快速 |
| 🟡 2nd | `quest-board-bg.png` | 右側任務板底圖 |
| 🟡 2nd | `sweat-anim.png` | 補齊原本設計稿就有的效果 |
| 🟢 3rd | `monitor-glow.png` | 可用 CSS 暫代 |
| 🟢 3rd | `crystal-pulse.png` | 選填，氛圍加分 |
| 🟢 3rd | `spark-anim.png` | 選填，互動回饋 |

---

## 生成後的量測步驟（studio-room-bg.png）

生成 `studio-room-bg.png` 後，需要量出三張桌子椅子的中心點座標，供程式計算 worker sprite 的疊加位置：

```
LEFT DESK (Gemini):   x = ?, y = ?   ← 量椅子中心點
CENTER-RIGHT (OpenAI): x = ?, y = ?
BACK DESK (Ollama):   x = ?, y = ?
```

量測方式：在 Photoshop / Figma 開啟圖片，點選椅子坐面中心，記錄像素座標。

---

*v1.0 — Pixel Studio Room Scene Assets Spec*
