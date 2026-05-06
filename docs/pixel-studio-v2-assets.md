# Pixel Studio v2 — Complete Art Asset Spec

> 本文件整合所有需要生成的美術資產（房間場景 + 機器人角色重設計）。
> 按照生成順序執行，先確認外觀再批量生成動作狀態。

---

## Global Style Rules（所有 prompt 適用）

- **Style**: 16-bit pixel art
- **Mood**: Dark dungeon with warm torch glow + cool cyan/green monitor glow
- **Palette**: Dark stone `#1b1d23` / warm wood `#6f4523` / amber torch `#f57c21` / neon cyan `#34f4d0` / purple rune `#9b5cff`
- **No anti-aliasing**, hard pixel edges only, no dithering
- **Character sprites**: transparent background PNG, 64×96px per frame, horizontal sprite sheet, character faces slightly right
- **Room background**: solid background (no transparency), 800×600px

---

## 已生成 ✅（不需要重做）

| 類別 | 檔案 |
|------|------|
| Props | `torch-anim`, `neon-sign-anim`, `smoke-anim`, `alarm-light-anim` |

> 舊版角色 sprite（巫師/工程師/隱士）將被新版機器人覆蓋。

---

## 生成順序總覽

| 順序 | 類別 | 檔案數 | 說明 |
|------|------|--------|------|
| 🔴 Step 1 | 房間背景 | 1 | 決定所有構圖基準 |
| 🔴 Step 2 | 機器人 idle × 3 | 3 | 確認三個角色外觀 |
| 🟡 Step 3 | 機器人 working/busy/overloaded × 3 | 9 | 外觀確認後批量生成 |
| 🟡 Step 4 | 場景 UI 資產 | 5 | 任務板、名牌、汗珠等 |
| 🟢 Step 5 | 選填特效 | 3 | 水晶脈衝、任務完成特效等 |

---

# PART A — 房間場景資產

---

## A-1. 房間背景 `studio-room-bg.png`

**🔴 最優先 — 生成後需量測三張桌子椅子的中心點座標**

**File**: `studio-room-bg.png` | **Size**: 800×600px | **Frames**: 1 (static)
**Path**: `public/game-assets/sprites/pixel-studio/studio-room-bg.png`

```
isometric pixel art dungeon coding studio room, 800x600 pixels, solid background no transparency,
dark stone brick walls with mortar lines, uneven worn stone floor with subtle color variation,
warm atmospheric interior lit by torch fire and monitor glow,

THREE WOODEN DESKS with these exact positions and roles:
- LEFT DESK (Gemini): positioned front-left of room, wooden desk with glowing BLUE-PURPLE
  crystal ball on desk surface, empty high-back wooden chair pulled in,
  small potted green plant beside desk, stack of spell books on corner,
- CENTER-RIGHT DESK (OpenAI): positioned center-right of room, wooden desk with DARK TERMINAL
  MONITOR showing green scrolling code, empty wooden chair, pair of headphones hanging on
  monitor corner, coffee mug, mechanical keyboard,
- BACK DESK (Ollama): positioned back-left elevated area, worn ancient wooden desk with OLD
  BATTERED LAPTOP showing purple rune glow, empty wooden chair,
  ancient scroll and thick tome on desk,

WALL DECORATIONS on back wall:
- neon sign frame (dark, no text) centered high on back wall,
- cork quest board pinned with paper notes on right side of back wall,
- purple vertical banner on left wall with CODE vertically in pixel font,
- crossed torch brackets flanking the neon sign frame,

WALL PROPS on stone walls:
- two iron wall torch brackets with warm amber glow on left and right walls,
- wooden shelves with glowing potion bottles (cyan, green, purple) and skull decoration,

FLOOR PROPS:
- wooden barrel cluster in bottom-left corner with rope binding,
- treasure chest (closed, iron clasp) in bottom-right corner,
- small stone floor runes faintly glowing purple near back-left desk,

LIGHTING:
- warm amber torch light casting soft shadows on stone walls,
- each desk has a cool blue-green monitor screen glow on desk surface and chair,
- purple rune ambient glow near back-left area,
- room feels like a dungeon converted into a tech startup,

16-bit RPG pixel art style, isometric top-down 2.5D view, 45-degree angle,
high detail environment art, dark dungeon atmosphere, solid dark stone background,
NO CHARACTERS, NO PEOPLE, ALL CHAIRS ARE EMPTY, empty seats only
```

> **生成後操作**：用 Photoshop / Figma 量出三張椅子坐面中心點的 (x, y) 像素座標，回傳給我。

---

## A-2. 任務板底圖 `quest-board-bg.png`

