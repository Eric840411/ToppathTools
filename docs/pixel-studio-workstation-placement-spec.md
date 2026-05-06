# Pixel Studio Workstation Placement Spec

本文件定義 Pixel Studio V3 工作站機器人的顯示位置、大小、狀態圖檔切換規則，以及「每幀角色高度不同導致忽大忽小」的修正方式。

## 核心結論

目前採用 V3 方案：每個 provider 的美術圖不是單獨機器人，而是完整工作站 overlay。

每張 `workstation-{provider}-{state}` 圖檔都已包含：

- 機器人
- 桌子
- 椅子
- 電腦 / 螢幕
- 鍵盤、杯子、植物、水晶、筆電等配件
- 螢幕動畫與狀態特效

因此 runtime 不應再疊舊版背景桌椅，也不應再使用舊版 `worker-{provider}-{state}` 機器人圖。底圖請使用 `studio-room-shell-bg`，它只保留房間、牆面、地板和環境裝飾。

目前實際輸出的 `workstation-*` sheet 採用 locked geometry 版本：同一個 state 內每一幀共用同一個工作站底幀，只有螢幕上極小的像素閃爍或過載點光會變化。這是為了避免生成式素材在不同幀產生不同桌子尺寸、椅子位置或角色比例。

## 問題根源

目前看到「角色忽大忽小」的根本原因不是位置，而是 scale 計算方式錯誤。

錯誤做法：

```ts
const scale = displayH / frameBBoxHeight
```

因為每一幀的透明 bbox 高度不一樣，例如某些幀只有機器人和桌子，某些幀多了螢幕爆光、煙霧或閃電，bbox 高度會變大。若每一幀都用 bbox 高度重新算 scale，同一個工作站就會在動畫中被放大、縮小。

正確做法：

```ts
const frameW = 160
const frameH = 128
const displayW = 180
const displayH = 144
```

runtime 必須固定使用整個 frame box 顯示，不要依照每幀 bbox 裁切或縮放。bbox 只能用於 QC 檢查，例如確認素材沒有貼邊、沒有被裁掉；不能用於 runtime scale。

若素材本身不同幀的桌椅或機器人構圖已經不同，單純修 CSS 也不會完全解決。這種情況必須修 sheet：每個 state 選定一個基準 frame 作為 locked geometry，其他 frame 只改螢幕像素或小型特效，不改桌子、椅子、機器人和螢幕外框。

## 共用座標系統

所有座標都以原始舞台 `800x600` 為基準。

底圖：

| 圖檔 | 路徑 | 尺寸 | 位置 |
|---|---|---:|---|
| `studio-room-shell-bg` | `/game-assets/sprites/pixel-studio/studio-room-shell-bg/sheet-transparent.png` | `800x600` | `left: 0; top: 0` |

工作站共用尺寸：

| 屬性 | 值 |
|---|---:|
| frame width | `160px` |
| frame height | `128px` |
| display width | `180px` |
| display height | `144px` |
| display scale | 固定 `1.125` |
| transform origin | `top left` |
| image rendering | `pixelated` |

說明：source sheet 仍然是 `160x128` per frame，但畫面上顯示為 `180x144`，讓工作站和機器人在目前 widget 縮放後不會太小。這是固定比例放大整個 frame box，不是依照每幀 bbox 放大。

## Provider 擺放規格

### Gemini

Gemini 是前景中央偏左的主工作站，使用藍色水晶球螢幕。

| 項目 | 規格 |
|---|---|
| 位置 | 前景中央偏左 |
| CSS left | `200px` |
| CSS top | `357px` |
| width | `180px` |
| height | `144px` |
| z-index | `20` |
| nameplate asset | `nameplate-gemini` |
| nameplate left | `214px` |
| nameplate top | `348px` |
| nameplate size | `88x18` |

Gemini 的桌子、椅子、機器人和水晶螢幕都在工作站 sprite 內。不要再額外放背景桌子，也不要再疊 `monitor-glow.png`。

### OpenAI

OpenAI 是左後方工作站，靠近拱門與左側書櫃，使用綠色 terminal 螢幕。

| 項目 | 規格 |
|---|---|
| 位置 | 左後方 |
| CSS left | `95px` |
| CSS top | `202px` |
| width | `180px` |
| height | `144px` |
| z-index | `18` |
| nameplate asset | `nameplate-openai` |
| nameplate left | `103px` |
| nameplate top | `193px` |
| nameplate size | `88x18` |

OpenAI 機器人面向右上方螢幕。不要和 Ollama 的右中位置對調。

### Ollama

Ollama 是右中方工作站，位於任務板左下方，使用紫色螢幕和紫色水晶。

