# Pixel Studio — AI Image Generation Prompts

> Generate all assets in order. Start with the room background to establish the art style, then match all characters and props to it.

---

## Global Style Rules (apply to ALL prompts)

- **Style**: 16-bit pixel art, isometric 2.5D perspective
- **Mood**: Dark dungeon with warm torch glow + cool monitor glow
- **Palette**: Dark stone/wood tones, amber torch light, neon cyan/green/purple accents
- **Background**: Transparent PNG for all characters and props
- **No anti-aliasing**, hard pixel edges only

---

## 1. Room Background

**File**: `studio-room-bg.png` | **Size**: 800×600px | **Frames**: 1 (static)

```
isometric pixel art dungeon coding studio room, 800x600 pixels,
stone brick walls, dark atmospheric interior, wooden floor with 
stone tiles, three distinct wooden desks arranged in the room with 
glowing computer monitors, empty wooden chairs at each desk, 
wall-mounted torches with warm orange flame glow on left and right walls, 
wooden barrels stacked in corners, small potted green plants on desks, 
glowing potion bottles on wall shelves, neon green sign on back wall 
reading "PIXEL STUDIO", cork quest board with paper notes pinned 
to right wall, treasure chest near left wall, skull decoration on shelf, 
warm amber torch lighting, cool blue-green monitor screen glow, 
mystical purple rune glow from shelves, 16-bit RPG pixel art style, 
isometric top-down 2.5D view, high detail, dark dungeon atmosphere,
NO CHARACTERS, NO PEOPLE, EMPTY CHAIRS ONLY, transparent background
```

---

## 2. Gemini Worker — Blue-Purple Wizard

> **Appearance**: Tall wizard hat, blue-purple robes, glowing crystal ball on desk, round glasses, calm scholarly expression.

### 2a. Idle (0 jobs)

**File**: `worker-gemini-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, wizard character with tall pointed hat,
blue and purple robes, sitting at wooden desk, leaning back in chair relaxed,
glowing crystal ball on desk with dim light, round glasses,
frame 1: eyes open, hands resting on desk, calm expression,
frame 2: eyes half-closed sleepy, head slightly drooping forward,
transparent background, 16-bit RPG style, warm dungeon side lighting,
character faces slightly right, sitting pose, no background
```

### 2b. Working (1–2 jobs)

**File**: `worker-gemini-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, wizard character with tall pointed hat,
blue and purple robes, sitting at desk typing on keyboard,
crystal ball glowing brightly on desk, focused determined expression,
frame 1: both hands on keyboard, leaning slightly forward, body upright,
frame 2: right hand pointing at monitor screen, left hand on desk,
frame 3: both hands on keyboard, slightly different arm position,
transparent background, 16-bit RPG pixel art style, no background
```

### 2c. Busy (3–4 jobs)

**File**: `worker-gemini-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, wizard character with tall pointed hat,
blue and purple robes, stressed fast typing at keyboard,
small blue sweat drop on side of head, stack of papers on desk corner,
crystal ball flickering rapidly, furrowed brow anxious expression,
frame 1: fast typing both hands, sweat drop visible left side of head,
frame 2: same fast typing, slightly different hand position,
frame 3: quick glance up at screen, eyes wide, worried expression,
transparent background, 16-bit RPG pixel art style, no background
```

### 2d. Overloaded (5+ jobs)

**File**: `worker-gemini-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, wizard character with tall pointed hat,
blue and purple robes, complete chaos and panic,
frame 1: both hands on head, small steam/smoke puff rising from hat,
frame 2: papers flying off desk into the air, arms flailing,
frame 3: leaning back dramatically, eyes as X marks, tongue out, defeated,
frame 4: snapping upright again grabbing keyboard in panic, spiral eyes,
transparent background, 16-bit RPG pixel art style, exaggerated cartoon emotion, no background
```

---

## 3. OpenAI Worker — Cyberpunk Engineer

> **Appearance**: Black hoodie, mechanical left eye with green LED, headphones around neck, sharp focused look, terminal-green aesthetic.

### 3a. Idle (0 jobs)

