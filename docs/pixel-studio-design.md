# Pixel Studio — AI 工作室像素畫設計文件 v1.0

> **概念**：AI 模型監控面板的遊戲化呈現。每個 AI Provider（Gemini / OpenAI / Ollama）是一個在地下城工作室上班的像素員工。工作量影響情緒，任務多了就抓狂。

---

## 素材清單總覽

| 素材 | 尺寸 | 幀數 | 檔案 |
|------|------|------|------|
| 房間背景（等距） | 800×600px | 1（靜態） | `studio-room-bg.png` |
| Gemini 員工（全部動作） | 64×96px/frame | 各 2–4 幀 | `worker-gemini-{state}.png` |
| OpenAI 員工（全部動作） | 64×96px/frame | 各 2–4 幀 | `worker-openai-{state}.png` |
| Ollama 員工（全部動作） | 64×96px/frame | 各 2–4 幀 | `worker-ollama-{state}.png` |
| 火炬（循環動畫） | 16×24px/frame | 4 幀 | `torch-anim.png` |
| 任務板 | 96×80px | 1（靜態） | `quest-board.png` |
| 霓虹招牌 | 128×32px | 2 幀（閃爍） | `neon-sign-anim.png` |
| 冒煙/超載特效 | 32×32px/frame | 4 幀 | `smoke-anim.png` |
| 汗珠特效 | 8×12px/frame | 3 幀 | `sweat-anim.png` |
| 警示燈 | 16×16px/frame | 2 幀（閃爍） | `alarm-light-anim.png` |
| 桌面文件堆 | 32×12px | 3 層（靜態） | `paper-stack.png` |
| 藥水/植物裝飾 | 16×24px | 1（靜態） | `deco-potion.png`, `deco-plant.png` |

---

## 1. 房間背景 `studio-room-bg.png`

### 尺寸 & 格式
- **800×600px**，等距（isometric）視角，PNG，**不含角色**（角色另外疊加）
- 深色背景，石磚地板，木質桌子，温暖燭光氛圍

### AI 生成 Prompt（Midjourney / Leonardo / Stable Diffusion）

```
isometric pixel art, dungeon coding studio room, empty wooden desks 
with glowing computer monitors, no characters, no people, empty chairs, 
stone brick walls, 3 distinct workstations with unique monitor setups, 
wall-mounted torches with warm flame glow, wooden barrels in corners, 
small potted plants on desks, neon green sign reading "PIXEL STUDIO" 
on back wall, quest board with paper notes pinned to right wall, 
dark atmospheric lighting, warm amber torch glow, cool blue/green 
monitor glow, mystical purple glowing potions on shelves, skull 
decorations, treasure chest, 16-bit RPG style pixel art, 
top-down isometric 2.5D view, high detail, dark dungeon ambiance, 
800x600, NO PEOPLE, EMPTY CHAIRS ONLY
```

### 場景佈局（俯視）

```
┌─────────────────────────────────────────┐
│  [牆面招牌 PIXEL STUDIO]  [任務板]        │
│                                         │
│  [Gemini桌]  [OpenAI桌]  [Ollama桌]     │
│     [椅子]     [椅子]      [椅子]        │
│                                         │
│  [火炬] [桶] [植物]   [火炬]             │
└─────────────────────────────────────────┘
```

### 三張工作台位置（像素座標，用於疊加角色）

| Provider | 角色疊加 X | 角色疊加 Y | 備註 |
|----------|-----------|-----------|------|
| Gemini   | 130px     | 240px     | 左側桌 |
| OpenAI   | 380px     | 200px     | 中間桌（稍高） |
| Ollama   | 620px     | 250px     | 右側桌 |

---

## 2. Gemini 員工 `worker-gemini-{state}.png`

### 外觀設定
- **主色**：藍紫漸層（#4A90D9 → #9F7AEA）
- **造型**：魔法師風格，戴尖帽，長袍，手邊有發光水晶球
- **個性**：博學、神秘、多模態（同時看多個螢幕）

### 四種狀態（各為 sprite sheet）