| 項目 | 規格 |
|---|---|
| 位置 | 右中方 |
| CSS left | `395px` |
| CSS top | `262px` |
| width | `180px` |
| height | `144px` |
| z-index | `19` |
| nameplate asset | `nameplate-ollama` |
| nameplate left | `414px` |
| nameplate top | `253px` |
| nameplate size | `88x18` |

Ollama 機器人面向左上方螢幕。不要放到左後 OpenAI 座位。

## Nameplate 擺放規格

Nameplate 是獨立 overlay，不要烘進 workstation sprite。原因是 provider 名稱需要永遠清楚可讀，而且工作站不同狀態切換時，nameplate 不應跟著動畫跳動。

三張 nameplate 原始圖都是 `80x16`，runtime 建議顯示為 `88x18`，約等於 `1.1x` 放大。這個放大幅度比工作站的 `1.125x` 略小，能保持字牌清楚，又不會壓住桌面或機器人。

| Provider | asset | path | display size | left | top | z-index | 說明 |
|---|---|---|---:|---:|---:|---:|---|
| Gemini | `nameplate-gemini` | `/game-assets/sprites/pixel-studio/nameplate-gemini/sheet-transparent.png` | `88x18` | `214px` | `348px` | `21` | 放在前景工作站上緣偏左，避開水晶球與機器人頭部。 |
| OpenAI | `nameplate-openai` | `/game-assets/sprites/pixel-studio/nameplate-openai/sheet-transparent.png` | `88x18` | `103px` | `193px` | `19` | 放在左後工作站上緣，接近螢幕但不遮住 monitor。 |
| Ollama | `nameplate-ollama` | `/game-assets/sprites/pixel-studio/nameplate-ollama/sheet-transparent.png` | `88x18` | `414px` | `253px` | `20` | 放在右中工作站上緣，保持在任務板下方，不要貼到牆面。 |

Nameplate 的定位規則：

- 使用 `position: absolute`
- `width` 固定 `88px`
- `height` 固定 `18px`
- `background-size: 100% 100%`
- `image-rendering: pixelated`
- z-index 使用工作站 z-index + 1
- job count 文字若要顯示，放在 nameplate 上方 `14px`，z-index 再 +1

## 狀態與美術圖切換

狀態由 provider 的 running job count 決定。

| Job count | state | 說明 |
|---:|---|---|
| `0` | `idle` | 待機，螢幕低亮度呼吸 |
| `1-2` | `working` | 正常工作，鍵盤與螢幕掃描動畫 |
| `3-4` | `busy` | 忙碌，螢幕更亮，桌面特效增加 |
| `>= 5` | `overloaded` | 過載，煙霧、閃電、爆光已在工作站圖內 |

程式規則：

```ts
function getWorkerState(count: number) {
  if (count >= 5) return 'overloaded'
  if (count >= 3) return 'busy'
  if (count >= 1) return 'working'
  return 'idle'
}
```

## 圖檔清單

所有圖檔都使用：

```txt
/game-assets/sprites/pixel-studio/{asset-name}/sheet-transparent.png
```

### Gemini

| state | asset name | frame size | frames | sheet size | 建議 duration |
|---|---|---:|---:|---:|---:|
| idle | `workstation-gemini-idle` | `160x128` | 2 | `320x128` | `1600ms` |
| working | `workstation-gemini-working` | `160x128` | 3 | `480x128` | `600ms` |
| busy | `workstation-gemini-busy` | `160x128` | 3 | `480x128` | `360ms` |
| overloaded | `workstation-gemini-overloaded` | `160x128` | 4 | `640x128` | `400ms` |

### OpenAI

| state | asset name | frame size | frames | sheet size | 建議 duration |
|---|---|---:|---:|---:|---:|
| idle | `workstation-openai-idle` | `160x128` | 2 | `320x128` | `1600ms` |
| working | `workstation-openai-working` | `160x128` | 3 | `480x128` | `600ms` |
| busy | `workstation-openai-busy` | `160x128` | 3 | `480x128` | `360ms` |
| overloaded | `workstation-openai-overloaded` | `160x128` | 4 | `640x128` | `400ms` |

### Ollama

| state | asset name | frame size | frames | sheet size | 建議 duration |
|---|---|---:|---:|---:|---:|
| idle | `workstation-ollama-idle` | `160x128` | 2 | `320x128` | `1600ms` |
| working | `workstation-ollama-working` | `160x128` | 3 | `480x128` | `600ms` |
| busy | `workstation-ollama-busy` | `160x128` | 3 | `480x128` | `360ms` |
| overloaded | `workstation-ollama-overloaded` | `160x128` | 4 | `640x128` | `400ms` |