**File**: `quest-board-bg.png` | **Size**: 192×256px | **Frames**: 1 (static)
**Path**: `public/game-assets/sprites/pixel-studio/quest-board-bg.png`

```
pixel art cork board texture, 192x256 pixels,
warm cork surface with subtle grain texture, natural beige-brown (#b8884a) tone,
dark wooden frame border 4px thick with nail details at corners,
slightly worn and aged appearance, faint stain marks on cork,
four small colored push-pin dots at corners (red, blue, yellow, green) for decoration,
no text, no notes, empty cork surface ready for content overlay,
solid opaque background inside wooden frame area, 16-bit pixel art style, static
```

---

## A-3. 桌前名牌 × 3

**Size**: 80×16px each | **Frames**: 1 (static)
**Path**: `public/game-assets/sprites/pixel-studio/nameplate-{provider}.png`

**nameplate-gemini.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank,
dark wood grain texture (#6f4523), text reads "GEMINI" in small pixel font,
text color bright cyan (#34f4d0) with 1px glow halo,
iron nail holes at both ends, slight 3D bevel on wood edge,
transparent background, 16-bit pixel art, hard edges
```

**nameplate-openai.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank,
dark wood grain texture (#6f4523), text reads "OPENAI" in small pixel font,
text color neon green (#6ef08d) with 1px glow halo,
iron nail holes at both ends, slight 3D bevel on wood edge,
transparent background, 16-bit pixel art, hard edges
```

**nameplate-ollama.png**
```
pixel art wooden nameplate sign, 80x16 pixels, horizontal flat wooden plank,
dark wood grain texture (#6f4523), text reads "OLLAMA" in small pixel font,
text color purple (#9b5cff) with 1px glow halo,
iron nail holes at both ends, slight 3D bevel on wood edge,
transparent background, 16-bit pixel art, hard edges
```

---

## A-4. 汗珠動畫 `sweat-anim.png`

**File**: `sweat-anim.png` | **Size**: 24×12px | **Frames**: 3 horizontal (8×12px each)
**Path**: `public/game-assets/sprites/pixel-studio/sweat-anim.png`

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

## A-5. 螢幕光暈 `monitor-glow.png`（選填）

**File**: `monitor-glow.png` | **Size**: 96×48px | **Frames**: 2 horizontal (48×48px each)
**Path**: `public/game-assets/sprites/pixel-studio/monitor-glow.png`

```
pixel art monitor screen glow overlay sprite sheet, 2 frames side by side,
each frame 48x48 pixels, total size 96x48 pixels,
soft rectangular glow cast onto a desk surface from isometric angle,
no monitor body, only the projected light patch on a flat desk surface,
frame 1: dim cool blue-cyan glow (#35c7ff), idle state, soft edges,
frame 2: bright warm amber-green glow (#f2a33a), active/busy state, stronger halo,
glow shape is an isometric parallelogram matching a desk surface at 45 degrees,
transparent background outside glow area, 16-bit pixel art style
```

---

## A-6. 任務完成特效 `spark-anim.png`（選填）

**File**: `spark-anim.png` | **Size**: 128×32px | **Frames**: 4 horizontal (32×32px each)
**Path**: `public/game-assets/sprites/pixel-studio/spark-anim.png`

```
pixel art sprite sheet, 4 frames side by side, each frame 32x32 pixels,
total size 128x32 pixels, magical sparkle burst animation,
small star-shaped light particles, yellow-gold and cyan colors,
frame 1: single center bright pixel, barely visible,
frame 2: four-pointed star burst expanding outward,
frame 3: larger eight-pointed sparkle with trailing pixels dispersing,
frame 4: particles fully scattered and fading out,
transparent background, 16-bit pixel art style, celebratory feel
```

---

# PART B — 機器人角色重設計

> **覆蓋路徑**：`public/game-assets/sprites/pixel-studio/worker-{provider}-{state}/`
> 程式碼路徑不變，直接覆蓋即可。

---

## 三種機器人設計

| 機器人 | 代號 | 配色 | 頭部 | 特徵 |
|--------|------|------|------|------|
| Gemini | Crystal Core 水晶核心 | 藍灰底 + 青色光 `#34f4d0` | 球形水晶頭，內發光 | 漂浮水晶碎片天線、胸口寶石陣列 |
| OpenAI | Matrix Unit 矩陣單元 | 消光黑底 + 終端綠 `#6ef08d` | 方形 4×4 LED 點陣臉 | 胸口代碼滾動面板、手臂電纜 |
| Ollama | Arcane Automaton 秘法機械人 | 銅色底 + 紫符文 `#9b5cff` | 圓形艙口，破裂單眼鏡 | 符文蝕刻、肩膀蒸汽排氣口、鉚釘凹痕 |

---

## B-1. GEMINI — Crystal Core Robot

### B-1a. Idle

**File**: `worker-gemini-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, smooth rounded blue-grey metallic robot character,
spherical crystal orb head with dim cyan inner glow (#34f4d0), two small floating crystal
shard antenna hovering above head, slim mechanical arms, gem array panel on chest
showing dim blue dots, seated at wooden desk in relaxed pose,
frame 1: both arms resting flat on desk surface, crystal head glow dim and steady,
upright posture, eye-glow soft blue circle,
frame 2: head tilts slightly to one side, one arm supports chin,
crystal glow very dim, almost dormant standby mode, antenna shards drooping,
transparent background, 16-bit RPG pixel art, warm dungeon side lighting,
no background, facing slightly right
```

### B-1b. Working

**File**: `worker-gemini-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, smooth rounded blue-grey metallic robot,
spherical crystal head glowing bright cyan, crystal antenna shards spinning slowly,
typing on keyboard at desk with focused energy,
frame 1: both hands on keyboard, head glow bright cyan, leaning slightly forward,
chest gem array showing active pulsing blue pattern,
frame 2: one arm extends pointing at monitor, head turned slightly toward screen,
crystal glow intensified with small radiant lines around orb,
frame 3: both hands typing, slightly different arm angle, antenna crystals raised higher,
transparent background, 16-bit RPG pixel art style, no background
```

### B-1c. Busy

**File**: `worker-gemini-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, smooth rounded blue-grey robot under pressure,
crystal head flickering between cyan and white, antenna shards rotating faster,
small pixel sweat drop on side of head, urgent fast typing,
frame 1: both hands rapid typing, crystal head flickering, sweat drop visible left side,
chest panel showing rapid blinking overload pattern,
frame 2: one hand typing, other hand raised in stressed gesture palm-out,
crystal antenna shards spinning rapidly in tight circles,
frame 3: both hands back typing, head jitter, chest panel alarm flashing pattern,
transparent background, 16-bit RPG pixel art style, no background
```

### B-1d. Overloaded

**File**: `worker-gemini-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, smooth rounded blue-grey robot in full meltdown,
crystal head overloading with blinding white-cyan flash, antenna shards flying off,
frame 1: both hands gripping head, crystal cracking with bright light beams shooting out,
chest panel showing ERROR X pattern in red pixels,
frame 2: standing up slightly from chair, arms spread wide, crystal exploding with light burst,
frame 3: slumped forward, head on desk, crystal dim with static flicker, antenna shards drooped,
frame 4: snapping back upright, crystal rebooting from dark to bright cyan, antenna realigning,
transparent background, 16-bit RPG pixel art style, exaggerated cartoon emotion, no background
```

---

## B-2. OPENAI — Matrix Unit Robot

### B-2a. Idle

**File**: `worker-openai-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, matte black angular blocky robot character,
rectangular head with 4x4 green LED matrix display as face showing two simple dot-eyes,
broad square shoulders with hex bolt details, chest panel dark with dim green standby bar,
cable wire hanging loosely from left arm wrist, seated at desk in standby pose,
frame 1: arms crossed resting on desk, LED face two-dot eyes dim, chest panel very dim,
fully rigid upright standby posture,
frame 2: one arm resting on desk, head turns slightly right, LED face shows slow scan-line
animation moving top to bottom across matrix, chest panel blinks once softly,
transparent background, 16-bit RPG pixel art, no background, facing slightly right
```

### B-2b. Working

**File**: `worker-openai-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, matte black angular robot, LED face showing focused expression
(dot pattern like two eyes with one row raised, like a raised eyebrow),
chest panel displaying bright scrolling green terminal code lines, actively typing at desk,
frame 1: both mechanical hands on keyboard, LED face focused, chest panel scrolling bright,
leaning slightly forward into desk,
frame 2: right arm extends to point at monitor screen, LED face arrow-pattern indicator,
head tilted toward screen,
frame 3: both hands back on keyboard, LED face determined two-dot pattern,
chest code scrolling, cable arm swinging slightly from movement,
transparent background, 16-bit RPG pixel art style, no background
```

### B-2c. Busy

**File**: `worker-openai-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, matte black angular robot under stress,
LED face showing warning ! symbol pattern, chest panel overloaded with rapid blinking code,
small steam puff from shoulder joint bolt,
frame 1: rapid typing both hands, LED face shows ! warning symbol in matrix, steam from shoulder,
chest panel red-green mixed overload blinking pattern,
frame 2: one mechanical hand holds coffee mug raised to face in sipping gesture,
other hand still typing, LED face shows loading bar animation,
frame 3: both hands slam back on keyboard, LED face shows overload XX pattern,
cable arm shaking, chest panel full alarm red,
transparent background, 16-bit RPG pixel art style, no background
```

### B-2d. Overloaded

**File**: `worker-openai-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, matte black angular robot critical failure mode,
LED face showing BSOD or ERROR in blinking red matrix pixels, chest panel sparking,
frame 1: both hands covering LED face, red ERROR pixel banner floating above head,
chest panel shooting pixel sparks,
frame 2: standing up from chair, mechanical fist raised toward monitor,
LED face shows angry X-X expression in matrix, chest panel on fire (pixel flame),
frame 3: LED face shows BSOD blue pattern, arms frozen mid-raise, body locked up rigid,
frame 4: collapsing back into chair, LED face rebooting black to green startup pattern,
chest panel restarting with single scan line,
transparent background, 16-bit RPG pixel art style, exaggerated, no background
```

---

## B-3. OLLAMA — Arcane Automaton Robot

### B-3a. Idle

**File**: `worker-ollama-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, boxy copper-bronze vintage robot character,
round porthole-style head, left eye dim orange circle LED, right eye cracked monocle
with faint purple glow leaking from the crack, riveted boxy chest with worn purple rune
etchings, small steam vent on right shoulder, seated at worn desk with old battered laptop,
frame 1: chunky hands resting on laptop keyboard, upright but slow posture,
rune etchings glowing very dim purple, monocle crack purple glow minimal,
left eye looking forward,
frame 2: head droops forward entering sleep mode, hands still on keyboard,
small ZZZ pixel letters floating above head, steam vent releases tiny puff,
rune etchings completely dark,
transparent background, 16-bit RPG pixel art, warm dungeon lighting, no background,
facing slightly right
```

### B-3b. Working

**File**: `worker-ollama-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, boxy copper-bronze vintage robot,
rune etchings glowing soft purple, monocle crack leaking more purple glow,
typing slowly but steadily on old battered laptop, methodical deliberate pace,
frame 1: both chunky hands on old laptop keys, chest rune glowing softly,
left eye dim orange, sitting upright and focused,
frame 2: one chunky hand raised to chin thinking pose, monocle eye zooms in (lens enlarged),
shoulder rune brightens to medium purple,
frame 3: both hands back to laptop typing, additional forearm rune activates glowing,
steam vent releases small puff,
transparent background, 16-bit RPG pixel art style, no background
```

### B-3c. Busy

**File**: `worker-ollama-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, boxy copper-bronze vintage robot under heavy load,
ALL rune etchings blazing bright purple, monocle crack fully glowing and leaking purple light,
steam vent on shoulder venting steam constantly, fast typing despite heavy body,
frame 1: both chunky hands rapid typing, all runes blazing, steam venting from shoulder,
monocle crack fully bright, old laptop showing heat haze distortion lines above it,
frame 2: one hand waves at sparking rune overactivating on chest, other hand still typing,
rivets on body glowing orange-hot from heat buildup,
frame 3: hunched forward over laptop, body surrounded by purple energy haze outline,
monocle crack now a full lightning-bolt fracture from eye socket to cheek,
transparent background, 16-bit RPG pixel art style, no background
```

### B-3d. Overloaded

**File**: `worker-ollama-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, boxy copper-bronze vintage robot complete meltdown,
runes exploding with purple plasma bolts, monocle eye shattered, steam venting everywhere,
frame 1: head on fire with purple arcane flame, both chunky hands grabbing head in horror,
monocle completely shattered with purple sparks arcing off,
frame 2: old laptop exploding with purple smoke and sparks shooting upward,
robot body recoiling backward from the blast,
frame 3: standing up with both chunky arms spread wide, all runes firing chaotic purple bolts,
energy arcing between bolts on body,
frame 4: falling backward off chair, all runes dark and silent, steam from every joint,
monocle dangling by a wire, old laptop fizzing on desk with small pixel flame,
transparent background, 16-bit RPG pixel art style, dramatic exaggerated, no background
```

---

# Output Folder

所有資產放入：
```
public/game-assets/sprites/pixel-studio/
```

角色 sprite 放入對應子資料夾（與現有結構一致）：
```
worker-gemini-idle/sheet-transparent.png  ← 主圖
worker-gemini-idle/worker-gemini-idle-1.png  ← 分幀
worker-gemini-idle/worker-gemini-idle-2.png
...（其餘 provider 和狀態同理）
```

---

*v2.0 — Pixel Studio Complete Asset Spec (Room + Robot Characters)*