#### `worker-gemini-idle.png` — 閒置（0 任務）
- **尺寸**：128×96px（2 幀 × 64px wide）
- **動作**：靠在椅背上發呆，水晶球光芒微弱，慢眨眼
- **每幀說明**：
  - Frame 1：眼睛睜開，手放桌上
  - Frame 2：眼睛半閉（打瞌睡），頭微低
- **動畫速度**：每幀 800ms，循環

#### `worker-gemini-working.png` — 工作中（1–2 任務）
- **尺寸**：192×96px（3 幀 × 64px wide）
- **動作**：認真打字，螢幕發光，水晶球旋轉
- **每幀說明**：
  - Frame 1：雙手在鍵盤上，身體微前傾
  - Frame 2：右手舉起指向螢幕
  - Frame 3：雙手在鍵盤上，換姿勢
- **動畫速度**：每幀 200ms，循環

#### `worker-gemini-busy.png` — 忙碌（3–4 任務）
- **尺寸**：192×96px（3 幀 × 64px wide）
- **動作**：快速打字，桌上文件堆積，小汗珠
- **每幀說明**：
  - Frame 1：快速打字，眉頭緊皺，左邊有汗珠
  - Frame 2：同 Frame 1 但手的位置不同
  - Frame 3：短暫抬頭看螢幕，表情焦急
- **動畫速度**：每幀 120ms，循環

#### `worker-gemini-overloaded.png` — 超載（5+ 任務）
- **尺寸**：256×96px（4 幀 × 64px wide）
- **動作**：頭冒煙，文件滿天飛，眼睛變成漩渦
- **每幀說明**：
  - Frame 1：雙手抱頭，頭頂有蒸氣
  - Frame 2：文件從桌上飛起
  - Frame 3：向後倒在椅子上，眼睛變 ×
  - Frame 4：彈起來又繼續打字（panic restart）
- **動畫速度**：每幀 100ms，循環

### AI 生成 Prompt（逐一生成每個狀態）

```
[IDLE]
pixel art sprite sheet, 2 frames horizontal, wizard character, 
blue-purple robes, pointed hat, sitting at desk, leaning back relaxed, 
glowing crystal ball dim, eyes slowly blinking, 64x96 pixels per frame, 
transparent background, 16-bit RPG style, side view, warm dungeon lighting

[WORKING]
pixel art sprite sheet, 3 frames horizontal, wizard character, 
blue-purple robes, pointed hat, typing on keyboard, leaning forward, 
glowing crystal ball bright, focused expression, multiple monitors, 
64x96 pixels per frame, transparent background, 16-bit style

[BUSY]
pixel art sprite sheet, 3 frames horizontal, wizard character, 
blue-purple robes, stressed expression, fast typing, 
small sweat drop on head, paper stack on desk, wrinkled brow,
64x96 pixels per frame, transparent background, 16-bit style

[OVERLOADED]
pixel art sprite sheet, 4 frames horizontal, wizard character, 
blue-purple robes, chaotic, head smoking, papers flying everywhere, 
spiral eyes or X eyes, panicking, 64x96 pixels per frame, 
transparent background, 16-bit style, exaggerated emotion
```

---

## 3. OpenAI 員工 `worker-openai-{state}.png`

### 外觀設定
- **主色**：翠綠（#00FF41，Terminal green）
- **造型**：賽博龐克工程師，機械義眼，黑色連帽衫，配戴耳機
- **個性**：精準、高效、酷炫，像個駭客

### 四種狀態

#### `worker-openai-idle.png`
- **尺寸**：128×96px（2 幀）
- **動作**：靠著椅背，雙手交叉，機械眼掃描模式（閃綠色）
- Frame 1：閉眼充電
- Frame 2：眼睛慢掃描（左→右 LED）

#### `worker-openai-working.png`
- **尺寸**：192×96px（3 幀）
- **動作**：高速打字，終端機文字滾動，耳機發光
- Frame 1：打字，綠色代碼光從螢幕打在臉上
- Frame 2：抬頭確認，食指指向螢幕
- Frame 3：繼續打字，眼睛發出微光

