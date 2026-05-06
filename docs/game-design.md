# Toppath Heroes — RPG 遊戲設計文件 v1.0

> **設計原則**：工具操作 = 戰鬥動作。每個使用者是 QA 勇者，工具功能是技能，Bug/異常是敵人，每日任務是副本。

---

## 目錄

1. [現有系統盤點](#1-現有系統盤點)
2. [職業分支](#2-職業分支)
3. [技能系統](#3-技能系統)
4. [成長曲線與屬性](#4-成長曲線與屬性)
5. [世界地圖與副本](#5-世界地圖與副本)
6. [缺少的美術素材清單](#6-缺少的美術素材清單)
7. [動態效果清單](#7-動態效果清單)
8. [建議實作優先序](#8-建議實作優先序)

---

## 1. 現有系統盤點

### ✅ 已有

| 系統 | 狀態 | 說明 |
|------|------|------|
| XP / 等級系統 | ✅ 完整 | Lv1–10，10 種操作各有 XP 獎勵 |
| 每日任務 | ✅ 完整 | 每日 3 個隨機任務，完成領 XP |
| 成就系統 | ✅ 基本 | 9 個成就，icon + bonus XP |
| 通知動畫 | ✅ 完整 | XP / 升級 / 成就 / 任務完成 |
| 頭像選擇 | ✅ 完整 | 20 個預設頭像（含 10 種職業造型） |
| Pixel 按鈕/卡片 | ✅ 豐富 | cyan / gold / green / red 四色系 |
| Dungeon UI 圖標 | ✅ 18 種 | account, settings, ai, gem 等 |

### ❌ 缺少（需要設計）

| 系統 | 優先度 |
|------|--------|
| 職業分支選擇 | 🔴 高 |
| 技能樹 / 主動技能 | 🔴 高 |
| 角色屬性面板 (ATK/DEF/INT) | 🔴 高 |
| 世界地圖（副本入口） | 🟡 中 |
| 裝備/強化系統 | 🟢 低（Phase 2） |
| 排行榜 | 🟢 低（Phase 2） |

---

## 2. 職業分支

> 選擇職業後不可更換（或解鎖第二職業需 Lv.7+）。對應頭像造型已存在。

### 五大職業

#### ⚔️ Commander（指揮官）
- **定位**：全能型，擅長 Jira 批量作業與多機台協調
- **對應頭像**：`avatar-01/02-male/female-commander`
- **屬性重點**：ATK ★★★★ DEF ★★★ INT ★★★
- **職業加成**：Jira 相關操作 XP ×1.5、Machine Test 同時啟動機台數 +1

| 技能 | 類型 | 說明 | 觸發條件 |
|------|------|------|---------|
| 批量攻勢 | 主動 | 批量開 Jira，本次 XP ×2 | 每日 2 次 |
| 號令群雄 | 主動 | Machine Test 一次測 4 台不觸發疲勞懲罰 | CD 24h |
| 鐵血意志 | 被動 | 連續 3 天登入，XP 加成 +10% | 自動 |

---

#### 🔓 Hacker（駭客）
- **定位**：高智力，擅長 AI 生成 TestCase、Config 比對、Log 分析
- **對應頭像**：`avatar-03/04-male/female-hacker`
- **屬性重點**：ATK ★★ DEF ★★ INT ★★★★★
- **職業加成**：TestCase 生成 XP ×1.8、Gemini API 失敗不扣加成計數

| 技能 | 類型 | 說明 | 觸發條件 |
|------|------|------|---------|
| 代碼破譯 | 主動 | 生成 TestCase 時解鎖隱藏成就追蹤 | 每日 1 次 |
| AI 注入 | 主動 | 本次 AI 呼叫使用雙 Gemini Key 並行 | CD 12h |
| 零日感知 | 被動 | Config 比對發現差異時，自動推送 Lark 提示 | 自動 |

---

#### 🛡 Guardian（守護者）
- **定位**：高防禦，擅長長時間監控（AutoSpin、Jackpot 監控）
- **對應頭像**：`avatar-09/10-male/female-mechanic`（改名 Guardian）
- **屬性重點**：ATK ★★ DEF ★★★★★ INT ★★★
- **職業加成**：AutoSpin 運行期間每小時自動 +20 XP、Jackpot 告警獎勵 ×2

| 技能 | 類型 | 說明 | 觸發條件 |
|------|------|------|---------|
| 持久監控 | 主動 | AutoSpin 本次 session 不計超時懲罰 | 每日 1 次 |
| 金庫感應 | 主動 | Jackpot 閾值偵測靈敏度 +20%（警告更早觸發） | CD 6h |
| 鐵壁 | 被動 | 連續監控 2h 以上，自動獲得「守門人」稱號 | 自動 |

---

#### 🏹 Ranger（遊俠）
- **定位**：高速，擅長 Machine Test 快速掃盪和圖片驗證
- **對應頭像**：`avatar-13/14-male/female-scout`
- **屬性重點**：ATK ★★★★ DEF ★★★ INT ★★★
- **職業加成**：Machine Test 每台測試時間 -10%、Image Check 批量模式可多送 2 台

| 技能 | 類型 | 說明 | 觸發條件 |
|------|------|------|---------|
| 連環測試 | 主動 | 本次 Machine Test 全 PASS 時，XP ×3 | 每日 1 次 |
| 圖片獵影 | 主動 | Image Check 發現殘留圖片，XP ×2 | CD 8h |
| 疾風步 | 被動 | 一日內完成 5 次不同工具操作，解鎖「百工遊俠」成就 | 自動 |

---

#### 🔮 Sage（賢者）
- **定位**：分析型，擅長 GS 統計、Log 解讀、數據洞察
- **對應頭像**：`avatar-11/12-male/female-analyst`（改名 Sage）
- **屬性重點**：ATK ★★ DEF ★★★ INT ★★★★★
- **職業加成**：GS Stats 結果自動存入歷史並標記異常、Log Checker 關鍵字高亮 +5 組

| 技能 | 類型 | 說明 | 觸發條件 |
|------|------|------|---------|
| 機率洞察 | 主動 | GS Stats 執行時，自動計算信心區間 | 每日 1 次 |
| 古老智慧 | 主動 | 開啟 Wiki/Docs 並停留 60s，XP +50 | CD 24h |
| 全知之眼 | 被動 | 操作歷史紀錄達 100 筆，解鎖「編年史家」稱號 | 自動 |

---

## 3. 技能系統

### 技能欄設計

```
┌─────────────────────────────────┐
│  主動技能 (Active)               │
│  [技能1] [技能2] [技能3]          │
│   冷卻中   可使用   可使用         │
├─────────────────────────────────┤
│  被動技能 (Passive) — 自動生效    │
│  [被動1] [被動2]                  │
└─────────────────────────────────┘
```

### 技能成長（等級解鎖）

| 等級 | 解鎖內容 |
|------|---------|
| Lv.1 | 職業選擇 + 職業基礎被動 |
| Lv.2 | 主動技能 1 解鎖 |
| Lv.4 | 主動技能 2 解鎖 |
| Lv.5 | 被動技能 2 解鎖（職業強化） |
| Lv.6 | 主動技能 3 解鎖 |
| Lv.8 | 技能升級（所有技能效果 +50%） |
| Lv.10 | 傳說技能解鎖（全職業共通 1 個） |

### 傳說技能（Lv.10 全職業共通）

| 技能 | 說明 |
|------|------|
| 🌟 全域覺醒 | 當日所有 XP 獎勵 ×2，持續 4 小時 |

---

## 4. 成長曲線與屬性

### 等級階段

| 等級 | 稱號 | 累積 XP | 解鎖 |
|------|------|---------|------|
| Lv.1 | 菜鳥見習生 | 0 | 職業選擇 |
| Lv.2 | 初級測試員 | 200 | 技能槽 1 |
| Lv.3 | 工具熟練者 | 500 | 稱號系統 |
| Lv.4 | 進階工程師 | 1000 | 技能槽 2 |
| Lv.5 | 資深 QA | 1800 | 被動強化 + 成就「VETERAN」|
| Lv.6 | 機台測試師 | 3000 | 技能槽 3 |
| Lv.7 | 系統守護者 | 4500 | 第二職業選擇 |
| Lv.8 | 精英偵察員 | 6500 | 技能強化 |
| Lv.9 | 傳說前夕 | 9000 | 隱藏副本解鎖 |
| Lv.10 | 傳說工程師 | 12000 | 傳說技能 + 成就「LEGEND」|

### 角色屬性面板（新增）

每升一級獲得 3 點屬性點可自由分配：

| 屬性 | 說明 | 職業加成 |
|------|------|---------|
| ⚔️ ATK (攻擊力) | 提升主動技能效果（XP 倍率） | Commander +3, Ranger +3 |
| 🛡 DEF (防禦力) | 提升容錯次數（技能 CD 減少） | Guardian +3 |
| 🧠 INT (智力) | 提升 AI 相關功能精準度 | Hacker +3, Sage +3 |
| ⚡ SPD (速度) | 減少測試冷卻、任務刷新更快 | Ranger +2 |

---

## 5. 世界地圖與副本

> 每個工具頁面對應一個「地圖區域」，進入即為進入副本。

```
╔══════════════════════════════════════════════╗
║           TOPPATH WORLD MAP                  ║
║                                              ║
║  [Jira 城堡]    [Lark 神殿]    [OSM 荒原]    ║
║  Commander推薦   Hacker推薦    Ranger推薦     ║
║                                              ║
║  [機台試煉場]   [GameShow 競技場] [AutoSpin 塔]║
║  Ranger/Guard   Sage推薦        Guardian推薦  ║
║                                              ║
║  [圖書館(歷史)] [煉金術師(AI設定)] [傳說副本]  ║
║  全職業          Hacker推薦       Lv.9+解鎖   ║
╚══════════════════════════════════════════════╝
```

### 副本敵人（Bug 擬人化）

| 區域 | Boss | 打敗條件 |
|------|------|---------|
| Jira 城堡 | 未開單魔王 | 今日開 5 張 Jira |
| 機台試煉場 | 離線機台幽靈 | Machine Test 全 PASS |
| OSM 荒原 | 版號不符惡魔 | 所有渠道版號同步完成 |
| GameShow 競技場 | 機率異常怪 | GS Stats 跑完 500x |
| 傳說副本 | 混沌系統核心 | 完成 5 個每日任務（同一天）|

---

## 6. 缺少的美術素材清單

> ⬇️ 請 AI 生成以下素材（像素風格 16px/32px grid，背景透明 PNG）

### 6.1 職業全身立繪（角色卡面板用）

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `class-commander.png` | 64×96px | 指揮官像素全身，金甲，持令旗 |
| `class-hacker.png` | 64×96px | 駭客像素全身，暗系，持鍵盤 |
| `class-guardian.png` | 64×96px | 守護者像素全身，重甲，持盾牌 |
| `class-ranger.png` | 64×96px | 遊俠像素全身，輕甲，持弓箭 |
| `class-sage.png` | 64×96px | 賢者像素全身，法袍，持水晶球 |

### 6.2 主動技能圖示

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `skill-batch-attack.png` | 32×32px | 批量攻勢：多把劍齊飛 |
| `skill-summon.png` | 32×32px | 號令群雄：召喚光環 |
| `skill-decode.png` | 32×32px | 代碼破譯：矩陣文字流 |
| `skill-ai-inject.png` | 32×32px | AI 注入：閃電 + 電路板 |
| `skill-monitor.png` | 32×32px | 持久監控：眼睛 + 盾牌 |
| `skill-chain-test.png` | 32×32px | 連環測試：鏈條 + 機台 |
| `skill-insight.png` | 32×32px | 機率洞察：放大鏡 + 圖表 |
| `skill-legend.png` | 32×32px | 全域覺醒：星爆光圈（金色）|

### 6.3 屬性圖示

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `stat-atk.png` | 16×16px | 攻擊：紅色劍 |
| `stat-def.png` | 16×16px | 防禦：藍色盾 |
| `stat-int.png` | 16×16px | 智力：紫色星 |
| `stat-spd.png` | 16×16px | 速度：黃色閃電 |

### 6.4 UI 框架

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `frame-character-panel.png` | 320×480px | 角色屬性面板（九宮格拉伸）|
| `frame-skill-tree.png` | 480×320px | 技能樹背景框 |
| `frame-class-select.png` | 640×400px | 職業選擇畫面外框 |
| `frame-world-map.png` | 640×360px | 世界地圖底圖 |
| `bar-xp-fill.png` | 200×12px | XP 進度條填充（漸層青→金） |
| `bar-xp-empty.png` | 200×12px | XP 進度條空白 |

### 6.5 地圖區域圖標

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `map-jira-castle.png` | 64×64px | Jira 城堡（中世紀城堡像素） |
| `map-lark-temple.png` | 64×64px | Lark 神殿（東方神殿風） |
| `map-osm-wasteland.png` | 64×64px | OSM 荒原（龜裂沙漠地磚） |
| `map-machinetest-arena.png` | 64×64px | 機台試煉場（競技場） |
| `map-gameshow-colosseum.png` | 64×64px | GameShow 競技場（圓形競技場）|
| `map-autospin-tower.png` | 64×64px | AutoSpin 塔（無限高塔）|
| `map-legend-dungeon.png` | 64×64px | 傳說副本（發光古蹟，鎖住狀態）|

### 6.6 副本 Boss 像素圖

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `boss-unjira.png` | 48×64px | 未開單魔王：紅眼惡魔 + 手持空白卡 |
| `boss-offline.png` | 48×64px | 離線機台幽靈：透明幽靈 + 斷線標誌 |
| `boss-version.png` | 48×64px | 版號不符惡魔：數字混亂扭曲怪 |
| `boss-probability.png` | 48×64px | 機率異常怪：骰子眼睛的章魚怪 |
| `boss-chaos.png` | 64×80px | 混沌系統核心：旋轉齒輪 + 紅眼最終Boss |

### 6.7 效果圖（動畫幀）

| 素材名 | 尺寸 | 說明 |
|--------|------|------|
| `fx-levelup-frame1~4.png` | 80×80px | 升級光圈（4 幀） |
| `fx-skill-cast-frame1~3.png` | 48×48px | 技能施放閃光（3 幀） |
| `fx-quest-complete.png` | 64×32px | 任務完成金色橫幅 |
| `fx-xp-burst-frame1~3.png` | 32×32px | XP 爆發粒子（3 幀） |
| `fx-boss-hit-frame1~2.png` | 32×32px | Boss 被擊中（紅閃，2 幀）|

---

## 7. 動態效果清單

> 以 CSS animation 或 Framer Motion 實現，不需另外素材

| 效果 | 觸發時機 | 實現方式 |
|------|---------|---------|
| XP 進度條流光 | 獲得 XP 時 | CSS shimmer animation |
| 升級時全屏金光 | Levelup | CSS radial-gradient pulse |
| 技能冷卻轉圈 | 技能使用後 | CSS conic-gradient countdown |
| 屬性點增加跳字 | 分配屬性點 | CSS translateY + fade |
| Boss 血條減少 | 完成任務 | CSS width transition + shake |
| 職業選擇翻牌 | 選職業時 | CSS rotateY 3D flip |
| 地圖區域 hover 光暈 | 滑鼠懸停 | CSS box-shadow pulse |
| 成就解鎖爆炸粒子 | 成就達成 | JS canvas particle burst |

---

## 8. 建議實作優先序

### Phase 1 — 核心 RPG 架構（4 週）

```
Week 1: 職業選擇系統
  ✦ ClassSelectModal（5 職業卡片展示）
  ✦ 儲存 class 到 localStorage
  ✦ 職業加成套用到 XP 計算

Week 2: 角色屬性面板
  ✦ 屬性點系統 (ATK/DEF/INT/SPD)
  ✦ 等級時屬性點分配 UI
  ✦ 角色面板頁面（Sidebar 點擊開啟）

Week 3: 主動技能系統
  ✦ 技能解鎖（依等級）
  ✦ 技能 CD 計時（localStorage 存 lastUsed）
  ✦ 技能施放 → 觸發對應 API 行為

Week 4: 技能樹 UI + 世界地圖
  ✦ SkillTreeModal 技能樹視覺化
  ✦ WorldMapModal（7 區域，點擊跳轉工具頁）
```

### Phase 2 — 擴充內容（後續）

- Boss 戰副本（完成條件觸發 Boss 擊敗動畫）
- 裝備/強化系統（消耗虛擬金幣強化屬性）
- 多人排行榜（同 server 多使用者比較 XP）
- 第二職業系統（Lv.7 解鎖）
- 季節性限定活動任務

---

## 素材生成 Prompt — 完整版（一次到位）

---

### 角色 Sprite Sheet 規格（全動畫）

每個職業需輸出 **4 張 Sprite Sheet PNG**（透明背景）+ **4 個 GIF**（預覽用）：

| 動作 | 幀數 | Sprite Sheet 尺寸 | GIF FPS | 說明 |
|------|------|-------------------|---------|------|
| Idle（待機）| 4 幀 | 256×96px | 6 FPS | 輕微呼吸浮動，循環播放 |
| Attack（攻擊）| 3 幀 | 192×96px | 10 FPS | 揮砍/施法，播放一次 |
| Hit（受傷）| 2 幀 | 128×96px | 12 FPS | 閃紅後退，播放一次 |
| Victory（勝利）| 3 幀 | 192×96px | 8 FPS | 舉手慶祝，循環 2 次 |

**Sprite Sheet 排列規則：**
- 所有幀**橫向排列**，無間距
- 每幀固定 64×96px
- 透明背景（PNG alpha）
- 檔名格式：`class-{name}-{action}.png`

**需輸出的檔案（每職業 × 8 個）：**
```
class-commander-idle.png     (256×96, 4幀)
class-commander-attack.png   (192×96, 3幀)
class-commander-hit.png      (128×96, 2幀)
class-commander-victory.png  (192×96, 3幀)
class-commander-idle.gif     (預覽用, 6fps)
class-commander-attack.gif   (預覽用, 10fps)
class-commander-hit.gif      (預覽用, 12fps)
class-commander-victory.gif  (預覽用, 8fps)
```
（其他 4 個職業依此命名，共 40 個檔案）

---

### 通用技術規範（所有 Prompt 共用）

```
Art style: 16-bit pixel art RPG sprite
Background: fully transparent PNG (alpha channel)
Pixel grid: hard pixel edges, NO anti-aliasing, NO blur, NO gradients, NO sub-pixel rendering
Outline: 1-pixel solid dark outline (#0A0A0A) on all character edges
Shading: 2-3 shades per color area, cel-shaded flat look
Reference style: Final Fantasy Tactics / Tactics Ogre / Fire Emblem GBA sprites
Canvas per frame: 64x96 pixels (width x height)
Character occupies roughly 80% of frame height (~76px tall), centered horizontally
Feet at bottom of frame, head with 4px clearance from top
```

---

### ⚔️ Commander（指揮官）

**配色：** Gold `#FFD700` · Navy `#0A0F1E` · Cyan `#00FFFF` · Dark Gray `#2D3748`

**外觀描述：**
```
Character design — Commander class QA team leader:
- Outfit: polished gold heavy plate armor with dark navy blue trim and cyan accent lines
- Helmet: open-face knight helmet, small glowing cyan gem centered on forehead
- Weapon (right hand): gold command baton/war staff with a red "!" exclamation mark etched near tip
- Shield (left arm): small round buckler shield with a crossed-out bug symbol in red
- Cape: short dark navy cape behind shoulders, rigid at bottom edge
- Boots: armored sabatons in gold with navy toe caps
- Expression: confident smirk, determined eyes
```

**Idle Sprite Sheet** — `class-commander-idle.png` (256×96, 4 frames, 6 FPS loop)
```
Pixel art sprite sheet, 256x96 pixels total, 4 frames of 64x96 arranged left to right,
transparent background, no anti-aliasing, 16-bit RPG style, Commander class.
[Above character design applies]

Frame 1 (x:0):   Neutral standing pose. Baton held at side pointing slightly upward.
Frame 2 (x:64):  Body shifts UP 1px. Baton hand rises 1px. Cape bottom edge shifts right 1px.
Frame 3 (x:128): Back to neutral. Shield arm lowers slightly 1px. Gem pulses slightly brighter.
Frame 4 (x:192): Body shifts DOWN 1px. Cape bottom edge shifts left 1px. Baton returns to side.

Frames must be pixel-perfect consistent — identical design, only minor positional offsets.
Output: single flat PNG, 256x96px, fully transparent background.
```

**Attack Sprite Sheet** — `class-commander-attack.png` (192×96, 3 frames, 10 FPS once)
```
Pixel art sprite sheet, 192x96 pixels total, 3 frames of 64x96 arranged left to right,
transparent background, no anti-aliasing, 16-bit RPG style, Commander class.

Frame 1 (x:0):   Wind-up — body leans back slightly, baton pulled back behind right shoulder.
Frame 2 (x:64):  Strike — body lurches forward 2px, baton thrusts forward and right with cyan motion blur trail (3-4 pixels wide).
Frame 3 (x:128): Recovery — body returns to neutral, baton back to side, small cyan sparkles (3-4 pixels) near tip.
```

**Hit Sprite Sheet** — `class-commander-hit.png` (128×96, 2 frames, 12 FPS once)
```
Pixel art sprite sheet, 128x96 pixels total, 2 frames of 64x96 arranged left to right,
transparent background, no anti-aliasing, 16-bit RPG style, Commander class.

Frame 1 (x:0):   Impact — entire character overlaid with 40% red tint (#FF0000 at 40% opacity blend on each pixel). Body shifts right 2px.
Frame 2 (x:64):  Recoil — character shifts back left 1px, red tint fades to 15%. Shield raised defensively.
```

**Victory Sprite Sheet** — `class-commander-victory.png` (192×96, 3 frames, 8 FPS loop×2)
```
Pixel art sprite sheet, 192x96 pixels total, 3 frames of 64x96 arranged left to right,
transparent background, no anti-aliasing, 16-bit RPG style, Commander class.

Frame 1 (x:0):   Right arm raised with baton pointing straight up. Body shifts UP 1px. Big grin.
Frame 2 (x:64):  Baton swings to 45° angle, left fist pumped up. Small gold star sparkles (2px) at baton tip.
Frame 3 (x:128): Both arms slightly lowered, triumphant open-palm pose. Cape flares left.
```

---

### 🔓 Hacker（駭客）

**配色：** Dark Purple `#4C1D95` · Neon Green `#00FF41` · Black `#0A0A0A` · Cyan `#0891B2`

**外觀描述：**
```
Character design — Hacker class dark-ops coder:
- Outfit: fitted black hoodie with glowing circuit-board pattern on sleeves (neon green lines), slim dark pants
- Hood: hood up and pulled forward, face half-shadowed, only glowing green eyes visible
- Weapon (right hand): glowing purple energy blade / data-shard dagger, crackling with static
- Accessory (left hand): small holographic screen tablet floating/attached to left forearm, showing falling matrix code
- Belt: fingerless gloves, small USB drives clipped to belt, tiny earpiece with wire on left ear
- Shoes: dark tactical boots with neon green stitching
```

**Idle Sprite Sheet** — `class-hacker-idle.png` (256×96, 4 frames, 6 FPS loop)
```
Pixel art sprite sheet, 256x96 pixels, 4 frames of 64x96 left to right,
transparent background, no anti-aliasing, 16-bit RPG style, Hacker class.
[Above character design applies]

Frame 1 (x:0):   Neutral lean — weight slightly on left leg. Blade held low at side.
Frame 2 (x:64):  Holo-screen flickers (1 new green pixel appears on screen). Body sways right 1px.
Frame 3 (x:128): Eyes glow brightens (1-shade lighter green on eyes). Body returns to neutral.
Frame 4 (x:192): Blade pulses (adds 1px purple glow along edge). Body sways left 1px.
```

**Attack Sprite Sheet** — `class-hacker-attack.png` (192×96, 3 frames, 10 FPS once)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Hacker class.

Frame 1 (x:0):   Crouch stance — knees bent, blade pulled back to left hip. Eyes narrow.
Frame 2 (x:64):  Dash strike — body leaps right 3px, blade slashes diagonally with purple slash trail (4px diagonal line). Green speed lines on left side.
Frame 3 (x:128): Landing — body settles, blade crackles with residual sparks (2-3 colored pixels). Holo-screen flashes white briefly.
```

**Hit Sprite Sheet** — `class-hacker-hit.png` (128×96, 2 frames, 12 FPS once)
```
Pixel art sprite sheet, 128x96 pixels, 2 frames of 64x96, Hacker class.

Frame 1 (x:0):   Red tint overlay 40% on all pixels. Body shifts left 2px. Hood flicks back slightly.
Frame 2 (x:64):  Red tint 15%. Body shifts right 1px. Crouches defensively, blade raised up.
```

**Victory Sprite Sheet** — `class-hacker-victory.png` (192×96, 3 frames, 8 FPS loop×2)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Hacker class.

Frame 1 (x:0):   Points blade upward, holo-screen shows "ACCESS GRANTED" in tiny green pixels.
Frame 2 (x:64):  Blade sparks with purple+green electricity burst at tip (4-5 pixel cluster). Body leans back casually.
Frame 3 (x:128): Crosses arms, hood tilts left, green eyes squint in satisfied expression. A tiny "✓" pixel icon floats above head.
```

---

### 🛡 Guardian（守護者）

**配色：** Steel Blue `#4A90D9` · Dark Gray `#374151` · Cyan `#00FFFF` · Silver `#9CA3AF`

**外觀描述：**
```
Character design — Guardian class heavy tank:
- Outfit: massive full-plate armor, steel-blue chest plate, dark gray limb armor, thick rounded shoulder pauldrons
- Helmet: full enclosed great-helm with narrow horizontal visor slit, faint cyan inner glow visible through slit
- Shield (left arm): large rectangular tower shield, embossed eye/monitor icon in center with scan-line pattern
- Weapon (right hand): large warhammer with square head, etched blue glowing runes on hammer face
- Chest: small row of 3 LED-like dots on breastplate (green/amber/red like system status lights)
- Boots: wide armored sabatons, flat heavy stance, planted firmly
```

**Idle Sprite Sheet** — `class-guardian-idle.png` (256×96, 4 frames, 6 FPS loop)
```
Pixel art sprite sheet, 256x96 pixels, 4 frames of 64x96, Guardian class.
[Above character design applies]

Frame 1 (x:0):   Solid upright stance. Shield planted vertically. Hammer resting on right shoulder.
Frame 2 (x:64):  Hammer shifts 1px right. LED dot on chest blinks (middle dot turns off). Body stable.
Frame 3 (x:128): Visor glow pulses 1-shade brighter. Shield shifts 1px left. Body drops 1px.
Frame 4 (x:192): All returns to Frame 1. LED dot returns on. Slight weight shift back.
```

**Attack Sprite Sheet** — `class-guardian-attack.png` (192×96, 3 frames, 10 FPS once)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Guardian class.

Frame 1 (x:0):   Wind-up — hammer swung back over right shoulder with both hands, body twists left. Shield arm extended for balance.
Frame 2 (x:64):  Slam — hammer drives downward-right with massive force. Blue rune glow explodes outward (5px starburst at hammer head). Ground-level shockwave (2px horizontal white line at feet).
Frame 3 (x:128): Recovery — hammer back to shoulder. Rune glow fades to 1 shade. Shield returns to guard position.
```

**Hit Sprite Sheet** — `class-guardian-hit.png` (128×96, 2 frames, 12 FPS once)
```
Pixel art sprite sheet, 128x96 pixels, 2 frames of 64x96, Guardian class.

Frame 1 (x:0):   Red tint 40%. Shield raised to face level to block. Body pushed back 2px right.
Frame 2 (x:64):  Red tint 15%. Shield at mid level. Body returns 1px left. Visor dims slightly.
```

**Victory Sprite Sheet** — `class-guardian-victory.png` (192×96, 3 frames, 8 FPS loop×2)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Guardian class.

Frame 1 (x:0):   Shield raised high in left arm, hammer thumped on ground at right. Body UP 1px.
Frame 2 (x:64):  Shield tilts 15°, hammer raised with runes glowing max brightness. LED dots all green.
Frame 3 (x:128): Both arms lowered to victory stance. Tiny cyan sparks (2px each) float above shield.
```

---

### 🏹 Ranger（遊俠）

**配色：** Forest Green `#166534` · Brown `#78350F` · Cyan `#00FFFF` · Tan `#D4A76A`

**外觀描述：**
```
Character design — Ranger class fast scout:
- Outfit: fitted light leather armor, dark brown vest over forest green tunic, short flowing cape at back
- Head: no helmet, hood down, goggles resting on forehead (cyan lens), alert eyes
- Weapon: hi-tech composite cyber-bow held in left hand, drawn position, cyan glowing string
- Arrow: nocked arrow with glowing cyan arrowhead, pointing right at 45° angle
- Quiver: on back, 3 visible arrow feather tips, cyan-tipped arrows
- Belt: wide leather utility belt with multiple small pouches, rope coil
- Boots: knee-high laced leather boots, light sole for agility
- Stance: slight forward lean, weight on front foot, ready to release
```

**Idle Sprite Sheet** — `class-ranger-idle.png` (256×96, 4 frames, 6 FPS loop)
```
Pixel art sprite sheet, 256x96 pixels, 4 frames of 64x96, Ranger class.
[Above character design applies]

Frame 1 (x:0):   Alert ready stance. Bow drawn halfway. Eyes scanning right.
Frame 2 (x:64):  Bow string pulled slightly further. Cape shifts left 1px. Eyes shift to center.
Frame 3 (x:128): Bow returns to half-draw. Cyan arrowhead glows 1-shade brighter. Body UP 1px.
Frame 4 (x:192): Weight shifts back 1px. Bow relaxes to quarter-draw. Eyes return right-scan. Body DOWN 1px.
```

**Attack Sprite Sheet** — `class-ranger-attack.png` (192×96, 3 frames, 10 FPS once)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Ranger class.

Frame 1 (x:0):   Full draw — bow pulled to maximum. Arrow at full nock, cyan glow intensifies to max. Eyes locked forward. Cape blown back.
Frame 2 (x:64):  Release — arrow flies off right (shown as cyan streak 5-6px horizontal line leaving frame). Bow arm snaps forward. Body recoils left 1px.
Frame 3 (x:128): Follow-through — bow arm extended, string relaxes. Quiver loses 1 arrow silhouette. New arrow being drawn with right hand.
```

**Hit Sprite Sheet** — `class-ranger-hit.png` (128×96, 2 frames, 12 FPS once)
```
Pixel art sprite sheet, 128x96 pixels, 2 frames of 64x96, Ranger class.

Frame 1 (x:0):   Red tint 40%. Body flinches back-right 2px. Bow arm drops reflexively. Cape flares forward.
Frame 2 (x:64):  Red tint 15%. Quick duck/crouch position. Bow re-raised to guard. Body returns 1px.
```

**Victory Sprite Sheet** — `class-ranger-victory.png` (192×96, 3 frames, 8 FPS loop×2)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Ranger class.

Frame 1 (x:0):   Bow raised overhead in one fist. Free hand gives thumbs-up. Goggles pushed up, eyes wide and bright.
Frame 2 (x:64):  Bow arm lowers to shoulder level. Tiny cyan arrow drawn in air pointing to self (self-celebrating gesture). Body UP 1px.
Frame 3 (x:128): Casual lean — bow slung over shoulder, free hand on hip. Confident smirk.
```

---

### 🔮 Sage（賢者）

**配色：** Deep Purple `#4C1D95` · Gold `#FFD700` · White `#F1F5F9` · Dark Indigo `#1E1B4B`

**外觀描述：**
```
Character design — Sage class data prophet wizard:
- Outfit: long sweeping wizard robe, deep purple with gold constellation/chart patterns embroidered on hem and cuffs
- Hat: tall pointed wizard hat, purple body with small star pixel pattern, wide gold brim
- Staff (right hand): tall gnarled wooden staff reaching above head height, crystal orb at top showing tiny glowing bar chart inside
- Tome (left hand): thick open spellbook with glowing gold page edges, tiny rune symbols visible on pages, held open at chest level
- Face: calm wise expression, eyes glow faint purple, slight knowing smile, elder but not elderly
- Shoes: curled-tip pointed boots in dark purple, barely visible under robe hem
```

**Idle Sprite Sheet** — `class-sage-idle.png` (256×96, 4 frames, 6 FPS loop)
```
Pixel art sprite sheet, 256x96 pixels, 4 frames of 64x96, Sage class.
[Above character design applies]

Frame 1 (x:0):   Upright pose. Staff planted. Tome held open. Orb glows softly.
Frame 2 (x:64):  Orb glow brightens 1-shade. Robe hem sways right 1px. Tome page flickers (1 rune pixel brightens).
Frame 3 (x:128): Orb dims back to normal. Hat tilts 1px left. Body UP 1px subtly.
Frame 4 (x:192): Staff shifts 1px right. Robe hem sways left 1px. Body DOWN 1px. Orb middle brightness.
```

**Attack Sprite Sheet** — `class-sage-attack.png` (192×96, 3 frames, 10 FPS once)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Sage class.

Frame 1 (x:0):   Casting wind-up — staff raised overhead, orb blazing (max glow). Tome snapped shut under left arm. Robe swirling.
Frame 2 (x:64):  Cast release — orb fires beam downward-right (4px gold+purple beam line). Staff aimed forward. Hat tip glows. Eyes flash white.
Frame 3 (x:128): Aftermath — staff lowered, orb fades to dim. Tome reopened. Small gold sparkles (3px dots) float around staff tip.
```

**Hit Sprite Sheet** — `class-sage-hit.png` (128×96, 2 frames, 12 FPS once)
```
Pixel art sprite sheet, 128x96 pixels, 2 frames of 64x96, Sage class.

Frame 1 (x:0):   Red tint 40%. Body staggers back-right 2px. Tome falls open, pages flutter (3 diagonal lines). Hat knocks askew 2°.
Frame 2 (x:64):  Red tint 15%. Staff raised as barrier. Tome clutched tight. Hat straightens.
```

**Victory Sprite Sheet** — `class-sage-victory.png` (192×96, 3 frames, 8 FPS loop×2)
```
Pixel art sprite sheet, 192x96 pixels, 3 frames of 64x96, Sage class.

Frame 1 (x:0):   Staff raised with orb blazing full gold. Tome held open showing "★ ★ ★" in tiny gold pixels. Hat tilts to side.
Frame 2 (x:64):  Orb releases starburst (8 directional 1px rays). Robe billows outward. Satisfied closed-eye expression.
Frame 3 (x:128): Both arms lowered, staff planted, knowing smile. Stars (3 tiny ★ pixels) float above head in arc.
```

---

### 技能圖示 Prompt（32×32px，透明背景）

**通用規範（每個 Prompt 都加在最前面）：**
```
Pixel art icon, 32x32 pixels, transparent background, PNG format
Style: 16-bit RPG skill icon, SNES/GBA era style
Outline: 1px solid dark outline (#0A0A0A) on all visible edges
Shading: 3 tones max per color, flat cel-shading
No text, no numbers, no letters — pure symbolic visual
No anti-aliasing, no blur, no gradients
```

---

**批量攻勢**（Commander）— `skill-batch-attack.png`
```
[Apply general icon rules above]
Visual: 5 small golden swords arranged in a tight V-formation pointing right
Each sword: 7px long blade, 2px guard, 1px handle — classic RPG sword silhouette
Each sword has a 4-5px cyan energy streak trailing behind it (motion blur effect)
Swords evenly spaced, center sword largest, outer swords slightly smaller
Colors: gold blades #FFD700, darker gold shading #B7950B, cyan trails #00FFFF
```

**號令群雄**（Commander）— `skill-summon.png`
```
[Apply general icon rules above]
Visual: centered gold command flag/banner on a pole, 3 tiny white glowing humanoid silhouettes (5px tall each) arranged in arc below it
8 radial light rays in alternating gold and cyan emanating from behind the flag
Background: small dark navy circle (10px radius) behind flag as base
Colors: gold flag #FFD700, navy circle #0A0F1E, cyan rays #00FFFF, white silhouettes #FFFFFF
```

**代碼破譯**（Hacker）— `skill-decode.png`
```
[Apply general icon rules above]
Visual: top half shows falling matrix code — 3 columns of tiny 1px green character pixels falling downward
Bottom half: the falling code streams converge into a glowing gold key silhouette (8px tall key shape)
Effect: code transforms into the key, showing "breaking encryption" concept
Colors: neon green code #00FF41, gold key #FFD700, dark background #0A0A0A, white highlights on key teeth
```

**AI 注入**（Hacker）— `skill-ai-inject.png`
```
[Apply general icon rules above]
Visual: a sharp white lightning bolt (zigzag, 3px wide) strikes from top-center down to a circuit board in bottom half
Circuit board: 5-6 horizontal and vertical cyan lines (1px each) in grid pattern, with 3 small square nodes
At impact point: small starburst explosion (5px white+cyan pixels)
Colors: white lightning #FFFFFF, cyan circuits #00FFFF, electric yellow bolt edge #FFFF00, dark board background #0A0A0A
```

**持久監控**（Guardian）— `skill-monitor.png`
```
[Apply general icon rules above]
Visual: merged eye-within-shield icon — outer shape is a rounded shield (24px wide, 28px tall)
Inside shield: large stylized eye centered — oval iris, dark pupil, highlight pixel
Shield has 3 horizontal scan lines (1px each, evenly spaced) in cyan over lower portion
Eye iris glows bright blue, pupil is dark navy
Colors: steel gray shield #9CA3AF, silver highlight #E5E7EB, blue iris #3B82F6, cyan scanlines #00FFFF
```

**連環測試**（Ranger）— `skill-chain-test.png`
```
[Apply general icon rules above]
Visual: 3 chain links connected diagonally left-to-right, each link oval (8×5px), silver colored
Inside each chain link: tiny green checkmark (✓) pixel symbol (3×3px)
Cyan glow (1px blur simulation via lighter pixels) around connecting points between links
Colors: silver links #D1D5DB, dark silver shading #9CA3AF, cyan glow nodes #00FFFF, green checks #10B981
```

**機率洞察**（Sage）— `skill-insight.png`
```
[Apply general icon rules above]
Visual: large magnifying glass (18px diameter lens, 6px handle at bottom-right)
Lens: circular gold frame (1px border), inner area shows 4 ascending bar chart bars (white pixels)
Bar heights: 4px, 6px, 8px, 10px — clearly ascending trend
Handle: 6px brown/gold diagonal line with gold cap
Colors: gold frame #FFD700, purple-tinted lens fill #4C1D95, white bars #FFFFFF, brown handle #78350F
```

**全域覺醒**（Lv.10 傳說）— `skill-legend.png`
```
[Apply general icon rules above]
Visual: 8-pointed starburst / sunburst centered at icon midpoint (16,16)
4 long rays (10px each) at 0°/90°/180°/270° in gold
4 shorter rays (6px each) at 45° diagonals in bright white
4 tiny sparkle dots (1px) at the very tip of each short ray, in alternating cyan and yellow
Center: 4×4px bright white-gold core square
Outer rim: 1px circular halo of rainbow pixels (approximated: 1 red, 1 orange, 1 yellow, 1 green, 1 cyan, 1 blue, 1 purple pixel arranged in arc)
Colors: gold rays #FFD700, white rays #FFFFFF, cyan accents #00FFFF, warm yellow #FFF200
```

---

*文件版本：v1.2 | 更新日期：2026-05-02*
