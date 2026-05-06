# Pixel Studio — Robot Worker Sprites (v2)

> 三種像素機器人角色，取代原本的巫師/工程師/隱士設計。
> 風格統一為「地下城蒸汽朋克機器人」，配合工作室背景。
> 所有 sprite 路徑不變（`worker-gemini-*/worker-openai-*/worker-ollama-*`），程式碼不需修改。

---

## Global Style Rules（所有 prompt 適用）

- **Style**: 16-bit pixel art, RPG side-view with slight isometric lean
- **View**: Character faces slightly right, seated at desk pose
- **Cell size**: 64×96px per frame, horizontal sprite sheet
- **Background**: Transparent PNG
- **No anti-aliasing**, hard pixel edges only
- **No dithering**
- Robots should look mechanical but expressive — emotes via eye/LED display changes

---

## Robot Design Reference

| Robot | Code Name | Color Scheme | Head | Body | Special Feature |
|-------|-----------|-------------|------|------|-----------------|
| Gemini | Crystal Core | Blue-cyan (#34f4d0) + midnight blue | Round crystal orb, inner glow | Smooth rounded chassis | Floating crystal antenna shards, glowing gem chest |
| OpenAI | Matrix Unit | Terminal green (#6ef08d) + matte black | Rectangular LED matrix face | Angular blocky shoulders | Green scrolling code on chest panel, cable arms |
| Ollama | Arcane Automaton | Bronze (#8b5e3c) + purple rune (#9b5cff) | Round porthole, monocle eye | Boxy riveted vintage body | Purple rune etchings, steam vent, cracked monocle |

---

## 1. GEMINI — Crystal Core Robot

> **Appearance**: Smooth rounded blue-grey metallic body, spherical crystal head with pulsing cyan inner glow, two small floating crystal shards as antenna, slim elegant arms with glowing LED fingertips, gem array panel on chest.

### 1a. Idle (0 jobs)

**File**: `worker-gemini-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, blue-grey smooth rounded robot character,
spherical crystal orb head with dim cyan inner glow, two small floating crystal
shard antenna hovering slightly above head, slim mechanical arms, gem array panel on chest
showing dim blue dots, seated at a wooden desk in relaxed pose,
frame 1: arms resting on desk surface, crystal head glow dim and steady,
hands flat on desk, upright posture, eye-glow soft blue circle,
frame 2: head tilts slightly to one side, one arm supports chin,
crystal glow very dim, almost dormant standby mode,
transparent background, 16-bit RPG pixel art, warm dungeon side lighting,
no background, facing slightly right
```

### 1b. Working (1–2 jobs)

**File**: `worker-gemini-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, blue-grey rounded robot, spherical crystal head
glowing bright cyan, crystal antenna shards spinning slowly,
typing on keyboard at desk with focused energy,
frame 1: both hands on keyboard, head glow bright cyan, leaning slightly forward,
chest gem array showing active blue pattern,
frame 2: one arm extends pointing at monitor, head turned slightly,
crystal glow intensified with small radiant lines,
frame 3: both hands typing, slightly different arm angle, antenna crystals higher,
transparent background, 16-bit RPG pixel art style, no background
```

### 1c. Busy (3–4 jobs)

**File**: `worker-gemini-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, blue-grey rounded robot under pressure,
crystal head flickering between cyan and white, antenna shards rotating faster,
fast typing with urgency, small pixel sweat drop on side of head,
frame 1: both hands rapid typing, crystal head flickering, sweat drop visible,
chest panel showing rapid blinking pattern,
frame 2: one hand typing, other hand raised in stressed gesture,
crystal antenna shards spinning rapidly,
frame 3: both hands typing again, head jitter, chest panel alarm pattern,
transparent background, 16-bit RPG pixel art style, no background
```

### 1d. Overloaded (5+ jobs)

**File**: `worker-gemini-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, blue-grey rounded robot in full meltdown,
crystal head overloading with blinding white-cyan flash, antenna shards flying off,
frame 1: both hands on head, crystal cracking with bright light beams shooting out,
frame 2: standing up slightly, arms spread, crystal exploding with light,
chest panel showing ERROR X pattern,
frame 3: slumped forward, head on desk, crystal dim with static flicker,
antenna shards drooped down,
frame 4: snapping back upright, crystal rebooting from dark to bright cyan again,
transparent background, 16-bit RPG pixel art style, exaggerated cartoon emotion, no background
```

---

## 2. OPENAI — Matrix Unit Robot

> **Appearance**: Boxy angular matte-black robot, rectangular head with 4×4 green LED matrix display as face (changes expression via LED patterns), broad mechanical shoulders with visible joint bolts, chest has scrolling terminal-green code panel, cable/wire details hanging from arms.

### 2a. Idle (0 jobs)

**File**: `worker-openai-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, matte black angular robot character,
rectangular head with 4x4 green LED matrix face showing two dot-eyes,
broad square shoulders with hex bolt details, chest panel dark with dim green standby bar,
cable wire hanging from left arm wrist, seated at desk in standby pose,
frame 1: arms crossed on desk, LED face showing simple two-dot eyes, chest panel dim,
upright rigid posture, fully powered down standby,
frame 2: one arm resting, head turns slightly, LED face shows a slow scan-line animation
moving top to bottom, chest panel blinks once,
transparent background, 16-bit RPG pixel art, no background, facing slightly right
```

### 2b. Working (1–2 jobs)

**File**: `worker-openai-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, matte black angular robot, LED face showing focused expression
(four dots, one row raised like a raised eyebrow),
chest panel displaying bright scrolling green terminal code lines, actively typing,
cable arms moving fluidly across keyboard,
frame 1: both hands on keyboard, LED face focused pattern, chest panel scrolling,
leaning slightly into the desk,
frame 2: right arm extends to point at monitor, LED face arrow pattern, head tilted,
frame 3: both hands back on keyboard, LED face determined (two dot eyes), chest code scrolling,
transparent background, 16-bit RPG pixel art style, no background
```

### 2c. Busy (3–4 jobs)

**File**: `worker-openai-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, matte black angular robot under stress,
LED face showing warning triangle or ! symbol, chest panel overloaded with rapid code scroll,
mechanical arms moving at high speed, small steam puff from shoulder joint,
frame 1: rapid typing both hands, LED face shows ! warning symbol, steam from shoulder,
chest panel RED-green mixed overload pattern,
frame 2: one hand raises coffee mug to non-existent mouth (robot sipping gesture), other hand still typing,
LED face shows loading bar,
frame 3: both hands slam on keyboard, LED face shows overload X pattern, cable arm shaking,
transparent background, 16-bit RPG pixel art style, no background
```

### 2d. Overloaded (5+ jobs)

**File**: `worker-openai-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, matte black angular robot critical failure mode,
LED face showing CRITICAL ERROR in blinking red pixels, chest panel on fire (pixel flame),
frame 1: both hands covering LED face, red ERROR text floating above head as pixel banner,
frame 2: standing from desk, fist raised at monitor, LED face angry X-X expression,
chest panel shooting sparks,
frame 3: LED face shows BSOD blue screen pattern, arms frozen mid-air, legs locked,
frame 4: slumping back into chair, LED face rebooting from black to green, fresh startup pattern,
transparent background, 16-bit RPG pixel art style, exaggerated, no background
```

---

## 3. OLLAMA — Arcane Automaton Robot

> **Appearance**: Boxy vintage copper-bronze robot, large round porthole-style head with single cracked monocle eye (left eye normal, right eye cracked with purple glow leak), chunky riveted rectangular body, purple arcane rune symbols etched on chest and shoulders glowing faintly, small steam vent on right shoulder, old worn aesthetic with dents and scratches.

### 3a. Idle (0 jobs)

**File**: `worker-ollama-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, boxy copper-bronze vintage robot character,
round porthole-style head, left eye dim orange circle, right eye cracked monocle with
faint purple glow leaking from the crack, riveted chest with worn purple rune etchings,
small steam vent on right shoulder, seated at desk in slow idle pose,
frame 1: hands resting on old laptop keyboard, upright but slow posture,
rune etchings glowing very dim, monocle crack purple glow minimal, eye looking forward,
frame 2: head droops forward as if entering sleep mode, hands still on keyboard,
small ZZZ pixel letters floating above head, steam vent releases tiny puff,
rune etchings completely dark,
transparent background, 16-bit RPG pixel art, warm dungeon lighting, no background, facing slightly right
```

### 3b. Working (1–2 jobs)

**File**: `worker-ollama-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, boxy copper-bronze vintage robot,
rune etchings glowing soft purple, monocle crack leaking more purple glow,
typing slowly but steadily on an old battered laptop, methodical deliberate pace,
frame 1: both chunky hands on old laptop, rune on chest glowing softly,
eye dim orange glow, sitting upright focused,
frame 2: one hand raised to chin in thinking pose, monocle eye zoomed in (lens enlarged),
purple rune on shoulder brightens,
frame 3: both hands back to typing, additional rune on forearm activates with glow,
steam vent releases small puff,
transparent background, 16-bit RPG pixel art style, no background
```

### 3c. Busy (3–4 jobs)

**File**: `worker-ollama-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, boxy copper-bronze vintage robot under load,
ALL rune etchings blazing bright purple, monocle crack fully glowing and leaking,
steam vent on shoulder venting constantly, fast typing despite heavy body,
frame 1: both hands rapid typing, runes blazing, steam venting, monocle flaring purple,
old laptop showing heat haze lines above it,
frame 2: one hand waves at sparking rune that's overactivating, other hand still typing,
rivets on body glowing orange from heat,
frame 3: hunched forward over laptop, body silhouette surrounded by purple energy haze,
monocle crack now a full lightning-bolt crack from eye socket,
transparent background, 16-bit RPG pixel art style, no background
```

### 3d. Overloaded (5+ jobs)

**File**: `worker-ollama-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, boxy copper-bronze vintage robot complete meltdown,
runes exploding with purple plasma, monocle eye completely shattered, steam venting everywhere,
frame 1: head on fire with purple arcane flame, both hands grabbing head in horror,
monocle completely shattered with purple sparks flying,
frame 2: old laptop exploding with purple smoke and sparks shooting into the air,
robot leans back from the blast,
frame 3: standing up with both chunky arms spread wide, runes on body all firing chaotically,
purple energy bolts shooting off in random directions,
frame 4: falling backward off chair, all runes dark, steam venting from every joint,
monocle dangling by a wire, old laptop fizzing on desk,
transparent background, 16-bit RPG pixel art style, dramatic exaggerated, no background
```

---

## 生成順序

| 優先 | 檔案 | 說明 |
|------|------|------|
| 🔴 1st | `worker-gemini-idle.png` | 確認 Gemini 機器人外觀後，再生其他狀態 |
| 🔴 1st | `worker-openai-idle.png` | 確認 OpenAI 機器人外觀 |
| 🔴 1st | `worker-ollama-idle.png` | 確認 Ollama 機器人外觀 |
| 🟡 2nd | 三者的 `-working.png` | 外觀確認後生動作狀態 |
| 🟡 2nd | 三者的 `-busy.png` | |
| 🟡 2nd | 三者的 `-overloaded.png` | |

---

## 替換說明

生成後放到相同路徑直接覆蓋：
```
public/game-assets/sprites/pixel-studio/worker-gemini-idle/
public/game-assets/sprites/pixel-studio/worker-openai-idle/
...
```
程式碼路徑不變，widget 自動載入新圖。

---

## Output Folder

```
public/game-assets/sprites/pixel-studio/
```

---

*v2.0 — Robot character redesign*