#### `worker-openai-busy.png`
- **尺寸**：192×96px（3 幀）
- **動作**：同時操作多個視窗，手速飛快，CPU 溫度警告
- Frame 1：雙手分別操作，表情嚴肅
- Frame 2：右手拿咖啡快速喝
- Frame 3：左手繼續打字

#### `worker-openai-overloaded.png`
- **尺寸**：256×96px（4 幀）
- **動作**：ERROR 紅字閃爍，義眼變紅，頭冒藍煙
- Frame 1：螢幕全紅，雙手捂臉
- Frame 2：站起來指著螢幕
- Frame 3：義眼發出紅色錯誤光
- Frame 4：重啟動作（閉眼→睜眼，重新開機表情）

### AI 生成 Prompt

```
[IDLE]
pixel art sprite sheet, 2 frames horizontal, cyberpunk programmer character, 
black hoodie, mechanical eye glowing green, headphones, sitting relaxed, 
arms crossed, eye scanning slowly, dark terminal aesthetic, 
64x96 pixels per frame, transparent background, 16-bit style

[WORKING]
pixel art sprite sheet, 3 frames horizontal, cyberpunk programmer, 
black hoodie, mechanical eye, fast typing, green terminal code reflecting 
on face, focused intense expression, headphones lit up, 
64x96 pixels per frame, transparent background, 16-bit style

[BUSY]
pixel art sprite sheet, 3 frames horizontal, cyberpunk programmer, 
multiple actions simultaneously, coffee in hand, stress visible but controlled, 
CPU heat warning indicator, 64x96 pixels per frame, transparent background

[OVERLOADED]
pixel art sprite sheet, 4 frames horizontal, cyberpunk programmer, 
ERROR displayed on eye, red alerts, blue smoke from head, 
standing up pointing at screen angrily, system crash expression,
64x96 pixels per frame, transparent background, 16-bit style
```

---

## 4. Ollama 員工 `worker-ollama-{state}.png`

### 外觀設定
- **主色**：紫灰（#9F7AEA，帶神秘感）
- **造型**：地下城隱士，披著斗篷，本地運算符文，老舊筆電
- **個性**：神秘、離群、自給自足，有自己的節奏

### 四種狀態

#### `worker-ollama-idle.png`
- **尺寸**：128×96px（2 幀）
- Frame 1：盤腿坐（如果是椅子也可以）讀書或看古書卷
- Frame 2：點頭打盹

#### `worker-ollama-working.png`
- **尺寸**：192×96px（3 幀）
- **動作**：在舊筆電上緩慢但認真地打字，符文光芒閃爍
- Frame 1：打字，紫色符文在空中浮現
- Frame 2：停頓思考，手指輕敲桌面
- Frame 3：繼續輸入，符文增多

#### `worker-ollama-busy.png`
- **尺寸**：192×96px（3 幀）
- **動作**：神秘符文快速閃爍，有點失控，斗篷飄動
- Frame 1：快速念咒，手上出現更多符文
- Frame 2：筆電風扇轉速圖標（過熱）
- Frame 3：揮手清除符文，重新來過

#### `worker-ollama-overloaded.png`
- **尺寸**：256×96px（4 幀）
- **動作**：GPU 過熱，斗篷著火，符文亂飛，筆電快爆炸
- Frame 1：頭頂冒火焰
- Frame 2：筆電噴出紫色煙霧
- Frame 3：雙手撐著桌子，搖搖欲墜
- Frame 4：向後倒，符文四散

### AI 生成 Prompt