**File**: `worker-openai-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, cyberpunk programmer character,
black hoodie, glowing green mechanical left eye, headphones,
sitting in chair with arms crossed, cool relaxed pose,
frame 1: mechanical eye dim, regular right eye closed, charging/standby mode,
frame 2: mechanical eye slowly scanning left to right with green LED glow,
both eyes looking forward, stoic expression,
transparent background, 16-bit cyberpunk pixel art style, no background
```

### 3b. Working (1–2 jobs)

**File**: `worker-openai-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, cyberpunk programmer, black hoodie,
glowing green mechanical eye, headphones lit up green,
typing at keyboard with green terminal code reflecting on face,
frame 1: both hands typing fast, green code glow on face, intense focus,
frame 2: right hand pointing at screen, left hand on desk, head tilted slightly,
frame 3: back to typing, mechanical eye zoomed in/enlarged slightly (focused),
transparent background, 16-bit pixel art style, no background
```

### 3c. Busy (3–4 jobs)

**File**: `worker-openai-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, cyberpunk programmer, black hoodie,
mechanical eye showing orange warning glow, stressed but controlled,
frame 1: both hands typing, small CPU temperature warning icon near head,
frame 2: right hand holds coffee cup raised to mouth, left hand still typing,
frame 3: both hands back to keyboard, jaw clenched, veins on forehead,
transparent background, 16-bit pixel art style, no background
```

### 3d. Overloaded (5+ jobs)

**File**: `worker-openai-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, cyberpunk programmer, black hoodie,
mechanical eye glowing bright red ERROR, critical system failure,
frame 1: both hands covering face, red ERROR text floating above head,
frame 2: standing up from chair, pointing aggressively at monitor,
frame 3: mechanical eye shoots red error beam, sparks from head,
frame 4: sitting back down slamming keyboard, rebooting expression blank eyes then snapping back,
transparent background, 16-bit pixel art style, exaggerated, no background
```

---

## 4. Ollama Worker — Mysterious Hermit

> **Appearance**: Purple-gray hooded cloak, ancient runes floating around, old worn laptop, mystical slow energy, beard, wise old eyes.

### 4a. Idle (0 jobs)

**File**: `worker-ollama-idle.png` | **Size**: 128×96px | **Frames**: 2 horizontal

```
pixel art sprite sheet, 2 frames side by side, each frame 64x96 pixels,
total size 128x96 pixels, mysterious hermit wizard character,
purple-gray hooded cloak, long beard, old worn laptop on desk,
faint purple rune glow around character,
frame 1: sitting cross-legged or normally, reading an ancient scroll or thick book,
calm peaceful expression, runes dim,
frame 2: head nodding downward falling asleep, book still in hands,
small ZZZ floating above head,
transparent background, 16-bit RPG pixel art style, no background
```

### 4b. Working (1–2 jobs)

**File**: `worker-ollama-working.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, mysterious hermit wizard, purple-gray cloak,
long beard, typing slowly but deliberately on old battered laptop,
magical purple runes floating in air around hands while typing,
frame 1: both hands on laptop keyboard, one purple rune floating to left,
eyes focused, slow methodical pace,
frame 2: pausing to think, one finger tapping chin, runes orbiting slowly,
frame 3: resuming typing, two more runes appearing, soft purple glow,
transparent background, 16-bit RPG pixel art style, no background
```

### 4c. Busy (3–4 jobs)

**File**: `worker-ollama-busy.png` | **Size**: 192×96px | **Frames**: 3 horizontal

```
pixel art sprite sheet, 3 frames side by side, each frame 64x96 pixels,
total size 192x96 pixels, mysterious hermit wizard, purple-gray cloak,
runes flashing rapidly and multiplying out of control,
cloak edges starting to flutter from magical energy,
frame 1: fast typing on old laptop, many runes swirling chaotically around,
brow furrowed, laptop showing heat waves,
frame 2: waving one hand to dismiss overflow of runes, still typing with other,
frame 3: hunched over laptop, cloak billowing, purple energy crackling,
transparent background, 16-bit pixel art style, no background
```

### 4d. Overloaded (5+ jobs)

**File**: `worker-ollama-overloaded.png` | **Size**: 256×96px | **Frames**: 4 horizontal

