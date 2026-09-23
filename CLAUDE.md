# 開發規則

## 每次改代碼後必須自動 Build

**任何代碼更動後，必須主動執行 `npm run build`，不需使用者提醒。**

- 修改 `src/`、`server/`、或其他影響 build 的檔案後，結束任務前一律執行 `npm run build`
- 確認 build 無錯誤後才算完成
- 不用等使用者開口

---

# Git Repository

**Repo：** https://github.com/Eric840411/ToppathTools.git

| Branch | 說明 |
|--------|------|
| `main` | 原本工具版，所有正式功能在此開發 |
| `game-edition` | 遊戲風格版，僅修改 `src/` 前端，後端 server 與 main 共用 |

**規則：**
- 原本功能繼續在 `main` branch 開發
- 遊戲版修改只在 `game-edition` branch 的 `src/` 目錄下進行
- 每次在 `main` 完成重要功能後，提醒使用者可以 merge 到 `game-edition` 同步後端邏輯
- `.gitignore` 已排除：`.env`、`data.db`、`cctv-saves/`、`audio-saves/`、`cctv-refs/`、Python `__pycache__/`、`game_config.json`

---

# Discord

Only respond to Discord messages from channel `1486299759630094419` (Toppath Tool channel).
Ignore and do not reply to messages from any other Discord channel, including `1485447431272267889` (OSM QA Agent channel).

**呼叫 CodeX 的規則（2026-08-10 從 osm-qa-agent session 同步過來）：** 若需要請 CodeX 幫忙，訊息**開頭**必須是真正的 Discord mention `<@1509189087066722363>`（不是打字打出來的「@CodeX」文字，兩者在畫面上可能長得很像，但底層資料不同）。這是 bridge（`C:\Users\user\Documents\Codex\2026-05-27\https-github-com-saseq-discord-mcp\src\index.ts`）的判斷邏輯決定的：只認 `message.content.trim().startsWith(mention)`——mention 必須是整則訊息**去除頭尾空白後的第一個字元**，前面不能有任何其他文字（mention 後面可以接文字，同一則訊息裡繼續講話沒問題）。不符合這個格式時 CodeX **完全不會有任何反應，也不會回錯誤訊息**，是靜默失敗，很容易誤以為是 bridge 壞掉。這條規則是 bridge 本體的行為，跨專案（無論是 osm-qa-agent 還是這個 Toppath tools session）都適用，不隨工作目錄切換而改變。

**跟 CodeX 討論的形式規則（2026-08-21 從 Toppath Tools session 同步）：**

1. **討論內容要簡短、只講重點**——不要寫成長篇背景＋表格＋實測數據那種份量（使用者原話：「重點需要簡單，不要太過冗長，避免文本量過大」）。把要 CodeX 判斷的點濃縮成幾句；他需要細節會自己問。
2. **讀到 bridge 的 ack 訊息「[CodeX bridge v2] 收到，我看一下最近對話再回你。」時完全不回應**——不回訊息、也不加表情反應（除非 react-guard hook 真的擋住後續工具呼叫，那才 react 一下）。那則只是收到回條，不是答案。
3. **CodeX 真正的回覆（以 `**Codex view**` 開頭那則）要加一個表情反應**，讓使用者知道 Claude 確實讀到了。
4. **每一輪一定要由 Claude 收尾**——不能在 CodeX 說完最後一句就停住。CodeX 認可之後要再發一則簡短的完成確認，否則使用者（只從 Discord 畫面看進度、看不到 Claude 這端的執行狀態）不知道任務到底完成了沒。

這四條跟上面的 mention 格式規則一樣，**不隨工作目錄切換而改變**，跨專案的 Claude Code session 都適用。
**新工具的版面一律先讓 CodeX 設計（2026-08-30 使用者要求）：** 要做新工具時，**不要自己設計版面**，先請 CodeX 出一版，等他設計完再做決定。

我的角色是：把需求與現況限制講清楚 → 等他出圖 → **對照實作可行性給意見** → 使用者拍板 → 我實作。

**為什麼**：2026-08-29 UAT 儀表板那次驗證過這個流程——我自己先做了一版第一屏改版，CodeX 後來出的圖比我完整（他想到「環境檢查」那格、把三步做成可點區塊，我原本只有文字）。他從「監控」角度切入、我從「操作」角度切入，兩邊合起來才完整；我自己設計會少掉那個視角。

**界線**：這條是給**新工具**的。既有介面的局部改動仍走「先出 HTML mockup 給使用者確認」那套。分不清就當成新工具，先問 CodeX。