## Runtime 播放方式

請用固定 frame box 播放 sprite sheet。

```tsx
const FRAME_W = 160
const FRAME_H = 128
const DISPLAY_W = 180
const DISPLAY_H = 144

function WorkstationSprite({
  provider,
  state,
  frames,
  frame,
}: {
  provider: 'gemini' | 'openai' | 'ollama'
  state: 'idle' | 'working' | 'busy' | 'overloaded'
  frames: number
  frame: number
}) {
  return (
    <div
      style={{
        width: DISPLAY_W,
        height: DISPLAY_H,
        overflow: 'hidden',
        backgroundImage: `url(/game-assets/sprites/pixel-studio/workstation-${provider}-${state}/sheet-transparent.png)`,
        backgroundSize: `${DISPLAY_W * frames}px ${DISPLAY_H}px`,
        backgroundPosition: `${-DISPLAY_W * frame}px 0px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  )
}
```

重點：

- source frame 永遠是 `160x128`
- display size 永遠是 `180x144`
- `backgroundSize` 只依照幀數改寬度
- `backgroundPositionX` 每幀移動 `-180px`
- 不要讀 bbox 高度來重算 scale
- 不要用每幀 PNG 重新置中
- 不要套 `object-fit: contain`
- 不要讓 CSS 根據透明內容自動決定尺寸
- 同一個 state 的所有 frame 必須保持相同桌椅與機器人 silhouette
- 若看到忽大忽小，優先檢查 sheet 本身，不要只調 `left/top`

## 建議配置物件

```ts
const WORKSTATION_FRAME = {
  sourceWidth: 160,
  sourceHeight: 128,
  displayWidth: 180,
  displayHeight: 144,
}

const WORKSTATION_SPECS = {
  idle: { frames: 2, durationMs: 1600 },
  working: { frames: 3, durationMs: 600 },
  busy: { frames: 3, durationMs: 360 },
  overloaded: { frames: 4, durationMs: 400 },
} as const

const WORKSTATION_POSITIONS = {
  gemini: {
    left: 200,
    top: 357,
    zIndex: 20,
    nameplate: { asset: 'nameplate-gemini', left: 214, top: 348, width: 88, height: 18 },
  },
  openai: {
    left: 95,
    top: 202,
    zIndex: 18,
    nameplate: { asset: 'nameplate-openai', left: 103, top: 193, width: 88, height: 18 },
  },
  ollama: {
    left: 395,
    top: 262,
    zIndex: 19,
    nameplate: { asset: 'nameplate-ollama', left: 414, top: 253, width: 88, height: 18 },
  },
} as const
```

## 需要避免的舊邏輯

以下舊邏輯不適合 V3 工作站：

```ts
const scale = displayH / fd.h
const bgW = PNG_W * scale
const bgH = PNG_H * scale
const bgPosY = -(fd.paste_y * scale)
```

原因：

- `fd.h` 是每幀透明 bbox 高度，不是角色設計尺寸。
- busy / overloaded 幀會包含閃電、煙霧、螢幕爆光，bbox 變大。
- idle 幀通常 bbox 較小。
- 用 bbox 高度縮放會讓 idle 變大、overloaded 變小，或者反過來造成跳動。

如果真的需要微調位置，請只調整整個工作站容器的 `left/top`，不要調整每幀內容的 scale。

## QC 規則

每組圖檔生成後可用 `pipeline-meta.json` 檢查，但只作為美術 QC。

可以檢查：

- `cell_width` 必須是 `160`
- `cell_height` 必須是 `128`
- `cols` 必須符合狀態幀數
- `touches_edge` 建議為 `false`
- bbox 不應貼到 frame 邊緣
- `pipeline-meta.json` 的 `locked_geometry` 應為 `true`
- contact sheet 中同一列的桌腳、椅背、機器人頭部、螢幕外框不應跳位

不可以用：

- bbox 高度決定 display size
- bbox 寬度決定 display size
- bbox top 決定每幀 top offset

## 目前預覽檔

合成預覽：

```txt
C:\Users\user\Documents\New project\generated\pixel-studio-workstations\workstations-locked-room-preview.png
```

放大到 `180x144` 並疊上 nameplate 的預覽：

```txt
C:\Users\user\Documents\New project\generated\pixel-studio-workstations\workstations-180-nameplate-preview.png
```

總覽 contact sheet：

```txt
C:\Users\user\Documents\New project\generated\pixel-studio-workstations\workstations-locked-contact-sheet.png
```

這兩張只用於檢查，不進 runtime。正式畫面要由 `studio-room-shell-bg` 加三個 `workstation-*` sprite 即時組合。