```
pixel art sprite sheet, 4 frames side by side, each frame 64x96 pixels,
total size 256x96 pixels, mysterious hermit wizard, purple-gray cloak,
complete magical catastrophe, laptop overheating explosion,
frame 1: head on fire with purple flames, cloak sparking, eyes wide in horror,
frame 2: old laptop shooting purple smoke and sparks into air,
frame 3: standing up with both arms out, runes flying everywhere chaotically,
frame 4: falling backward out of chair, cloak fully ablaze, runes scattered on ground,
transparent background, 16-bit pixel art style, dramatic exaggerated, no background
```

---

## 5. Props & Effects

### 5a. Torch Animation

**File**: `torch-anim.png` | **Size**: 64×24px | **Frames**: 4 horizontal (16×24px each)

```
pixel art sprite sheet, 4 frames side by side, each frame 16x24 pixels,
total size 64x24 pixels, wall-mounted torch with animated flame,
iron bracket attached to stone wall, wooden torch handle,
flickering orange-yellow-white flame animation loop,
frame 1: tall flame, bright,
frame 2: flame leaning right, medium height,
frame 3: shorter flame, dimmer,
frame 4: flame leaning left, medium,
warm amber light glow around flame, transparent background, 16-bit pixel art
```

### 5b. Neon Sign

**File**: `neon-sign-anim.png` | **Size**: 256×64px | **Frames**: 2 horizontal (128×64px each)

```
pixel art sprite sheet, 2 frames side by side, each frame 128x64 pixels,
total size 256x64 pixels, retro neon sign reading "PIXEL STUDIO",
green glowing neon tube letters, mounted on dark wooden board,
frame 1: fully lit, bright green neon glow, strong halo effect,
frame 2: slightly dimmer, flicker state, reduced glow,
cyberpunk dungeon aesthetic, transparent background, 16-bit pixel art style
```

### 5c. Smoke Puff Effect

**File**: `smoke-anim.png` | **Size**: 128×32px | **Frames**: 4 horizontal (32×32px each)

```
pixel art sprite sheet, 4 frames side by side, each frame 32x32 pixels,
total size 128x32 pixels, small rising smoke puff animation loop,
gray-white cartoon smoke cloud, pixel art style,
frame 1: small puff at bottom, just starting,
frame 2: medium puff rising,
frame 3: large spread puff near top,
frame 4: dissipating fading out,
transparent background, 16-bit pixel art, loops seamlessly
```

### 5d. Warning Alarm Light

**File**: `alarm-light-anim.png` | **Size**: 32×16px | **Frames**: 2 horizontal (16×16px each)

```
pixel art sprite sheet, 2 frames side by side, each frame 16x16 pixels,
total size 32x16 pixels, small dome-shaped warning alarm light,
wall or ceiling mounted, bright red,
frame 1: fully lit bright red with glow halo,
frame 2: completely dark off state,
transparent background, 16-bit pixel art style, emergency alert aesthetic
```

### 5e. Sweat Drop

**File**: `sweat-anim.png` | **Size**: 24×12px | **Frames**: 3 horizontal (8×12px each)

```
pixel art sprite sheet, 3 frames side by side, each frame 8x12 pixels,
total size 24x12 pixels, anime-style sweat drop bead animation,
light blue teardrop shape, cartoon pixel art,
frame 1: small drop appearing at top,
frame 2: full large drop,
frame 3: drop falling downward and fading,
transparent background, 16-bit pixel art style
```

---

## Generation Order

| # | File | Priority | Notes |
|---|------|----------|-------|
| 1 | `studio-room-bg.png` | 🔴 Critical first | Sets the entire art style |
| 2 | `worker-gemini-idle.png` | 🔴 High | Confirm character design before other states |
| 3 | `worker-openai-idle.png` | 🔴 High | Confirm character design |
| 4 | `worker-ollama-idle.png` | 🔴 High | Confirm character design |
| 5 | All `-working.png` | 🟡 Medium | After idle approved |
| 6 | All `-busy.png` | 🟡 Medium | |
| 7 | All `-overloaded.png` | 🟡 Medium | |
| 8 | `torch-anim.png` | 🟢 Low | Atmosphere |
| 9 | `neon-sign-anim.png` | 🟢 Low | Atmosphere |
| 10 | Effect sprites | 🟢 Low | Smoke, alarm, sweat |

---

## Output Folder

Place all generated files in:
```
public/game-assets/pixel-studio/
```

---

*v1.0 — Ready for AI image generation*