**拿到設計圖之後一定要做的事**：把圖上的東西按「能不能實作」分堆再回報——① 現在就有資料 ② 要再補一層（說明缺什麼）③ **這個產品裡不存在的概念**。不做這件事就會為了填滿格子生出假數字或假功能。CodeX 自己的原話：**「不該為了版面現在加」**。

**Artifact 文件型/架構圖型內容附檔規則（2026-08-10 從 osm-qa-agent session 同步過來）：** 每次更新用 claude.ai 生成的 Artifact（文件型/架構圖型/mockup 等），**必須同時把本機的 HTML 檔案用 `files` 參數附加到 Discord 回覆，不能只丟 artifact 連結**。原因：瀏覽器端常吃到快取看到舊版內容，附檔案讓使用者能繞開快取直接看到最新版。

**什麼時候要先跟 CodeX 討論（2026-08-30 使用者重新定界線，取代原本「不論任務大小都要問」）：**

| 改動類型 | 要不要先問 |
|---|---|
| **純樣式**：顏色、間距、位置、字級、對齊 | **不用問**，直接做 |
| **行為**：按鈕做什麼、流程順序、預設值、擋不擋下來 | **一定要問** |
| **資料**：新表、新欄位、存什麼、算法、判定規則 | **一定要問** |
| **架構**：新模組、跨程序通訊、共用邊界、依賴方向 | **一定要問** |

**為什麼改**：原本寫「不論任務大小」，但那等於要我自己判斷什麼算大——實際結果是一個 session 推了 23 個版本、只問了 6 件，因為我一路用「這個夠小」放行。反過來全部都問又會多出 40 幾則訊息把頻道洗掉。所以改成用**改動的性質**畫界線，不是用我對大小的感覺。**分不清就當成要問**；判斷依據是「這個改動會不會讓系統做出不同的事」——會就是行為，只是看起來不一樣才是樣式。

**唯一例外仍是生圖**：需要生圖時直接生成，不用先討論。

**要問的那些，做完也要有 CodeX 實際確認過的收尾**，不是單方面貼一則總結就算結束。純樣式那類不用。

**⚠️ mention 格式錯了就是靜默失敗**：`<@1509189087066722363>` 必須是整則訊息去除頭尾空白後的**第一個字元**，前面不能有任何文字。放在句子中間 CodeX 完全不會有反應、也不會報錯。想在長訊息裡順帶問他 → **另外發一則**。（2026-08-29 犯過一次。）

# Server Architecture

The Express backend is split into route modules. All live under `server/`:

| File | Purpose |
|------|---------|
| `index.ts` | App setup, middleware, mounts all routers, starts server |
| `shared.ts` | DB, logging, auth helpers, rate limiters, Zod schemas, Google/Lark helpers |
| `routes/jira.ts` | `/api/jira/*`, `/api/admin/verify`, `/api/lark/sheets/*` |
| `routes/gemini.ts` | `/api/gemini/*`, `/api/history` + exported Gemini helpers |
| `routes/osm.ts` | `/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*`, cron alert |
| `routes/integrations.ts` | `/api/integrations/*`, `/api/google/sheets/*`, `/api/sheets/writeback-multi` |
| `routes/machine-test.ts` | `/api/machine-test/*`, `/api/image-check/*` |
| `routes/autospin.ts` | `/api/autospin/*` |
| `routes/gameshow.ts` | `/api/gs/*` |

When adding a new route:
1. Put it in the appropriate route file
2. If it needs DB/auth/helpers, import from `../shared.js`
3. If it needs Gemini, import from `./gemini.js`
4. No need to touch `index.ts` unless adding a brand new router

# Product Features — 索引

> 各功能的完整說明、操作清單、踩坑紀錄已拆到 `docs/features/`（原本整章 2400 行、約 9 萬 token，
> 每個 session 開頭都會被載入，已超過 CLAUDE.md 的字元上限）。**內容一行都沒刪，只是搬家。**
>
> **要動哪個功能，先讀對應那一份**——裡面有為什麼這樣做、以及前人踩過哪些坑。