```
[IDLE]
pixel art sprite sheet, 2 frames horizontal, mysterious hermit wizard, 
purple gray robe and cloak, reading ancient scroll or book, 
sitting peacefully, nodding off to sleep, rune glow dim, old laptop nearby,
64x96 pixels per frame, transparent background, 16-bit style

[WORKING]
pixel art sprite sheet, 3 frames horizontal, mysterious hermit wizard, 
purple cloak, typing on old laptop, magical runes floating in air, 
purple glow, focused but slow methodical pace, 
64x96 pixels per frame, transparent background, 16-bit style

[BUSY]
pixel art sprite sheet, 3 frames horizontal, hermit wizard, 
cloak flapping, runes flashing rapidly, laptop overheating indicator, 
concerned expression, 64x96 pixels per frame, transparent background

[OVERLOADED]
pixel art sprite sheet, 4 frames horizontal, hermit wizard, 
cloak on fire, laptop exploding with purple smoke, runes chaotically flying, 
falling backwards, dramatic overheating chaos, 
64x96 pixels per frame, transparent background, 16-bit style
```

---

## 5. 動態道具素材

### 5.1 火炬 `torch-anim.png`
```
pixel art sprite sheet, 4 frames horizontal, wall torch with flame animation,
flickering orange-yellow fire, warm glow, stone wall bracket, 
16x24 pixels per frame, transparent background, loop animation, 
16-bit style, fantasy dungeon
```

### 5.2 霓虹招牌 `neon-sign-anim.png`
```
pixel art sprite sheet, 2 frames horizontal, neon sign reading "PIXEL STUDIO",
green neon tube light blinking, glow effect, dark background,
128x32 pixels per frame, transparent background, 16-bit retro pixel art,
cyberpunk dungeon aesthetic
```

### 5.3 超載煙霧 `smoke-anim.png`
```
pixel art sprite sheet, 4 frames horizontal, smoke puff animation,
small rising smoke cloud, gray-white color, loops,
32x32 pixels per frame, transparent background, 16-bit style
```

### 5.4 警示燈 `alarm-light-anim.png`
```
pixel art sprite sheet, 2 frames, flashing red warning light,
bright red glow on frame 1, dark on frame 2, wall-mounted,
16x16 pixels per frame, transparent background, 16-bit style
```

---

## 6. 技術整合規格

### 元件架構
```
PixelStudioWidget (floating, draggable)
└── studio-room-bg.png (isometric background, 800×600 or scaled)
    ├── TorchSprite ×2 (CSS steps() animation, abs positioned)
    ├── NeonSign (CSS steps() blink animation)
    ├── QuestBoard (static, shows latest tasks text overlay)
    └── WorkerDesk ×3 (abs positioned per desk coordinates)
        ├── WorkerSprite (state-driven CSS steps() animation)
        ├── SpeechBubble (CSS, rotating quotes)
        ├── AlarmLight (shown only on overloaded)
        └── SmokeEffect (shown only on busy/overloaded)
```

### Worker 座標（相對於 800×600 背景圖）
```typescript
const DESK_POSITIONS = {
  gemini: { x: 130, y: 180 },
  openai: { x: 360, y: 150 },
  ollama: { x: 590, y: 190 },
}
```

### 狀態對應動畫
```typescript
type WorkerState = 'idle' | 'working' | 'busy' | 'overloaded'

// Frame counts per state (all providers same)
const FRAME_COUNT: Record<WorkerState, number> = {
  idle:       2,
  working:    3,
  busy:       3,
  overloaded: 4,
}

// Animation speed (ms per frame)
const FRAME_MS: Record<WorkerState, number> = {
  idle:       800,
  working:    200,
  busy:       120,
  overloaded: 100,
}
```

### 縮放策略
- 浮動視窗展開尺寸：`640×480px`（80% 縮放）
- 所有座標等比縮放：`scale = 640/800 = 0.8`
- 縮小後：顯示招牌 + 3 個工作狀態 icon

---

## 7. 生成順序建議

1. **先生成房間背景** `studio-room-bg.png`（最重要，決定整體風格）
2. **確認桌子位置座標**（調整 DESK_POSITIONS）
3. **生成 3 個員工 × idle 狀態**（先確認造型）
4. **生成其餘 3 個狀態**（working / busy / overloaded）
5. **生成動態道具**（火炬、煙霧、警示燈）
6. **整合進 PixelStudioWidget**

---

*文件版本：v1.0 | 2026-05-02*