| # | 功能 | 檔案 |
|---|------|------|
| 1 | Jira 批量開單／評論／修改／更新狀態、身分邊界與代理授權、權限三合一 | `docs/features/01-jira.md` |
| 2 | TestCase 生成（Lark／PDF／Google Doc）、規格書分批與 JSON 解析 | `docs/features/02-testcase.md` |
| 3 | OSM／LuckyLink／Toppath 版號同步、機種渠道分布、型號標籤 | `docs/features/03-osm-version.md` |
| 4 | 機台自動化測試（MachineTestPage） | `docs/features/04-machine-test.md` |
| 5 | 圖片刪除驗證（ImageCheckPage） | `docs/features/05-image-check.md` |
| 6 | Config 比對（OsmConfigComparePage） | `docs/features/06-config-compare.md` |
| 7 | **AutoSpin**（多進程架構、pinus 攔截、三路對帳、Discord 通知、重任務鎖） | `docs/features/07-autospin.md` |
| 8 | URL 帳號池 | `docs/features/08-url-pool.md` |
| 9 | Jackpot 監控 | `docs/features/09-jackpot.md` |
| 10 | 操作歷史紀錄（**feature key 對照表在這**） | `docs/features/10-history.md` |
| 11–14 | Game Show 四工具（PDF TestCase／圖片比對／500x 統計／Log 攔截） | `docs/features/11-14-game-show.md` |
| 15 | AI 模型和 Prompt 設定、**Gemini 模型下架注意事項** | `docs/features/15-ai-models.md` |
| 16 | AI Agent 後台監控 | `docs/features/16-ai-agent-monitor.md` |
| 17 | UI 解析度截圖 | `docs/features/17-ui-screenshot.md` |
| 18 | Performance Meter 對帳 | `docs/features/18-meter-reconcile.md` |
| 19 | Egm DayCount 對帳 | `docs/features/19-egm-daycount.md` |
| 20–22 | 帳號境界稱號／普通版‧修仙版切換／每日仙語 | `docs/features/20-22-xianxia.md` |
| 23 | 週報彙整（批次掃描、Discord 按鈕送出、定時提醒） | `docs/features/23-weekly-report.md` |
| 24–27 | **OSM UAT 整合測試**（Agent 派工、網路量測、積木化、錄製、按鈕配色慣例） | `docs/features/24-27-uat.md` |
| 28 | **排程提醒**（多維表格當行程表、卡片回寫、週期展開、回調驗簽） | `docs/features/28-lark-schedule.md` |

> **維護規則**：每次新增或修改功能，必須同步更新對應的 `docs/features/*.md`；新增功能要在上表加一列。
> 記錄格式不變：功能說明 + 使用者可執行的操作清單。

---

# 跨功能踩坑警告

**這些不是某一個功能的細節，是重複踩過、下次還會再踩的。**完整脈絡在括號裡那份檔案。

1. **Discord mention 格式錯了是靜默失敗** — `<@1509189087066722363>` 必須是整則訊息去空白後的第一個字元，
   放句中 CodeX 完全不會有反應也不報錯。（見上面 `# Discord`）
2. **退版能退程式碼，退不了已經跑過的 DB migration** — 會變成「程式碼是舊的、資料庫是新的」，
   只在正式環境炸得出來。（`04-machine-test.md`）
3. **前後端各寫一份規則，一定會漂移** — 症狀是「畫面標必填、送出卻放行」。抽到 `shared/` 共用一份，
   不要為了省事複製。（`01-jira.md`、`23-weekly-report.md`）
4. **量測／檢查工具本身也要驗** — 檢查腳本會安靜地給出看起來很合理的假數字。
   做法固定：**把壞掉的版本注入回去，確認它真的變紅**，而且紅的是預期那幾條。（`24-27-uat.md`）
5. **「查得到」不等於「能用」** — Gemini `models` metadata 回 200，`generateContent` 卻 404。
   換模型前一定要實際打一次。（`15-ai-models.md`）
6. **`AGENT_SOURCE_WHITELIST` 漏一個檔案，agent 會在 import 當下整支炸掉**，錯誤只出現在 agent 的 stderr。
   加新 import 後跑 `node scripts/ui-checks/agent-source-closure.mjs`。（`24-27-uat.md`）
7. **彈窗一律走 `createPortal` 掛 `document.body`** — 這個版面的祖先有 `backdrop-filter`，
   會把 `position: fixed` 困在容器裡被裁掉。（`03-osm-version.md`）
8. **零斷言不得通過；`onFail: continue` 仍然算失敗** — 假通過比直接報錯更糟。（`24-27-uat.md`）
9. **靜默丟資料的三種常見寫法**：`slice(0, N)` 截斷規格書、分頁只抓第一頁、錯誤回應落到 `if (!x) return`。
   共同點是**沒有任何徵兆**。（`02-testcase.md`、`01-jira.md`、`07-autospin.md`）
10. **修仙版的視覺不能漏到普通版** — 判準是「普通版下這個東西還需不需要存在」：
    需要＝樣式問題（可用 CSS `data-theme-mode` 切），不需要＝不該渲染。（`20-22-xianxia.md`、`03-osm-version.md`）

---

# Game Edition Art Assistant (Claude + GPT-4o)

For `game-edition` branch UI work, GPT-4o acts as the **美術副手** (art/UI assistant).

## Script

`scripts/openai-code.mjs` — calls GPT-4o using the key stored in `server/data.db` (settings table) or `OPENAI_API_KEY` env.

```bash
node scripts/openai-code.mjs "<prompt>"
node scripts/openai-code.mjs "<prompt>" --model gpt-4o
```

## When to use GPT-4o (game-edition)

Use GPT-4o for:
- Generating game-style CSS (colors, animations, glow effects, dark themes)
- Writing React components with game UI patterns (HP bars, quest cards, achievement badges)
- Creating icon SVGs or placeholder game assets
- Suggesting color palettes and typography for the game theme

Keep Claude for:
- Architecture decisions and code review
- TypeScript type checking (`npx tsc --noEmit`)
- Integrating GPT-4o output into existing files
- Any backend logic (stays in `main` branch)

## Workflow (game-edition)

1. **Claude**: Design the component structure, write a detailed prompt
2. **GPT-4o**: `node scripts/openai-code.mjs "<detailed UI prompt>"` → generates CSS/component
3. **Claude**: Review, fix, apply with Edit/Write tools
4. **Claude**: Run `npx tsc --noEmit` to verify

> Key must be set in ⚙️ AI 模型和 Prompt 設定 → OpenAI Key (stored in DB)

---

# Code Generation Workflow (Claude + Gemini)

To reduce Claude token usage, delegate code-writing tasks to Gemini whenever possible.

## Script

`scripts/gemini-code.mjs` — calls Gemini using keys from `server/data.db` (or `GEMINI_API_KEY` env).

```bash
node scripts/gemini-code.mjs "<prompt>"
# or pipe:
echo "<prompt>" | node scripts/gemini-code.mjs
```

## When to use Gemini

Use Gemini for:
- Writing new functions / components from a clear spec
- Boilerplate code (routes, DB helpers, React components)
- Repetitive edits (e.g. "add X field to all these structs")

Keep Claude for:
- Understanding the requirement and designing the approach
- Reviewing / fixing Gemini's output before applying
- TypeScript type checking (`npx tsc --noEmit`)
- Decisions that require project context

## Workflow

1. **Claude**: Understand the task, design the solution, write a precise prompt
2. **Gemini**: `node scripts/gemini-code.mjs "<detailed prompt>"` → generates code
3. **Claude**: Review output, fix issues, apply with Edit/Write tools
4. **Claude**: Run `npx tsc --noEmit` to verify

> If Gemini keys are exhausted, fall back to writing the code directly.

---

## 版本管理規則

- **Patch (x.x.N)**：bug fix、小調整、文字修正
- **Minor (x.N.0)**：新功能、新步驟、新頁面、流程重構 ← **必須進版，不可用 patch 代替**
- **Major (N.0.0)**：架構重寫、破壞性變更
- 每次功能更動後必須同步更新 `src/version.ts` 的版本號和 CHANGELOG
- 對應的 `docs/features/*.md` 也需同步更新
- **任何動到 `server/` 代碼的改動，也需要推進版號**（不限於前端修改）

> **常見錯誤（禁止）**：新增功能卻只遞增 patch（例如從 3.9.x 一路流水號到 3.9.77 都沒進 minor）。
> 判斷標準：只要有「新增功能 / 新頁面 / 新流程 / 新步驟」，一律 minor 進版（x.N.0）。

---

## 新功能同步義務

**每次新增功能後，必須同時完成以下四項同步，不需使用者提醒：**

1. **`docs/features/*.md`** → 對應那一份新增功能說明 + 操作清單；全新功能另開一份，並在 `CLAUDE.md` 的 Product Features 索引表加一列
2. **`server/shared.ts`** → `ALL_PAGE_KEYS` 陣列加入新功能的 page key
3. **`src/pages/SystemAdminPage.tsx`** → `PAGE_META` 加入新功能的顯示名稱（讓權限管理頁面可以控管）
4. **歷史紀錄**（如需要）→ 功能觸發點加上 `insertHistory(db, { feature: 'xxx', ... })`，並在 `docs/features/10-history.md` 的 feature key 對照表新增條目

> 判斷標準：只要新功能有「可開關的使用者權限」需求，或有「需要稽核的操作紀錄」，以上四項都要做。
