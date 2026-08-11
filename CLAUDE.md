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

**Artifact 文件型/架構圖型內容附檔規則（2026-08-10 從 osm-qa-agent session 同步過來）：** 每次更新用 claude.ai 生成的 Artifact（文件型/架構圖型/mockup 等），**必須同時把本機的 HTML 檔案用 `files` 參數附加到 Discord 回覆，不能只丟 artifact 連結**。原因：瀏覽器端常吃到快取看到舊版內容，附檔案讓使用者能繞開快取直接看到最新版。

**任何任務執行前都要跟 CodeX 討論（2026-08-10 從 osm-qa-agent session 同步過來，使用者要求兩邊 session 都套用）：** 不論任務大小，執行前都要用 `<@1509189087066722363>` mention 拉 CodeX 進來討論，不是只在一開始討論完設計就自己單獨執行到底——包含決策、實作、修改都算。**唯一例外是生圖**：需要生圖時直接生成，不用先跟 CodeX 討論猶豫。任務做完後，**要有 CodeX 實際確認/同意過的收尾**，不是單方面貼一則總結就算結束——要等 CodeX 回覆確認才視為完成。

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

# Product Features & User Operations

> **維護規則**：每次新增或修改功能，必須同步更新此章節。記錄格式：功能說明 + 使用者可執行的操作清單。

---

## 1. Jira 批量開單（JiraPage）

**路由**：`/api/jira/*`｜**歷史紀錄 feature key**：`jira`、`jira-comment`

### 功能說明
從 Lark Bitable 讀取規格，批量在 Jira 建立 Issue、批量添加評論、批量轉換狀態。

**PM 模式已移除**：原本的 QA/PM 雙模式切換（`mode` state）與 PM 模式專屬的「從 Lark PM 規格自動建立 Epic + Story」流程（`JiraPmModeTab.tsx`、後端 `/api/jira/pm-read-bitable`、`/api/jira/pm-batch-create`）已整個拿掉，現在只保留 4 大批量工具（開單/評論/更新狀態/修改）。帳號管理（`JiraAccountModal.tsx` 的 `role` 欄位/`accountHasRole()`）與全域權限系統（`permissions` 的 `jira-pm` key、`SystemAdminPage.tsx` 的「Jira 批量開單（PM 模式）」權限項）刻意保留未動，供未來若要重新加回類似功能時使用，目前純粹是未使用的殘留權限位。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇帳號 | 從全域帳號選單選擇 Jira 操作者身份 |
| 批次開單（Step 1–5） | 讀取 Lark Bitable → 選專案/Issue Type → 預覽清單（含欄位篩選）→ 確認執行 → 進度追蹤（前端逐筆呼叫 `/api/jira/batch-create`，每筆回應後累加進度條；不是 SSE，跟批量評論不同）|
| Step 3 欄位篩選 | 自動偵測下拉式選單欄位（2–15 個唯一值），可按嚴重度/類別/進度等篩選後再勾選列 |
| Step 3 動態欄位開單 | 載入 Jira 專案實際欄位；摘要/描述/受託人/RD負責人/回報人 為強制必填並自動顯示，未填擋下送出；可從 Lark 自動帶入這些欄位值，其餘選填欄位可手動新增 |
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition；完成後回填處理階段「已切換狀態」|
| 批量評論（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測 Issue Key 列，不需經過開單流程直接批量加評論 |
| 批量修改（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），選擇 Jira 欄位與 Sheet 欄位對應，批量修改摘要/描述/優先級等欄位 |
| 批量更新狀態（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測含 Jira 單號的列，批量執行 transition |
| 批量修改 — 描述附件 | Step 3 預覽表每列有附件欄：可選 Sheet 圖片欄自動讀取（點「讀取附件」），或 + 手動上傳；送出後圖片以 !filename! wiki markup 嵌入描述，影片以 [^filename] 方式嵌入；有未上傳影片時送出前彈出確認 |
| 重新讀取 Sheet | 批量開單/批量評論/批量修改/批量更新狀態 皆有此按鈕（Step 2 以後、頂部步驟列），操作到一半時可重新拉取最新 Sheet 資料，不切換 step、不清空已勾選/已填寫內容，只同步新增/移除的列 |
| 切換工具自動帶入 Sheet 網址 | 批量開單/評論/更新狀態/修改 4 個工具切換時自動帶入「最後使用的 Sheet」網址，不用每次都重貼；切到評論/更新狀態/修改會自動帶入並自動重新讀取一次（每個分頁這次頁面停留期間只自動觸發一次，之後靠手動「讀取」/「重新讀取」按鈕），切到批量開單只帶入網址（Step 1 選專案/類型要先完成，不自動送出讀取請求）|
| 查看成員 / 專案 | 列出帳號可存取的 Jira 成員和專案清單 |

### 開單完成回填欄位
批量開單成功後自動回填以下 Lark Sheet 欄位：

| 欄位名稱 | 內容 |
|----------|------|
| Jira issue key | Issue Key（如 CGMN-26）|
| Jira URL | Jira 完整 URL |
| 處理階段 | 開單→`已開單`；評論→`添加評論`；轉換→`已切換狀態` |
| 處理時間 | 操作完成時間 |
| 單子標題貼這 | `CGMN-26`（Jira 超連結）+ 換行 + Issue 摘要 |

### 處理階段偵測邏輯
| 處理階段值 | 偵測條件 | 動作 |
|------------|----------|------|
| （Jira Key 空白） | — | 執行開單 |
| 已開單（或空白，有 Key） | Jira Key 有值 + 處理階段 = `已開單` 或空 | 執行添加評論 |
| 添加評論 | Jira Key 有值 + 處理階段 = `添加評論` | 執行轉換狀態 |
| 已切換狀態 / 已完成 | 任何其他值 | 跳過（視為終態）|

### 4 個批量工具的穩定性修復（2026-08-03）

一次性審視 4 個批量工具（批次開單、批量評論、批量修改、批量更新狀態）後修的問題：

- **批量更新狀態：沒選目標狀態不再誤標成功**——`/api/jira/bulk-update` 先前不管有沒有選 `transitionId`（下拉選單有「不切換」選項，值為空字串）都回 `ok:true`，畫面上跟真的切換成功長得一樣，且會誤把「已切換狀態」寫回 Sheet 的處理階段欄。改成回傳 `skipped:true` 明確區分，前端顯示獨立的「⏭️ 跳過」列，Sheet 回填只算真的成功切換的列。
- **批量修改：新增處理階段追蹤**——先前完全沒有任何機制防止同一份 Sheet 被重複執行，重複跑會把附件重複上傳、描述重複疊加 `!filename!`。成功的列現在會回填「處理階段＝已修改欄位」，重新讀取/重新整理 Sheet 時，已處理過的列預設不勾選（可手動勾回去），並在清單上標示「已改過」提示。
- **批量評論：background job 改成持久化到 DB**——`commentJobStore` 先前純記憶體，worker 重啟會直接砍掉正在跑的 job，前端 polling 只會拿到含糊的「job not found」。新增 `jira_comment_jobs` 表，每次進度更新都快照；worker 啟動時把上次還沒跑完的 job 標記成中斷，回傳明確訊息（已完成 X/Y 筆、剩餘 Z 筆），前端沿用既有的 `stopped`/`stoppedReason` 顯示機制（新增 `stoppedKind: 'ai_quota' | 'worker_restart'` 區分文案，不會誤套用 Gemini 專用的錯誤說明）。**沒有自動續傳**——重啟後不會自動重新發送剩下的留言（風險是可能造成同一筆留言重複貼兩次，比使用者自己確認後手動重跑剩下幾筆的風險更高，對留言這種不能撤銷的操作不值得冒險）。
- **批次開單/批次轉換狀態：修正重任務鎖範圍**——`tryStartHeavyTask` 先前是「每一筆」HTTP request 拿放（前端逐筆呼叫），兩次 round-trip 之間鎖是空的，兩個分頁同時跑同一帳號的批次開單理論上會交錯執行、有機會重複開單；批次轉換狀態先前甚至完全沒上鎖。新增批次鎖 session（`POST .../begin` 拿 `batchToken`，逐筆請求都帶著它跳過重新搶鎖，跑完 `POST .../end` 釋放；3 分鐘閒置逾時自動清理，防止分頁關掉/斷線後永久卡住名額）。
- **批量修改：送出前重新確認 Issue 是否還存在/可存取**——比照批量更新狀態既有的 pre-flight re-validation 模式，送出前重新呼叫 `/api/jira/batch-fetch-fields`，過濾掉 Step 2 讀取之後被刪除/搬移/權限變更的 Issue，讓使用者確認要不要略過再繼續。
- **批次開單/批次轉換狀態/批量修改：加上 Jira API 節流**——原本只有批量評論有固定 2 秒間隔，其他三個對 Jira API 完全沒有節流，大批量時容易撞到 rate limit；統一補上 300ms 延遲（批次開單因為是「一筆一個 HTTP request」的架構，节流靠前端逐筆呼叫本身的網路延遲，沒有額外加延遲）。
- **4 個工具的歷史紀錄補上實際變更內容**——先前 `addHistory` 只存 `{issueKey, ok, error}`，事後查歷史紀錄看不出到底改了什麼。批次開單補上摘要文字、批量評論補上留言內容預覽（截斷 300 字，AI 重排版的情況下是使用者原始輸入而非逐字比對）、批量修改補上實際改的欄位/值與附件檔名、批次轉換狀態新增 `addHistory`（先前完全沒有）。

---

## 2. TestCase 生成（LarkPage）

**路由**：`/api/integrations/lark/*`、`/api/integrations/generate-testcases-file`｜**歷史紀錄 feature key**：`testcase`

### 功能說明
從多份規格書（Lark Wiki / PDF / Google 文檔，可混合）使用 Gemini 生成 TestCase，並寫回 Lark Bitable。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 新增來源 | 貼上 Lark Wiki / PDF URL / Google Doc URL，可混合多份 |
| 選擇 AI 模型 | Gemini / Ollama / OpenAI，從 AI 模型設定頁管理 |
| 執行生成 | SSE 即時串流進度，後台逐份讀取合併後送 Gemini 生成 |
| 寫入 Bitable | 生成完成後自動寫入指定 Lark Bitable URL |
| 下載 JSON | 不寫 Bitable，直接下載生成的 TestCase JSON 檔案 |
| 查看 ImageRecon 週報 | 解析 Gmail 最新 ImageRecon 週報，比對目標版本 |

---

## 3. OSM Tools — OSM 版號同步（OsmPage）

**路由**：`/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*`｜**歷史紀錄 feature key**：`osm-components`、`luckylink-components`、`toppath-components`、`osm-sync`、`osm-alert`

### 功能說明
追蹤 OSM / LuckyLink / Toppath 各元件版本，同步渠道機器設定，發送版本告警。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看版本歷史 | 列出 OSM / LuckyLink / Toppath 各元件的版本紀錄 |
| 同步元件版本 | 拉取最新版本資料，儲存到 DB |
| 同步全渠道 | 對所有渠道執行 machine push/pull，更新設定 |
| 手動觸發版本告警 | 比對各渠道版本，發現未達標項目推送 Lark 告警 |
| 設定排程告警 | 設定 cron 時間，定時自動版本告警 |
| 從 Lark 同步同步目標 | 從 Lark Sheet 讀取目標版本清單 |
| Config 比對 | 貼上渠道 URL，與 Template 比對設定差異 |
| Frontend 機台管理 | 查看 / 自動更新前端機台清單 |

---

## 4. OSM Tools — 機台自動化測試（MachineTestPage）

**路由**：`/api/machine-test/*`｜**歷史紀錄 feature key**：`machine-test`

### 功能說明
使用 Playwright 對機台進行全自動化測試，包含進入/推流/Spin/音頻/iDeck/觸屏/CCTV/退出等步驟。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 設定機台代碼清單 | 輸入待測機台代碼（支援多台並行） |
| 選擇大廳 URL | 每個 Worker 使用一個大廳 URL（支援多 Worker 並行） |
| 勾選測試步驟 | 進入/推流/Spin/音頻/iDeck/觸屏/CCTV/退出，可組合選擇 |
| 選擇日誌 API 環境 | QAT / PROD，影響 daily-analysis URL |
| Headed 模式 | 勾選後瀏覽器視窗顯示在螢幕上（預設隱藏）|
| AI 音頻分析 | 勾選後 VB-Cable 錄音上傳 Gemini，AI 判斷音頻問題 |
| 操作流程面板 | 展開查看目前設定的步驟順序與各機種設定檔資訊 |
| 執行測試 | 啟動 Playwright，SSE 即時串流每台機器的測試日誌 |
| 停止測試 | 中止當前進行中的測試 session |
| 查看測試結果 | 表格顯示每台機器各步驟的 PASS/WARN/FAIL/SKIP 狀態 |
| Lark 回寫 | 將測試結果寫回 Lark Sheet 的 QA問題回報欄位 |
| 從 Lark 匯入機台 | 讀取 Lark Sheet 中尚未驗證通過的機台代碼 |
| 管理機種設定檔 | 新增/編輯/刪除各機種的 bonusAction / touchPoints / iDeck XPath / 進入觸屏等設定 |
| OSMWatcher 狀態 | 查看目前 OSMWatcher 回報的機台狀態（透過 webhook 更新）|

### 分散式 Work-Stealing 架構（v3.9.0）

- Server 建立 JobQueue（含所有待測機台），不再預先分配給 Agent
- 各 Agent 加入 session 後，透過 `claim_job` → `job_assigned`/`no_more_jobs` 動態領取下一台
- Agent 完成每台機器後回報 `job_done`，再領下一台，直到 `no_more_jobs`
- 最快跑完的 Agent 自動接手更多機台，充分利用多機器效能
- `queue_update` 事件即時推送至前端，顯示每台機器的狀態、Agent 及耗時

### 自動化測試步驟流程（v3.8.0）
```
導航至大廳 URL
→ 進入機台（entryTouchPoints S1/S2 → enterGMNtc）
→ [checkOsm] 推流檢測（video/canvas）
→ [checkOsm] Spin 測試（3 次點擊，比對餘額變化）
→ [checkOsm] 音頻檢測（5s VB-Cable 錄音 + dB 分析 + 可選 AI）
→ [checkOsm] iDeck 測試（XPath 按鈕點擊 + daily-analysis API 確認）
→ [checkOsm] 觸屏測試（span 文字點位 + daily-analysis API 確認）
→ [checkOsm] CCTV 號碼比對（截圖 + Gemini Vision OCR）
→ [checkOsm] 退出測試（btn_cashout → leaveGMNtc，errcode=10002 時自動重試最多 3 次）
```
> `[checkOsm]`：每步驟前檢查 OSMWatcher 狀態，若偵測到特殊遊戲（FG/JP/Handpay），執行指定 bonusAction 一次後持續 Spin 直到 status=0。

**Spin 測試面額選擇遮罩處理（2026-07-31 修復）**：`.select-main` 面額選擇遮罩蓋住 Spin 按鈕時點擊不會拋 Playwright 的「intercepts pointer events」例外——遊戲只是完全收不到 Spin 動作，`stepSpin()` 原本只在例外處理（catch）裡才 force click 的邏輯完全不會被觸發，會固定卡滿 8 秒判定逾時、餘額沒變化。跟 AutoSpin.py 早就修過的同一個問題（見上方 AutoSpin 章節「選面額遮罩攔截 Spin 點擊」），但 Machine Test 這邊當時沒有同步移植。修法：把 `stepIdeck()` 裡原本局部（closure）的關閉遮罩邏輯抽成模組層級共用函式 `dismissDenomOverlay(page, emit, source)`，`stepSpin()` 每次點擊 Spin 按鈕前都先呼叫一次主動關閉遮罩，不再只依賴例外處理；`stepIdeck()` 呼叫點同步改用共用版本。

### 機種設定檔欄位
| 欄位 | 說明 |
|------|------|
| `machineType` | 機種識別碼，從機台代碼中段提取（如 JJBX） |
| `bonusAction` | 遇到特殊遊戲時的動作：`auto_wait` / `spin` / `takewin` / `touchscreen` |
| `touchPoints` | 觸屏測試點位（span 文字內容清單）|
| `clickTake` | 觸屏完成後是否額外點擊 .btn_take |
| `spinSelector` | 自訂 Spin 按鈕 CSS selector |
| `balanceSelector` | 自訂餘額元素 CSS selector |
| `exitSelector` | 自訂退出按鈕 CSS selector |
| `ideckRowClass` | iDeck 按鈕所在 row 的 class（如 row4）|
| `ideckXpaths` | iDeck 按鈕 XPath 列表（優先於 ideckRowClass）|
| `entryTouchPoints` | 進入機台第一階段觸屏（選擇面額等）|
| `entryTouchPoints2` | 進入機台第二階段觸屏（YES/NO 確認）|
| `gmid` | gameid URL 參數，用於設定檔 fallback 比對 |

---

## 5. OSM Tools — 圖片刪除驗證（ImageCheckPage）

**路由**：`/api/image-check/*`

### 功能說明
在 Toppath 內嵌瀏覽器中操作遊戲，自動驗證已刪除的圖片是否仍被載入。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 貼上已刪除圖片清單 | 輸入 blob URL 或路徑列表 |
| 貼上前端 URL | 遊戲頁面 URL，供 Playwright 開啟 |
| 啟動驗證 | 後台啟動 Playwright，自動截圖並比對 |
| 截圖/點擊/捲動 | 互動操作瀏覽器 |

---

## 6. OSM Tools — Config 比對（OsmConfigComparePage）

**路由**：`/api/osm/config-compare`、`/api/osm/config-templates/*`｜**歷史紀錄 feature key**：`osm-config-compare`

### 功能說明
貼入渠道 config URL，與儲存在 DB 的 Template 比對差異。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 貼上 URL 進行比對 | 即時顯示差異欄位 |
| 管理 Config Template | 新增/編輯/刪除模板，儲存在 DB |

---

## 7. OSM Tools — AutoSpin（AutoSpinPage）

**路由**：`/api/autospin/*`｜**歷史紀錄 feature key**：`autospin`

### 功能說明
管理 AutoSpin 自動旋轉。執行採 **agent-hub 派工模式（A2）**：在「執行監控」選擇線上 agent（與機測/腳本化投注同一批 agent-runner，含 macOS），agent 端在本機 spawn 既有的 Python 引擎（`server/python/toppath-agent.py`，cv2 模板比對引擎不變），log/截圖/狀態透過既有 REST/SSE 回報。公網（Spug）上 server 不需跑瀏覽器/OpenCV，重活都在 agent 端。伺服器端 `spawn` 模式保留為 fallback。

**多機台改成多進程（每台機台一個獨立 process），不再是單一迴圈輪流跑（2026-07-30）**：Playwright **sync API** 官方明文只支援單執行緒操作，原本一支 agent process 裡所有機台共用同一個 browser/context，靠 `while True: for mp in machine_pages: ...` 單一迴圈輪流服務每台機台——`do_spin()` 內的 Playwright 呼叫是阻塞式的，機台越多，每台實際被輪到 Spin 的頻率越低，且任一台卡住/逾時（最長到 8 秒）會拖慢所有其他台，完全不是平行執行，只是瀏覽器視窗都開著、看起來「活著」而已。改成 `machine_worker(session_id, server_url, user_label, cfg, keyword_actions, machine_actions)`：每台機台在自己獨立的 process 裡跑一份完整的 `sync_playwright()` + browser + context + page + Spin 迴圈，一台掛掉/卡住不會影響其他台。`main()`（parent process）只負責向伺服器登錄一次拿到共用的 `session_id`，然後對每台啟用的機台各自 `multiprocessing.Process(target=machine_worker, ...)`，最後 `.join()` 等全部結束才呼叫 `send_stopped()`（session 層級動作，絕不能讓某一台提前結束就誤觸發，會連帶把還在跑的其他台一起標記成已停止並結束 Discord 通知）。**每台間隔 2 秒分批啟動**（`STAGGER_START_SEC`），不是全部 `.start()` 一次全開——同時開好幾個 Chromium 是資源尖峰，容易讓效能較弱的裝置卡住。

**停止/暫停完全不需要跨 process 通訊**：每個 child process 各自獨立的 `poll_stop()` 執行緒輪詢同一個 `session_id` 的 `/should-stop` 端點，伺服器端一聲令下、所有 process 各自在下一次心跳（≤3 秒）內收斂，不需要 parent 特地轉發訊號給 child——`parent` 只在收到 SIGINT/SIGTERM（例如 agent-runner.ts 直接砍掉 parent process）時，才需要主動呼叫每個 `multiprocessing.Process.terminate()`（送出 SIGTERM），觸發各 child 自己的訊號處理常式優雅關閉瀏覽器，避免留下孤兒瀏覽器行程。

**module-level 全域變數改成「parent 登錄一次、child 各自賦值」的模式**：`session_id`/`server_url`/`user_label`/`keyword_actions`/`machine_actions` 這幾個原本在整份 script 頂層執行一次就固定的變數，改成在 `machine_worker()` 一開始用 `global` 賦值——因為 multiprocessing 在 Windows／macOS 預設都是 `spawn` 模式（不是 `fork`），child process 是重新 import 整份模組、不是複製記憶體，所以頂層一次性的註冊/登錄 HTTP 呼叫必須包在 `if __name__ == "__main__":` 底下的 `main()`，否則每個 child 重新 import 時會各自再打一次 `/agent/start`、各自建立新 session，互相蓋掉。`button_health`/`osm_status_cache`/`spin_interval_override` 等其餘 module-level 狀態不用特別處理，`spawn` 重新 import 本來就會讓每個 child 拿到全新、互相獨立的一份，天然達到隔離效果。

**已修正（2026-07-30）：`poll_stop()` 的「session 遺失後自動重新登錄」fallback 在多進程架構下會卡死**——伺服器重啟後所有 child process 各自獨立偵測、各自獨立打 `/api/autospin/agent/start` 重連，第一個成功的會拿到新 session、佔走這個操作者（`taskUser(req)`，Agent 端固定是 IP-based 的 `guest`）的 heavy-task 名額，緊接著幾乎同時打進來的其他 child 只會看到「已被佔用」而失敗——Python 端 `new_data['sessionId']` 因為衝突回應沒有這個欄位而拋出 `KeyError: 'sessionId'`，永遠卡在「重連失敗，將在下次輪詢重試」（每 3 秒重試一次，但每次都撞同一個衝突，跟原本單一 process 架構下不會發生的邊界案例不同，這裡是每次伺服器重啟都會真的發生）。修法：`/api/autospin/agent/start` 偵測到 heavy-task 衝突時，先檢查衝突對象是不是同一種 `autospin-agent` 任務、而且已經有一個屬於同一個 `userLabel` 的 running session（就是剛剛搶到名額的那個 child 建立的）——如果是，直接讓這個 child 加入既有 session（回傳同一個 `sessionId`），不再擋下來；同時這個「加入既有 session」的路徑不會重新對每台機台發送「排隊中」Discord 通知（`isNewSession` 旗標控制），避免把已經在跑的機台狀態誤蓋回排隊中。

**再修正（2026-07-31）：`taskUser(req)` 的 IP fallback 會讓不同帳號的 Local Agent 互相誤判成同一個操作者**——上面 v3.79.3 那版修的是「同一個帳號、同一個 session 底下多個 child process 重連」的衝突；但 `server/heavy-task-guard.ts` 的 `taskUser(req)` 本身對 Python agent 這種無 cookie/無 `x-jira-email` 的請求，先前只認 `req.body.account`/`req.body.jiraEmail`（AutoSpin agent 實際送的 body 是 `{userLabel}`，兩者都對不上），最終一定 fallback 到 `req.ip`。真實案例：使用者 A 的 Local Agent 啟動裝置 A 順利執行，使用者 B 的 Local Agent 要啟動裝置 B 卻連線失敗——因為 A、B 兩台 Local Agent 剛好在同一個辦公室網路後面（對外是同一個 IP），heavy-task-guard 把兩個不同帳號當成同一個操作者，B 的註冊被 A 的重任務鎖擋下（`heavyTask.ok=false`），且衝突對象的 `userLabel` 是 A 不是 B，v3.79.3 的「加入既有 session」判斷也對不上，一樣落入 429 衝突分支。修法：`taskUser(req)` 的 fallback chain 補上 `req.body.userLabel` 與 `x-user-label` header（IP 之前），AutoSpin agent 本來就會送 `userLabel`，直接用它辨識帳號，不會再跟其他帳號的 IP 衝突。**同時修正 Python 引擎的錯誤處理**：`main()` 收到伺服器回應後先檢查 `data.get('ok')`，衝突時印出伺服器實際給的 `message`（例如「你目前已有重任務正在執行：...」），不再是無助於除錯的 `KeyError: 'sessionId'`。

**每台機台心跳機制 + 斷線自動重連（2026-08-03，v3.81.0）**：多進程架構下，一台機台的 process 卡死（例如瀏覽器已無回應但 process 本身沒死）或直接終止（真的 crash），先前完全沒有偵測/復原機制——長時間執行下，一旦某台掛掉，剩下的機台繼續正常跑，但那台的紀錄從此不再更新，且不會自動恢復，只能整個 Agent 重啟才會重新拉起全部機台。新增機制：
- `machine_worker()` 新增 `heartbeats` 參數（`multiprocessing.Manager().dict()`，parent 建立後傳給每個 child）——主 Spin 迴圈**每次迭代開頭**（含暫停中）都寫入 `heartbeats[machineType] = time.time()`。一般 dict/全域變數在不同 process 之間不會同步，必須透過 Manager 的 proxy 物件。
- **`wait_for_normal_osm_status()` 內部也要持續寫入心跳**：這個函式處理特殊遊戲（FG/JP）時內部有自己的 while 迴圈，最長可以合法跑到 15 分鐘（+ cooldown 10 秒），比外層迴圈一次迭代正常耗時長非常多——如果只在外層迴圈開頭寫心跳，機台正常等待特殊遊戲結束時會被誤判成「心跳過期＝卡死」而被錯誤重啟，所以這個函式也接收 `heartbeats` 參數，兩個內部 while 迴圈的每次 `time.sleep(1.0)` 之後都補寫一次。
- `main()`（parent）新增監控迴圈：每 20 秒（`MONITOR_INTERVAL_SEC`）巡一次所有機台，判斷 `proc.is_alive()` 是否為 False（process 已終止）或心跳是否超過 120 秒（`HEARTBEAT_STALE_SEC`）沒更新（process 活著但卡死）——符合任一條件就 `terminate()` 舊 process（如果還活著）、重置該台心跳、`spawn_machine(mt)` 重新啟動一份全新的獨立 process，沿用同一個 `session_id`。**心跳從未寫入過（`hb == 0`）的機台不會被重啟**——這代表機台在進入主迴圈前就結束了（沒設定 Game URL、或無法進入遊戲），是設定問題不是斷線，重啟也沒用。每台機台**最多自動重啟 5 次**（`MAX_RESTARTS_PER_MACHINE`），超過上限就不再嘗試、印警告訊息，避免真的壞掉的機台無限重啟造成資源浪費。
- **parent 自己也獨立輪詢 `/should-stop`**（跟每個 child 各自的 `poll_stop()` 是分開的兩份輪詢），讓 parent 能自行判斷「整個 session 該停了」——監控迴圈只在 `global_stop` 未設定時才會嘗試重啟，避免使用者按下「停止」、機台正常結束關閉的過程中，被監控迴圈誤判成異常又重新拉起來。

**AutoSpin agent session 持久化到 DB（2026-08-03，v3.82.0）**：`agentSessions`（`server/routes/autospin.ts`）先前完全只存在 worker process 的記憶體裡，worker 一重啟（部署新代碼的日常操作，光是這一天就重啟了 6 次）就整批消失，正在跑的 session 每次都得依賴 Python 端「偵測 session 遺失 → 重連」這條有風險的路徑才能恢復。新增 `autospin_agent_sessions` 表（`server/shared.ts`），每 5 秒把目前所有 session 的快照（`id`/`status`/`startedAt`/`lastHeartbeat`/`stopRequested`/`pauseRequested`/`userLabel`/`spinIntervalOverride`/`heavyTask`/LuckyLink 相關欄位——**不含** `logs`/`screenshots`，那兩個純粹是即時檢視用的記憶體 buffer，重啟遺失也沒差，真正重要的歷史/截圖資料本來就各自獨立寫進 DB/磁碟）寫進這張表；`autospin.ts` 模組載入時（也就是 worker 每次啟動時）優先從這張表復原進 `agentSessions`，不再需要仰賴重連。復原後沿用既有的 `/agent/status` 30 秒心跳逾時自動過期邏輯判斷是真的還在跑還是已經死了，不需要重複一套 staleness 判斷。快照寫入時同時 diff 掉記憶體裡已經不存在（被既有 2 小時 SESSION_GC 清掉）的 session，DB 裡不會累積殭屍資料。**這個修法有直接用假資料驗證過**：停掉 worker、手動塞一筆 `autospin_agent_sessions` row、重啟 worker，`/api/autospin/agent/status`（帶對應 `x-user-label`）正確回報 `running: true` 且拿到同一個 `sessionId`。

**重任務鎖（`activeTasks`）同步復原（同一批 v3.82.0）**：`server/heavy-task-guard.ts` 的 `activeTasks` Map 也是純記憶體，如果只修 `agentSessions` 持久化，會出現「session 復原了、但保護它的重任務鎖卻在 worker 重啟時消失」的縫隙，讓同一個操作者理論上能在 session 復原的同時又啟動第二個衝突的重任務。修法：`heavy-task-guard.ts` 模組載入時，從既有的 `heavy_tasks` 表（本來就會持續寫入，只是先前只當成稽核記錄用，`tryStartHeavyTask()` 的實際衝突判斷完全只看記憶體）讀出 `status = 'running'` 的 row 回填進 `activeTasks`。超過 24 小時還是 `'running'` 的 row 視為真的異常結束（process 死掉、從沒機會呼叫 `finishHeavyTask()`），標記成 `error` 收尾，不永久佔住操作者的名額——長時間任務（AutoSpin/Machine Test/OSM UAT）本來就可能跑好幾小時，24 小時是留足夠寬裕的容錯空間。

**斷線重連訊息改寫本機檔案（同一批 v3.82.0）**：`poll_stop()`（child 用）偵測到 `sessionNotFound` 時的「嘗試重新連線」/「重連失敗」訊息，先前只用 `print()` 印終端機——這類訊息發生當下 `session_id` 本來就是無效的（連線問題本身就是原因），用 `log()` 送到伺服器一定被 404 吞掉，網頁「執行日誌」面板永遠看不到失敗訊息；終端機視窗又常被多台機台持續產生的日誌洗版蓋過去，長時間跑下來肉眼很難在終端機裡找到特定一次的重連事件（實際案例：使用者反應偵測到重連訊息但找不到後續是成功還是失敗）。新增 `local_log(msg)`：印 console 的同時額外寫進固定檔案 `server/python/agent-reconnect.log`（跟 `toppath-agent.py` 同目錄），不受終端機捲動緩衝區限制，之後可以直接開檔案搜尋確認。「重新連線成功」那行原本就有額外呼叫 `log()`（因為那個當下 `session_id` 已經是新的有效值），這個維持不變，只是額外也寫進本機檔案方便一次搜尋到完整前後脈絡。

進入機台流程（entryTouchPoints/entryTouchPoints2 兩階段進入觸屏 + enterGMNtc 確認）與 Spin 點擊/餘額讀取（pinus WebSocket 攔截，非 DOM selector）皆與 `server/machine-test/runner.ts` 同步；`entryTouchPoints`/`entryTouchPoints2`/`spinSelector`/`balanceSelector`/`bonusAction`/`touchPoints`/`clickTake`/`ideckXpaths` 讀取自 `machine_test_profiles` 表（`ideckXpaths` 對應 DB 欄位是 snake_case 的 `ideck_xpaths`），由 `/api/autospin/agent/start` 合併進 configs 回傳給 Python 引擎。**對應 key 不是用 AutoSpin 自己的 `machineType`**（使用者手打、格式不受控，容易對不上）**，而是取 `gameTitleCode` 的中段**（例如 `"873-DFDC-0003"` 取 `"DFDC"`，跟 `machine_test_profiles.machineType` 的命名慣例一致），`gameTitleCode` 格式不對時才 fallback 回 `machineType`（`profileKeyFor()` 函式）。元素比對的是疊在畫面上、看不到的 `<span>` 觸控層文字（不是視覺上看到的按鈕文字），格式為「數字,數字」。Spin 按鈕若被上層元素（選面額面板、宣傳彈窗等）攔截點擊，改用 JS `el.click()` 直接觸發下層按鈕，不用真實滑鼠座標硬點。另有 pinus 訊息監控（攔截 `window.pinus.request`/`.on` 所有 request/response/push，非僅 coin 欄位）與瀏覽器 console.warn/console.error 攔截（WebSocket 斷線、遊戲端原生報錯），每台機每 2 秒批次轉發到執行日誌，前綴分別為 `[pinus:xxx]`/`[console:warn]`/`[console:error]`；所有回報用的網路呼叫（進度回報/截圖上傳/Lark 推播/日誌上傳）皆為背景執行緒非同步，不會卡住主 Spin 迴圈。

**pinus 監控補丁改成打在 prototype 上，不再跟遊戲賽時機（2026-08-07，v3.90.14）**：center update（熱更新切換 connector）或斷線重連時，遊戲會建立一個全新的 `window.pinus` 物件（`Object.create(EventEmitter.prototype)`，已用使用者 DevTools 截圖證實），舊物件上打的補丁對新物件完全無效。早期版本（v3.90.1→v3.90.12）一路嘗試「補丁生效前就註冊好的監聽器永遠不會被追溯包裝」這個問題，手法從固定輪詢（200ms）逐步收緊成 WS open 事件觸發＋30ms 輪詢，本質上都是在跟遊戲的同步初始化程式碼賽跑（如果遊戲是「建立新 pinus 物件 → 同一個 tick 內就同步呼叫 `.on('moneyNtc', ...)`」，任何非同步的事件驅動/輪詢天生就贏不了），實測已確認 v3.90.12 版本仍會在熱更新那一刻起永久漏接 `moneyNtc`（`do_spin()` 的訊號②完成判定連帶失效，RISINGROCKETS 這類天生用不上訊號①的機種會固定卡滿 8 秒 `timeout_8s`）。**v3.90.14 改用 `patchMethod()`**：沿 prototype chain 往上找到「實際定義 `.on()`/`.request()` 這個方法的物件」，直接補在那裡而不是補在 instance 上——`.on()` 幾乎必然定義在 `EventEmitter.prototype` 上（EventEmitter 模式通例，不會每個 instance 各自覆寫一份），只要成功補丁過一次就永久生效，之後所有共用同一個 prototype 的新 instance（包含尚未發生的下一次重連）自動繼承補丁版本，徹底消除時機賽跑，不需要再猜「哪個事件點更早」。`.request()` 若在這個遊戲是 instance-level 方法（跟 reqId 計數器等狀態綁在一起，每次 connect() 重新賦值），`patchMethod()` 會 fallback 補在 instance 上，維持原本「靠輪詢/WS事件每次重連後重新補一次」的行為——風險較低，因為 `request()` 是「發送後等回應」，沒有 `.on()` 這種「先註冊、可能永遠不會再呼叫第二次」的一次性視窗問題。

**特殊遊戲偵測（OSMWatcher + bonusAction）**：只讀取 Machine Test 現成維護的 `osmMachineStatus` map（`server/routes/machine-test.ts` export，未修改該檔案本身），透過 `/api/autospin/agent/:id/should-stop` 心跳（每 3 秒）把整個狀態 map 一起帶給 Python 引擎快取。行為對齊 Machine Test 的 `checkOsm`/`waitForNormalStatus`：偵測到特殊狀態（FG/JP，status 1/2/3/4/5/8）時執行機種設定檔的 `bonusAction`（spin/takewin/touchscreen/auto_wait，讀自 `machine_test_profiles`，由 `/agent/start` 合併進 configs）一次，之後持續 Spin 直到狀態恢復（或 15 分鐘逾時），恢復後再 10 秒 cooldown spin；status=9（Handpay）只記錄不處理，需人工介入。**相容 fallback**：完全沒有 OSMWatcher 資料時（該機台從未出現在 `osmMachineStatus` 裡），改用連續 10 次 Spin 前後餘額都相同來推測進入特殊遊戲，觸發時執行一次 `bonusAction`（不做等待迴圈，執行完就重置計數繼續正常 Spin）。

**Spin 前後餘額記錄**：`do_spin()` 現在回傳 `(balance_before, balance_after, rejected)`（失敗回傳 `None`），每次有變化或每 10 次 Spin 會記錄一行輸贏差額到執行日誌；目前只寫日誌，未存進 `autospin_history` 資料庫欄位（該表目前只有單一 `balance` 欄位，沒有 before/after 配對欄位）。`rejected` 代表這次 Spin 的 pinus `dealGMActionReq` 請求被遊戲伺服器直接拒絕（例如 errcode:100「請求超時或未確認錯誤」）——這種情況下 spin 動作根本沒在伺服器端執行，按鈕 disabled 切換／coin 更新兩個完成訊號都不會觸發，`do_spin()` 靠監控腳本追蹤 `window.__lastSpinErr`（`dealGMActionReq` 回應 errcode≠0 時寫入）立即中斷等待並記錄真正原因，不會再傻等滿 8 秒被誤標成 `timeout_8s`；main loop 也不會把這種「餘額沒變」計入連續無變化次數，避免誤判成特殊遊戲亂觸發 `bonusAction`。

**選面額遮罩（`.select-main`）攔截 Spin 點擊**：這種遮罩點擊時不會拋例外（跟「上層元素攔截點擊拋 intercepts pointer events」不同），遊戲只是完全收不到 Spin 動作，靠例外處理的 JS 強制點擊 fallback不會被觸發，會固定卡滿 8 秒判定 timeout_8s。`dismiss_denom_overlay(page, mt)` 完整移植自 `machine-test/runner.ts` 的 `dismissDenomOverlay()`：偵測 `.select-main .select-btn, .select-main .my-button`，找到就點第一個選項（JS 強制 click）。`do_spin()` 一開始就會呼叫，不只在剛進場時才處理——Bet Change/Cashout 等操作之後這個遮罩也可能重新彈出蓋住 Spin。

**Jackpot 中獎通知彈窗（`.notification-close`）自動關閉（2026-08-07）**：跟選面額遮罩同一類問題——「WIN THE JACKPOT」中獎通知彈窗（顯示中獎機台/帳號資訊）會蓋住畫面含 Spin 按鈕，且不是只在特定時機出現，任何時候都可能彈出。`dismiss_jackpot_notification(page, mt)` 偵測 `.notification-close` 關閉鈕，找到就點擊（JS 強制 click）。`do_spin()` 每次呼叫都會執行，跟 `dismiss_denom_overlay()` 呼叫順序相鄰。目前只加在 AutoSpin，Machine Test 的 Spin 測試步驟較短暫（一次只點 3 下）未同步加入，之後若真的遇到才補。

**觸屏點擊 `wait_for_span_text()` 不檢查可見性**：觸屏測試用的 `.screen-touch` 疊加層 `<span>` 是完全透明的，Playwright 的 `is_visible()` 對這種 span 一律回傳 `False`——`machine-test/runner.ts` 的 `waitForSpanText()` 早就針對這點只檢查元素存在（`count() > 0`），AutoSpin 的 Python 版本需要保持同步做法，不能加可見性檢查，否則 entryTouchPoints/entryTouchPoints2/bonusAction=touchscreen 的座標點會全部誤判成「找不到元素」。

**QAT/PROD 日誌 API（daily-analysis）同步**：機台設定新增 `logApiEnv`（`'qat'`/`'prod'`，預設 `qat`）欄位，AutoSpin 執行中每台機每 5 秒背景輪詢一次 `https://{qat|prod}-osmtrace.osmslot.org/api/machine/daily-analysis?gmid=<gameTitleCode>&date=YYYY-MM-DD`（跟 Machine Test 的 `pollMachineLog()` 同一支 API），把「上次輪詢之後」新出現的 timeline 紀錄印到執行日誌（`[machineType][daily-analysis] 時間 type 內容`）。第一次輪詢只記錄基準時間、不印歷史紀錄，避免整批倒灌洗版；跨日時基準時間自動重置。輪詢本身用 `async_call()` 丟到背景執行緒，不會卡住主 Spin 迴圈。查詢失敗（網路不通/逾時/非 200）不會整個吞掉不出聲，每 60 秒印一次警告。

**按鈕健康度追蹤（`track_button_health()`）**：daily-analysis 的 `success_json` 事件是「按鈕指令有沒有被硬體/遊戲端正確處理」的確認事件（跟 Machine Test iDeck 測試步驟用的 `getIdeckTimes()` 判斷邏輯同一套語意），關鍵欄位：`error`（0=正常，非 0=真的異常）、`cmd`（十六進位字串=iDeck 按鈕，座標字串如 `"19,38"`=觸屏）、`is_ideck`/`is_touch`（分類）。不逐行印每個 success_json（會洗版），改成維護滾動計數：`error != 0` 立即印一行醒目警告（附 `cmd` 方便定位是哪顆按鈕），每累積 `BUTTON_SUMMARY_EVERY`（20）次按鈕確認事件印一次摘要（`iDeck X/Y 正常，觸屏 X/Y 正常`）。純資料來自既有的 daily-analysis 輪詢，沒有額外打 API。

> `SPECIAL_GAMES = {'BULLBLITZ', 'ALLABOARD'}` 與 `machine_actions`（`toppath-agent.py`）目前仍是未串接的殘留變數——按鈕尋找已經靠 `SPIN_SELECTORS_DEFAULT` 的 fallback chain（含 `.btn_spin .my-button` 這個專門給這類特殊按鈕結構用的 selector）涵蓋，`machine_actions`（machine-test 風格座標點擊）尚未實作，待後續確認範圍。

**隨機下注（BetRandom）XPath 改成完全共用 machine_test_profiles.ideck_xpaths（2026-07-30）**：`machine_test_profiles.ideck_xpaths` 這個欄位當初設計就是要取代獨立的隨機下注機制（`machine-test/types.ts` 型別註解直接寫「replaces ideckRowClass + betRandomConfig」），但先前從未真的接上 AutoSpin——AutoSpin 派工（`/api/autospin/agent/start`）過去是讀完全獨立的 `bet_random.json` 檔案（配有專屬「隨機下注」頁面管理），跟 Machine Test 的 iDeck XPath 設定是兩份互不相關的資料。已完成整合：AutoSpin 的 SQL 查詢加入 `ideck_xpaths`，跟 spinSelector/touchPoints 等欄位一樣用 `profileKeyFor()` 合併進每台機台的 config（`cfg.ideckXpaths`），`toppath-agent.py` 的 `execute_bet_random()` 改成直接吃這個已合併好的清單，不再需要自己比對 game_title_code。獨立的 `bet_random.json`、對應的 `GET/PUT /api/autospin/bet-random` 端點、以及 AutoSpin 頁面的「隨機下注」Tab 已全部移除；機台設定表格上的「隨機下注」欄位保留（純開關），滑鼠移上去有提示文字說明 XPath 改到「機台自動化測試」的機種設定檔配置。**遷移時已將舊 `bet_random.json` 裡的資料一次性搬進 `machine_test_profiles.ideck_xpaths`**（沒有對應機種的新建、已有資料但是空的補齊、已有資料且不同的保留原樣不覆蓋），確認沒有 XPath 因此遺失。

**定時彙總報告（長時間穩定性統計，v3.74.0）**：跟按鈕健康度追蹤同一批被動資料源，不主動點按鈕、不影響主 Spin 迴圈節奏。追蹤五類指標：
- **errcode 次數**：`dealGMActionReq` pinus 回應的 `errcode` 滾動計數（`window.__spinErrCounts`），可對照 err5/err29 等錯誤碼表判斷是否異常。
- **RECOVER（斷線重連）次數**：`PatchedWS` 監聽 WebSocket open/close 事件累計（`window.__wsRecoverCount`）。
- **kickout 次數**：既有的低餘額自動離機→重進機台流程，新增計數器（`mp['kickout_count']`）。
- **CR checks / 無回應**：沿用 `track_button_health()` 的被動事件，新增 `no_response` 判定——`CR_NO_RESPONSE_TIMEOUT`（60 秒）內沒有任何 daily-analysis 按鈕確認事件即視為異常（`check_cr_gap()`），沒有 response 也算問題。
- **Spin/中獎/總贏分**：`mp['ok_spin_count']`/`win_count`/`total_win`，跟既有 Spin 結果判斷邏輯同步累計。

`maybe_send_status_report(mp, page)`（main-thread，會 `page.evaluate()` 讀計數器）依設定的間隔（分鐘）判斷是否該送出，算出「本次區間內」與「累計」兩種數字（`report_period_start` 存週期起始快照），組好 payload 後交給 `post_status_report()`（背景執行緒，純網路 POST，不觸碰 Playwright page）非同步送到 `POST /api/autospin/agent/:id/status-report`。間隔與啟用開關透過既有的 `should-stop` 3 秒心跳即時下發（`statusReportEnabled`/`statusReportIntervalMin`），不用重啟 Agent。

**errcode 發生時間點（2026-07-30）**：`window.__spinErrTimes`（`{ "1016": [ts1, ts2, ...] }`，每個 errcode 最多留最近 5 次，epoch ms）跟 `__spinErrCounts` 同一個地方累加，`read_errcode_times(page)` 讀取。只放進 `cumulative`（累計），不像次數一樣切出「本期間」版本——時間點列表沒辦法用相減算出區間差，直接呈現最近幾次的絕對時間即可。

**AI 分析區塊（2026-07-30）**：`generateStatusReportAiAnalysis()`（`server/routes/autospin.ts`）把累計統計（含 errcode 明細與時間點）組成 prompt 丟給 Gemini（`resolveGeminiKeyEntries()` 拿第一組可用 key，不做多 key 輪替重試——這是背景 best-effort 附加功能，不是使用者主動觸發等待結果的前景操作），請它用繁中判斷「是否異常」+「哪個時間段可能機器異常導致中斷」。找不到可用 key、呼叫失敗、逾時（20 秒）一律回傳 `null`，報告照常送出、只是不含 AI 分析區塊，不會拖累整個定時彙總報告功能。**開關預設關閉**（`autospin_status_report_ai_enabled`，Discord 通知設定頁「啟用 AI 分析區塊」）——關閉時完全不呼叫 `generateStatusReportAiAnalysis()`，零額外開銷，考量正式環境長時間跑多台機台會持續累積 AI 費用；真實回報（`/agent/:id/status-report`）與試發送（`/api/autospin/status-report-test`）都跟隨同一個開關。判斷「規則式（不燒 token）vs AI」該選哪個時，優先問使用者，不要預設都開 AI——這類數字型異常判斷（errcode 次數/RECOVER/CR 無回應是否超標）本質是門檻邏輯，訓練專屬模型是不必要的過度工程，比呼叫 Gemini 成本更高、更難維護。

**帳號 → Discord Tag 對照表（2026-07-30）**：`mentionForUserLabel(userLabel)` 依 session 派工時的帳號（`agentSessions.get(sessionId).userLabel`）查 `autospin_discord_user_map`（`settings` 表 JSON 陣列），找到就回傳 `<@discordUserId> ` 字串。**這個 mention 一定要寫進 Discord webhook payload 的 `content` 欄位，不能塞在 `embed` 裡**——embed 的 title/description/fields 就算文字寫 `<@id>` 也不會觸發 Discord 通知/ping，只有訊息本體的 `content` 才會。套用範圍：即時彙報通知（`notifyDiscord()`，含新建訊息與 PATCH 編輯兩種情境，但 Discord 對「編輯訊息新增 mention」通常不會重新推播通知，只有第一次建立訊息時的 ping 保證有效）與定時彙總報告（每次都是全新訊息，一定會 ping）。

**標題附帶 gmid（2026-07-31）**：`maybe_send_status_report()` 從 `mp['config'].get('gameTitleCode')` 取值，經 `post_status_report()` 一併 POST 給伺服器，`buildStatusReportEmbed()` 標題變成 `— {machineType}（{gameTitleCode}）`——單純顯示 `machineType` 在名稱相近時（如 RISINGROCKET / RISINGROCKETS）無法分辨是哪一台機器發的報告，加上 gmid 才能唯一對應。

**執行監控畫面依帳號隔離（2026-07-31 修復）**：`GET /api/autospin/agent/status`（前端輪詢偵測「目前在跑的 session」並自動接上 SSE 日誌/截圖）與 `POST /api/autospin/agent/stop-all`（前端「停止」按鈕）先前都是「不管是誰派工的，抓第一個/全部在跑的 session」，導致不同帳號登入時會看到彼此的執行日誌與截圖，「停止」甚至會連別人正在跑的機台一起停掉——`AgentSession` 本身早就有 `userLabel`（`hub-dispatch` 派工時就會記錄是哪個帳號），只是這兩個端點沒有用上。修法：兩個端點都改成讀取 `x-user-label` header，只回傳/只操作 `s.userLabel` 對得上的 session；前端對應的 4 處 `fetch('/api/autospin/agent/status'/'stop-all')` 補上該 header（用既有的 `getGlobalUserLabel()`，跟 hub-dispatch/hub-agents 等其他呼叫同一套帳號來源）。

**帶 sessionId 的其餘端點也補齊帳號檢查（2026-07-31，Codex review 後補）**：上面那版只擋住「自動偵測」這個發現別人 sessionId 的入口，但 `pause`/`resume`/`spin-interval`/`stream/:id`（SSE）/`screenshot(s)/:id` 這些端點本身仍然「只認 sessionId、不驗證是不是同一個帳號」——正常 UI 流程確實不會再拿到別人的 sessionId，但只要 sessionId 洩漏（舊頁面殘留分享的截圖連結、瀏覽器歷史記錄等），仍能直接操作/讀取別人的 session。新增 `requestUserLabel(req)` 共用 helper（讀 `x-user-label` header，或 `?userLabel=` query——`EventSource`/`<img src>` 無法自訂 header，只能靠 query），套用在這 5 個「前端呼叫」端點，`userLabel` 不對就回 403。**注意分辨呼叫方**：`/agent/:id/log`、`/agent/:id/screenshot`（上傳）、`/agent/:id/stop`、`/agent/:id/should-stop` 這幾個是 **Python agent 自己上報用的**，不是前端指令，不需要（也不能，agent 沒有 x-user-label 概念）加這個檢查。**已知範圍限制**：「伺服器端 (fallback)」模式的 `SessionState`（`/api/autospin/status`）完全沒有 `userLabel` 概念，仍是全域共用，未修——目前使用的主要模式是「遠端 Agent」（agent-hub），fallback 模式較少人同時用，之後若有人真的在 fallback 模式遇到同樣問題再補。

**三路對帳（2026-08-10，v3.91.0）**：AutoSpin 底下新分頁「三路對帳」，跟執行同步、伺服器背景持續跑的即時比對工具，比對三個資料來源：SLS recordBet log（`lib/sls.ts` 的 `fetchRecordBet()`，官方 `@alicloud/sls20201230` SDK）、機台盒子硬體日誌（`fresh_current_credits`，**目前尚未串接來源**）、前端 Pinus history（沿用既有的 `reconcile_front_records` 表，Python agent 本來就會呼叫 `fetch_and_post_pinus_records()` 上傳）。跟 CLAUDE.md 上面的「後台對帳」（`reconcile/*`）是不同工具——後台對帳是使用者手動選時間範圍事後跑一次、比對後台 `gameRecordList`；三路對帳是不需要使用者觸發，AutoSpin 一開始跑，`setInterval` 每 20 秒自動掃描所有執行中 session 的每台機台各跑一次。

**SLS 憑證只從 env var 讀，不提供前端設定（2026-08-10 起，v3.91.1 / v3.92.2 兩次修正）**：v3.91.0 原本做了一個「SLS recordBet 憑證設定」面板讓使用者自己填 AccessKey/Region/Project/Logstore（存 `settings` 表 `sls_*` 前綴），使用者當天立刻回饋不需要這個——`getSlsCreds()`（`server/lib/sls.ts`）改成從 env var 讀。**v3.92.2 又修正一次**：中間版本一度把 AccessKey ID/Secret 直接寫死成程式碼常數（fallback 值），這組真實憑證被 GitHub push protection 擋下（偵測到 commit 裡有 Alibaba Cloud AccessKey），才發現這個做法本身有風險——即使程式碼倉庫是私有的，寫死的密鑰只要進了 git 歷史紀錄就永久留在那裡，之後改掉程式碼也救不回來。最終版本：AccessKey ID/Secret 兩個敏感值完全沒有預設值（讀不到就是空字串，`fetchRecordBet()` 會丟出「SLS 憑證尚未設定」錯誤），只有非敏感的 Region/Project/Logstore 三個保留合理預設值方便本機開發。**部署到新環境（例如正式環境 Spug）時，必須在該環境自己的 `.env` 補上這 5 個變數**（`SLS_RECORDBET_KEY_ID`/`SLS_RECORDBET_KEY_SECRET`/`SLS_RECORDBET_REGION`/`SLS_RECORDBET_PROJECT`/`SLS_RECORDBET_LOGSTORE`），改完要重啟該環境的 server process 才會生效（env var 只在啟動時讀一次）；`.env` 本身不會隨 git push 過去，每個環境要各自維護一份，這是設計上本來就如此。`GET/PUT /api/autospin/compare/sls-config` 兩支端點與前端整個憑證設定面板都已移除；只留 `POST /api/autospin/compare/sls-test` 給後端自己診斷用（curl 確認連線），不接前端畫面。

比對欄位刻意不寫死，使用者在畫面上自訂「比對群組」（例如群組「下注金額」= SLS `requestJSON.amount` + Pinus `bet`），存在新表 `autospin_compare_groups`（全域共用，PUT 整批覆蓋儲存，跟 `reconcile_config` 一樣的定位——比對定義是團隊共同量測標準，不是個人偏好）。比對結果存 `autospin_compare_results`（一列＝一台機器一次 spin，`roundKey` 唯一索引 `(sessionId, machineType, roundKey)`，用 `INSERT ... ON CONFLICT DO UPDATE` 而非單純 insert-or-ignore——因為 SLS 跟 Pinus 兩邊資料到達時間不同步，同一輪可能先被記成 `missing_data`，晚一點另一邊資料補齊時要能更新回同一列，不是變成兩筆重複紀錄）。

**欄位新增改成下拉選單，不讓使用者手打路徑（2026-08-10，v3.91.1 修正）**：v3.91.0 原本用 `window.prompt()` 讓使用者自己打欄位路徑（例如要自己記得打 `requestJSON.amount`），使用者回饋這樣容易打錯、也不知道有哪些欄位可選。改成前端內建 `FIELD_CATALOG`（`AutoSpinPage.tsx`）——SLS 欄位取自 recordBet log 真實的 `requestJSON`/`responseJSON` 結構（跟 `SlsBetRecord.raw` 同一份資料）、Pinus 欄位取自 `reconcile_front_records` 正規化後的欄位（bet/win/orderId/recordTime/gmid/gameid）、盒子欄位目前只先預留使用者原本提過的 `fresh_current_credits` 一個選項（尚未串接，選了也固定顯示缺資料）。每個來源一顆 `<select>`，選了就直接加入群組，不用自己打字也不會選到不存在的欄位。

**依帳號的啟用開關（2026-08-10，v3.91.2）**：跟 Codex 討論後的結論——比對「規則」（群組欄位定義）維持全域共用（團隊量測標準，不應該每人一套，不然結果難以互相解釋），但要不要「執行」比對這件事依帳號各自決定（有人只是想跑 AutoSpin 穩定性測試，不需要額外打 SLS API/寫 DB）。`autospin_notify_prefs` 新增 `compareEnabled` 欄位（沿用既有的每帳號設定表，預設 1／開啟，既有安裝用 `ALTER TABLE` 補齊），`GET/PUT /api/autospin/compare/prefs` 讀寫。`runCompareCycle()` 背景每 20 秒掃描時，逐一 session 先檢查該 session 擁有者（`session.userLabel`）的 `isCompareEnabled()`，關閉的帳號直接 `continue` 跳過（完全不打 SLS/Pinus 查詢也不寫入 `autospin_compare_results`）。畫面上開關放在分頁頂部，關閉時顯示明確提示文字，不是靜默失效。手動「試算目前資料」（`/compare/run-now`）目前沒有跟著這個開關特別處理——它呼叫的是同一個 `runCompareCycle()`，關閉開關的帳號手動點擊也不會產生結果，這是刻意不特別繞過的簡化（真的想再測就先把開關打開）。

**配對邏輯**：SLS `recordBet` 的 `roundId` 欄位（例如 `"900-BZZF-0003|6A79AD7F003"`）與 AutoSpin 機台設定的 `gameTitleCode`（例如 `"900-BZZF-0003"`）前半段格式相同，用來把 SLS log 過濾到正確機台；`roundId` 再跟 Pinus `historyListReq` 回傳的 `order_id` 做精確字串比對配對同一筆下注（沒有做時間相近度 fallback——不像上面「後台對帳」2 路比對那樣有 bet/win/time 容錯配對，3 路對帳目前只信任明確的 ID 對應，避免配錯筆數字反而誤判成不符）。「機台有沒有在跑」的偵測是看 `autospin_history` 最近 5 分鐘內有沒有寫入紀錄（agent 本來就持續在寫），不是自己維護一份派工機台清單（`hub-dispatch` 當下沒有記錄實際派了哪些機台到 session 物件上，這樣判斷更準）。

**盒子日誌尚未串接**：`resolveFieldValue()` 對 `source: 'box'` 的欄位固定回傳 `undefined`，任何包含盒子欄位的比對群組會固定停在 `missing_data` 狀態，前端畫面在有此類群組時會明確顯示黃色提示「盒子硬體日誌尚未串接資料來源」，不會假裝已經比對過。之後真的串接時只需要在 `resolveFieldValue()` 補上 `ctx.box` 的實際資料來源，比對群組設定本身不用重新設定。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇執行 Agent | 從線上、含 `autospin` capability 的 agent 清單挑一台 |
| 派工啟動 | 命令選定 agent spawn Python 引擎執行 AutoSpin（`/api/autospin/hub-dispatch`）|
| 停止 | 命令 agent 停止並結束 Python 程序（`/api/autospin/hub-stop`）|
| 伺服器端 fallback | 切到「伺服器端」可直接在 server 本機 spawn（舊模式）|
| 暫停 / 繼續 Agent | 暫停自動旋轉，保持連線 |
| 查看即時日誌 / 截圖 | SSE 串流 Agent 執行日誌與遊戲截圖；日誌框固定高度＋內部捲動，支援分類篩選（全部/系統/Spin/截圖/錯誤警告）+ 關鍵字搜尋 + 自動捲到底開關 + 清空；pinus 訊息預設收合，可依 7 類（Spin動作/餘額異動/狀態廣播/進入遊戲/連線登入/心跳列表/其他）分別展開；SSE 斷線（如伺服器重啟）會在 2 秒後自動重連。截圖監控為 2 欄縮圖網格，標示最新一張 |
| 三路對帳（獨立 Tab） | 跟執行同步即時比對 SLS recordBet／盒子日誌（尚未串接）／Pinus history，多機台並行、每台獨立統計已比對/相符/不符/缺資料，展開查看逐筆 Spin 明細；自訂比對群組（用下拉選單挑已知欄位，不用手打路徑）、手動「試算目前資料」立即跑一次。SLS 憑證後端寫死，畫面上不會出現、不用設定 |
| 啟用/停用三路對帳（依帳號） | 分頁頂部開關，預設開啟；關閉後自己執行中的機台不會再背景打 SLS/Pinus 查詢、不寫新比對紀錄，比對群組定義（全域共用）不受影響 |
| 查看歷史紀錄 | AutoSpin 各 session 的執行紀錄 |
| 設定 Spin 間隔 | 調整每次 Spin 的等待時間（執行中可即時覆蓋）|
| 管理模板圖片 | 上傳比對模板圖（模板管理 Tab）|
| 複製機台配置 | 機台設定列表「複製配置」按鈕，帶入既有機台的所有設定（模板/RTMP/隨機下注等）當新機台的起點，只需重新輸入機台類型（唯一主鍵，不可留空/重複），不用從頭重新填一次 |
| Agent 下載安裝 | 統一在「Local Agent」頁面下載安裝（Windows install.bat / macOS install-mac.command，含 token），安裝後的 agent 具備 autospin capability |
| 對賬功能 | 比對遊戲紀錄與帳戶餘額，生成對賬報告 |
| Discord 即時彙報通知 | 每台機台開始測試時發一則 Discord 訊息，之後同一則訊息隨狀態更新：`queued`（排隊中）→ `running`（執行中，每次餘額/事件回報時同步更新）→ `success`（完成，session 期間無異常）/ `failed`（完成，曾偵測到餘額異常 >30%）；手動停止或連線逾時另標記 `stopped`。訊息含機台、Game URL、Spin 數、錯誤摘要、截圖連結，不會洗版。Webhook URL 在「Discord 通知」設定頁配置，不寫死頻道 |
| Discord 定時彙總報告 | 長時間穩定性統計，跟上面即時彙報通知是獨立訊息（每次到間隔另發一則新訊息，不覆蓋前一則）——顯示 errcode 次數/RECOVER 斷線重連次數/kickout 次數/CR checks 與無回應次數/Spin 數/中獎數/總贏分，間隔（分鐘）與顯示欄位皆可在「Discord 通知」設定頁調整，預設關閉 |

### Discord 通知設定（DiscordNotifySettingsPage）

**路由**：`/api/autospin/discord-webhook`（GET/POST）、`/api/autospin/discord-webhook/test`（POST）、`/api/autospin/status-report-settings`（GET/POST，定時彙總報告設定）、`/api/autospin/agent/:id/status-report`（POST，Agent 送出彙總報告用）、`/api/autospin/status-report-test`（POST，用假資料試發送彙總報告）

#### 功能說明
獨立的後台設定頁（系統分區），管理 AutoSpin Discord 通知用的 Webhook URL，未來換頻道只需在此頁改網址，不用改代碼。

**依帳號分開設定（2026-07-31）**：通知啟用開關、即時彙報顯示欄位、定時彙總報告（啟用開關/間隔/顯示欄位/自訂備註/AI 分析開關）改成**依帳號分開**，存在新表 `autospin_notify_prefs`（PRIMARY KEY `userLabel`）——`getNotifyPrefsRow(userLabel)`/`upsertNotifyPrefs(userLabel, patch)`（`server/routes/autospin.ts`）。判斷邏輯：一個 session 是哪個帳號派工的（`AgentSession.userLabel`），發通知/報告時就查那個帳號自己的設定，不是查全域設定；前端所有相關 fetch 都要帶 `x-user-label` header（`DiscordNotifySettingsPage.tsx` 用 `loadGlobalAccount()?.label`）。**Webhook URL、標題模板、頁尾文字仍是全域共用**（存在 `settings` 表，全員同一個頻道/同一套品牌文字）。**相容 fallback**：帳號還沒存過自己的偏好時（`autospin_notify_prefs` 沒有該 `userLabel` 的資料列），getter 會 fallback 讀舊版全域 `settings` 值（`discord_notify_enabled`/`discord_notify_fields`/`autospin_status_report_*`），避免改版當下所有帳號的通知/報告設定突然被重置成程式內建預設值——這些舊的全域 key 仍保留在 DB 裡當作「尚未個人化帳號」的預設值來源，不會主動清除。

#### 使用者操作
| 操作 | 說明 |
|------|------|
| 設定 Webhook URL | 貼上 Discord Webhook 網址並儲存（存在 `settings` 表 `discord_webhook_url`，**全員共用**）|
| 啟用/暫停通知開關 | 關閉後即使 URL 有設定也不會發送，不用清空網址（**依帳號分開**，存在 `autospin_notify_prefs.notifyEnabled`）|
| 發送測試訊息 | 立即送一則測試 Embed 到目前設定的頻道，確認網址正確（不受啟用開關影響）|
| 自訂顯示欄位 | 勾選要顯示的欄位（Spin數/Game URL/錯誤摘要/截圖連結），狀態欄固定顯示（**依帳號分開**，存在 `autospin_notify_prefs.notifyFields`，JSON）|
| 自訂標題模板 | 訊息標題可用 `{machineType}` 佔位符自訂文字，例如加公司代號（存在 `settings` 表 `discord_notify_title_template`，**全員共用**）|
| 自訂頁尾文字 | 選填，顯示在卡片底部時間戳前（存在 `settings` 表 `discord_notify_footer`，**全員共用**）|
| 查看狀態生命週期 | 頁面上顯示 5 種狀態（排隊中/執行中/已完成/失敗/已停止）與同一則訊息更新的說明 |
| 查看訊息預覽 | 即時同步目前欄位/標題/頁尾設定的卡片樣式預覽 |
| 設定定時彙總報告 | 啟用開關 + 間隔（分鐘，預設 20）+ 顯示欄位勾選（errcode/RECOVER/kickout/CR checks/Spin 數/中獎數/總贏分）+ 自訂欄位（選填備註文字，原樣附加在每則報告最下方），**依帳號分開**，存在 `autospin_notify_prefs`（`reportEnabled`/`reportIntervalMin`/`reportFields`/`reportCustomNote`），與上面的即時彙報通知獨立開關、共用同一組 Webhook URL |
| 試發送定時彙總報告 | 「🧪 試發送」按鈕（`POST /api/autospin/status-report-test`）用假資料立即組一則報告送到 Discord，方便確認格式/效果，不受啟用開關影響、不會動到真實累計統計；一併示範 AI 分析區塊（跟隨目前帳號的 AI 開關，關閉不燒 token）+ tag（用目前登入操作者當發起人測試對照表） |
| 啟用 AI 分析區塊 | 定時彙總報告卡片內的獨立開關，**依帳號分開**，預設關閉；開啟才會呼叫 Gemini 判斷是否異常，關閉時零額外開銷（存在 `autospin_notify_prefs.reportAiEnabled`）|
| 設定帳號 Discord Tag 對照表 | Discord 通知設定頁「帳號 → Discord Tag 對照表」卡片，維護「帳號名稱 → Discord User ID」清單，AutoSpin 通知（即時彙報 + 定時彙總報告）依 session 是哪個帳號派工啟動的查表，找得到就在訊息開頭 @ 那個人；存在 `settings` 表 `autospin_discord_user_map`（JSON 陣列，這個本來就是每個帳號各自一條，維持不變），對應 `GET/POST /api/autospin/discord-user-map` |

---

## 8. OSM Tools — URL 帳號池（UrlPoolPage）

**路由**：`/api/url-pool/*`

### 功能說明
管理多個帳號的大廳 URL，自動分配給測試任務使用，避免帳號衝突。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看帳號池狀態 | 顯示各帳號目前使用狀態（空閒/佔用）|
| Claim / Release URL | 手動佔用或釋放帳號 |
| 設定覆蓋值 | 暫時覆蓋某帳號的 URL |
| 直接跳轉 | 以指定帳號跳轉到對應大廳 URL |
| 監聽狀態變更 | SSE 即時通知帳號池狀態變更 |

---

## 9. OSM Tools — Jackpot 監控（JackpotPage）

**路由**：`/api/osm/jackpot*`

### 功能說明
背景每 15 秒拉取各遊戲的獎池金額（Grand/Major/Minor/Mini/Fortunate），偵測異常時推送 Lark 告警。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看獎池金額 | 顯示所有遊戲的即時獎池數值 |
| 設定 Channel ID | 指定要監控的渠道 |
| 設定閾值 | 每遊戲每獎池等級設定 min/max 合理範圍 |
| 設定告警開關 | 各等級異常是否推 Lark 告警（可獨立關閉）|
| 手動觸發告警 | 立即對目前數值進行閾值檢查 |

---

## 10. 操作歷史紀錄（HistoryPage）

**路由**：`GET /api/history`

### 功能說明
記錄所有使用者在工具中執行的重要操作，可依功能模組和時間篩選查詢。

### 記錄的操作（feature key → 觸發來源）
| Feature Key | 觸發來源 |
|-------------|---------|
| `jira` | Jira 批次開單 |
| `jira-comment` | Jira 批次評論 |
| `jira-edit` | Jira 批量修改欄位 |
| `testcase` | TestCase 生成（Lark / PDF / Google Docs）|
| `imagerecon` | ImageRecon 週報解析 |
| `osm-components` | OSM 元件版本同步 |
| `luckylink-components` | LuckyLink 元件版本同步 |
| `toppath-components` | Toppath 元件版本同步 |
| `osm-sync` | OSM 全渠道同步 |
| `osm-alert` | 版本告警（手動 / 排程）|
| `osm-config-compare` | Config 比對 |
| `meter-reconcile` | Performance Meter 對帳查詢 |
| `egm-daycount` | Egm DayCount 對帳查詢 |
| `machine-test` | 機台自動化測試結果 / 設定檔儲存 |
| `autospin` | AutoSpin session 結束 |
| `gs-stats` | Game Show 500x 機率統計 |
| `gs-imgcompare` | Game Show 圖片比對 |
| `gs-logchecker` | Game Show Log 攔截 |
| `weekly-report` | 週報彙整送出 |

### 使用者操作
| 操作 | 說明 |
|------|------|
| 依功能篩選 | 選擇特定 feature key 的紀錄 |
| 依天數篩選 | 7 / 14 / 30 / 90 天 |
| 展開詳情 | 查看完整的 detail JSON |
| 下載 JSON | 下載單筆紀錄的 detail 資料 |

---

## 11. Game Show — PDF TestCase 生成（GsPdfTestCasePage）

**路由**：`/api/gs/pdf-testcase`｜**歷史紀錄 feature key**：`gs-stats`（統計）

### 使用者操作
| 操作 | 說明 |
|------|------|
| 上傳 PDF | 選擇規格書 PDF 檔案 |
| 生成 TestCase | 送 Gemini 分析，輸出結構化 TestCase |
| 下載結果 | 下載 JSON / CSV 格式 |

---

## 12. Game Show — 圖片比對（GsImgComparePage）

**路由**：`/api/gs/img-compare/*`｜**歷史紀錄 feature key**：`gs-imgcompare`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 建立比對 session | 上傳兩組截圖（before/after）|
| 執行比對 | AI 分析差異，標注不同區域 |
| 查看結果 | 並排顯示差異圖片 |

---

## 13. Game Show — 500x 機率統計（GsStatsPage）

**路由**：`/api/gs/stats/*`｜**歷史紀錄 feature key**：`gs-stats`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 啟動統計 | 指定遊戲 URL 與樣本數，背景跑 500x 機率統計 |
| 查看進度 | 即時顯示已執行次數與目前統計結果 |
| 停止統計 | 中止當前統計 session |

---

## 14. Game Show — Log 攔截工具（GsLogCheckerPage）

**路由**：`/api/gs/log-checker-script`｜**歷史紀錄 feature key**：`gs-logchecker`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 下載攔截腳本 | 取得瀏覽器注入用的 log 攔截 JS |
| 分析 Log | 貼入擷取的 log，AI 分析異常 |

---

## 15. AI 模型和 Prompt 設定（全域）

**路由**：`/api/gemini/*`、`/api/openai/key`、`/api/models/available`

### 功能說明
管理 Gemini / OpenAI API Keys 及 Prompt 模板，供所有功能模組共用。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 新增 Gemini Key | 輸入 label + API Key，儲存至 DB |
| 刪除 Gemini Key | 從 DB 移除指定 Key |
| 查看 Key 狀態 | 顯示各 Key 最後使用時間與狀態 |
| 設定 OpenAI Key | 設定 OpenAI API Key（儲存至 DB）|
| 管理 Prompt 模板 | 新增/編輯/刪除各功能用的 Prompt 文字 |
| 探測 Key 可用性 | 即時測試指定 Key 是否可正常呼叫 |

---

## 16. AI Agent 後台監控（全域）

**路由**：`GET /api/ai-agent/monitor`

### 功能說明
偵測目前在線的 AI Agent（AutoSpin / Machine Test 分散式 Agent），顯示連線狀態與最後活動時間。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看在線 Agent | 顯示所有已連線 Agent 的 ID、類型、最後心跳時間 |
| 查看 Agent 歷史 | 每個 Agent 的操作歷史紀錄 |

---

## 17. OSM Tools — UI 解析度截圖（UiScreenshotPage）

**路由**：`/api/ui-screenshot/*`

### 功能說明
從 Lark Wiki 讀取 gmid 清單，使用 Local Agent（Playwright）對 H5 遊戲進行多解析度批量截圖，結果可回寫至 Lark Wiki TABLE。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 設定 Lark Wiki URL | 指定含 gmid 清單的 Wiki 文件 URL |
| 設定遊戲 URL Template | 填入含 `{gmid}` 佔位符的遊戲 URL |
| 選擇解析度 | 11 種 H5 解析度：Mobile Portrait / Landscape / Tablet，可分組全選 |
| 設定選項 | 自動關閉面額彈窗、等待推流就緒、Headed 模式、並發數 |
| 選擇 Agent | 從已連線的 Local Agent 中選擇執行裝置 |
| 開始截圖 | Agent 以 Playwright 批量執行，SSE 即時回報任務進度 |
| 停止 | 中止當前 Run，未執行任務標為 skipped |
| 查看截圖熱圖 | gmid × 解析度 Grid，截圖縮圖即時顯示，點擊放大預覽 |
| 查看清單模式 | 以表格呈現每個任務的狀態與錯誤訊息 |
| 回寫至 Lark Wiki | 將截圖結果回寫為 Wiki TABLE（每欄一種解析度）|

---

## 18. OSM Tools — Performance Meter 對帳（MeterReconcilePage）

**路由**：`/api/osm/meter-reconcile/*`｜**歷史紀錄 feature key**：`meter-reconcile`

### 功能說明
比對 OSM／GCP EGM Metering（egmPerformanceMeter）的 Coin Out，與 Game Record（gameRecordList）+ Jackpot Abnormality（getHandPayRecord）加總算出的預期值是否完全一致。一次性手動查詢（機台名稱 + OSM/GCP 來源 + 日期 + 查詢範圍），不排程、不巡檢多台。

**查詢範圍是「整天」二選一，不是選小時**（v3.68.0 起）：`dayBoundary` 為 `'gaming'`（Gaming Day，本地 06:00 ~ 隔天 06:00，預設）或 `'calendar'`（自然日，00:00 ~ 24:00），比照 OSM/GCP 後台自己的 EGM Hourly Meter 頁面（Gaming Day 打勾 + Date Type 單選 06:00-06:00／00:00-00:00）。**先前版本有「查詢小時」輸入**，讓使用者以為 Coin Out 比對能精準到某個小時——這是誤導：Game Record／Jackpot 這兩支 API 的 `dateTime[]` 篩選只看日期部分，時分秒會被忽略（已用 Dragons-NCH23 2026-07-27 18:00 真實案例驗證：改傳含時分秒的 ISO UTC 字串結果跟整天查詢完全一樣），所以這兩者永遠只能整天加總，讓 meter 側去配合選某個小時、卻要跟整天的 Game Record 比對，兩邊範圍必然對不齊，產生看起來像「算錯」的落差（實際案例：18:00 bucket 算出 12,748,350，但整天 Game Record 是 12,755,414，因為後者涵蓋到隔天 05:59:59）。v3.68.0 拿掉「查詢小時」，Coin Out 比對永遠用查詢範圍內的最後一個 bucket，才能保證跟 Game Record 的整天加總正確對齊。

**公式**：
- OSM：預期 Coin Out = Game Record 總 Win ＋ Attendant Paid JP − Jackpot Wins
- GCP：預期 Coin Out = Game Record 總 Win（GCP 的 Game Record 本身就含 Jackpot Wins + Attendant Paid JP，不用另外加減；目前只有 jackpotWins=0 的 GCP 案例驗證過，尚未遇到非 0 案例）
- 判定門檻：完全一致（誤差 < 0.005）才算 PASS
- **核心概念**：後台自己的 `TotalCoinOut = Jackpot Wins + Coin Out` 這個恆等式一定成立；而 Jackpot Wins 有沒有被同一筆 Game Record 的 Payout 吃掉，取決於該次中獎走哪個派彩管道——沒被吃掉的部分一定會走 Attendant Paid JP（getHandPayRecord），兩者互補、恆等式 `Game Record 總 Win + Attendant Paid JP = Jackpot Wins + Coin Out` 一定成立，移項就是上面 OSM 的公式。
- 已用三個真實案例驗證：Rising Rockets Emperor-141（2026-07-22，Jackpot Wins=0，公式退化成單純比對）、Triple Treasure Pot(4321aruze)（2026-07-27，Jackpot Wins=75,685 全部走 Attendant Paid JP，Payout 完全不含）、DFDC3 88 Fortunes（2026-07-28，Jackpot Wins=5,000 全部併入同一筆 Game Record 的 Payout，Attendant Paid JP=0）——三種情境皆 pass=true, delta=0。此工具仍屬「雛形」階段，公式在同一天內已經來回修正三次（見下方修正歷程），之後遇到新的不一致案例，優先懷疑公式本身還有沒覆蓋到的情境，而不是機台真的有問題。
- **公式修正歷程**（同一天內三次修正，記錄下來避免之後又走回頭路）：① 最原始版本會扣 Jackpot Wins + Attendant Paid JP，Triple Treasure Pot 算出離譜負數，一度以為「不該扣任何東西」；② 改成不扣任何東西後，DFDC3（Jackpot Wins 併入同一筆 Payout）又算錯，因為 Payout 本身已經含 Jackpot Wins；③ 最終發現關鍵是 Jackpot Wins 有沒有被同一筆 Game Record 吃掉，改成上面的「+ Attendant Paid JP − Jackpot Wins」公式，兩個相反案例才同時驗證通過。

**EGM Performance Meter 欄位語意**（已用 EGM Hourly Meter 差值反算 + 使用者提供公式驗證）：`2`=RTP（小數，**僅 daily 回應有效，hourly 回應這個 index 被挪用成 Unix timestamp**）、`5`=Games Played、`6`=Coin In、`10`=Coin Out、`26`=WIN/LOSE（=6−10−29，**hourly 回應完全沒有這個欄位**）、`29`=Jackpot Wins。所以 WIN/LOSE、RTP 一律在後端用 6/10/29 現算，不直接讀 daily/hourly 的欄位 2/26。欄位 `3`/`4`（及鏡射的 `13`/`14`/`15`/`16`）疑似硬體 meter 累計值；欄位 `24`/`28` 語意仍未確認。

**⚠️ Coin In/Coin Out/Jackpot Wins/Games Played 都是「累計值（自上次清帳 reset 起算，不是自當日 00:00 起算）」**，不是「當日」數字——同一機台若很久沒被 reset，數字會是好幾天/幾週的總和，直接拿來跟 Game Record 的當日加總比對會差好幾個數量級。已用真實資料驗證：**(查詢範圍內最後一個 bucket − 第一個 bucket) 的差值** 才會等於整天 Game Record 加總；若差值為負（代表當天發生過 reset），退回用最後一個 bucket 的原始累計值 best-effort（`meterDelta()` 函式）。

**Jackpot Abnormality（getHandPayRecord）語意（已由使用者確認）**：`Attendant Paid JP Meter`（OSM 後台報表欄位，機台實際硬體 meter 記錄）與 `getHandPayRecord` 的 `handpay`（本工具的 Jackpot Abnormality，QA 測試用人工派彩紀錄，不會真的寫進機台 meter）是不同東西，Triple Treasure Pot 那筆數字相等（都是 75,685）純屬個案巧合。**但公式上兩者現在是同一個角色**：`attendantPaidJp`（`getHandPayRecord` 的 handpay 加總）代表「沒有被同一筆 Game Record 的 Payout 吃掉的 Jackpot Wins」，會加回公式裡（見上方公式），不是巧合而是必要項目。另外這支 API 有個實測到的怪癖：**帶了 `clientMachineName` 篩選後，`dateTime[]` 日期範圍篩選會完全失效**（回傳的是該機台最近 N 筆 handpay，可能橫跨好幾個月），所以固定抓回後在後端用 `payoutTime` 字串跟查詢時間窗二次過濾，取真正範圍內的資料。

**`gameRecordList` / `getHandPayRecord` 的 `dateTime[]` 上界是「不含」**（exclusive）：要傳「查詢範圍結束時間點」本身當上界（例如 Gaming Day 邊界就傳隔天 06:00 的 ISO UTC），不能傳同一個時間點兩次，否則會查到 0 筆。EGM Performance Meter / EGM Hourly Meter 則沒有這個問題。

**⚠️ 更正（2026-07-29）：`dateTime[]` 其實真的支援秒級時間窗，先前「篩選只看日期部分、時分秒被忽略」的結論是錯的**——原本的「雙重驗證」測的是格式差異（空白分隔字串 vs ISO UTC），兩次都剛好整天範圍沒有真正縮小，並不是真正測試「narrow 到部分時段」，所以誤判成「時分秒被忽略」。已用 Cartin Gold-2002NCH（2026-07-29，GCP）真實案例重新驗證：直接呼叫 `gameRecordList` 帶入 `["2026-07-29T07:00:00.000Z","2026-07-29T08:17:01.000Z"]`（= 本地 15:00~16:17:01）只回傳 20 筆、總 Win 809.00，跟同一天整天查詢（30 筆、總 Win 1,209.00）明顯不同，且 809.00 恰好等於當時 EGM Meter Coin Out 讀數——證實 API 本身就能做到分秒級篩選。

因此新增「自訂起始時間」（選填，`customStartTime`，格式 HH:mm）：只 override Game Record／Jackpot Abnormality 這兩支查詢的起始時間（`windowStartIso`/`windowStartLocal`），EGM Hourly Meter 那邊的整天邊界不受影響（`meterDelta()` 的 reset 自動偵測已經會處理，不需要跟著調整）。用途：機台當天實際發生過 meter reset，若只查整天會把 reset 前的紀錄也算進 Game Record 加總、跟 meter 對不上，這時手動輸入實際 reset 時間即可對齊。

**OSM/GCP 的 gaming day 是本地時間 06:00 到隔天 05:59:59，不是自然日 00:00~24:00**（已用真實 hourly bucket 資料驗證：每個 gaming day 第一筆固定是 06:00:00；也已用後台 EGM Hourly Meter 頁面截圖確認有「Gaming Day」勾選框 + 「06:00:00-06:00:00／00:00:00-00:00:00」Date Type 單選）。`egmMeterHourList` 請求帶 `gameDay`/`dateType` 參數控制這個邊界（`gameDay='1'` + `dateType='0'` = Gaming Day 06:00 邊界，`gameDay='0'` + `dateType='1'` = 自然日 00:00 邊界）。**選 Gaming Day 邊界時，bucket 比對邏輯要接受跨日**：查詢日期 `date` 當天 06:00 之後的 bucket，加上隔天日期、但小時 < 6 的 bucket（例如隔天 05:59:59 仍屬於今天開始的 gaming day），只比對 `rowDate === date` 會漏掉這些跨日的尾端 bucket。

**dateTime[] 真正格式是 ISO UTC**（已用後台 Game Record 頁面的 DevTools Network 截圖反推驗證）：例如 `2026-07-26T22:00:00.000Z`，不是單純日期字串或空白分隔的 `"YYYY-MM-DD HH:mm:ss"`。使用者操作介面的時區固定是 UTC+8（本地 06:00 = UTC 前一天 22:00）。`toUtcIso(dateStr, hh, mm, ss)` 函式負責這個轉換。

OSM／GCP 是兩個不同後台（OSM 用 CP 後台 `qat-cp.osmslot.org`，GCP 用 NC 後台 `qat-nc.osmslot.org`，channelId 不同），憑證分開存在 `meter_reconcile_config` 表（key 前綴 `osm_`/`gcp_`），登入 token 過期時自動重新登入一次再重試。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查詢對帳 | 輸入機台名稱 + 選擇 OSM/GCP 來源 + 日期 + 查詢範圍（Gaming Day／自然日），一鍵拉三邊資料比對 |
| 自訂起始時間（選填） | 機台當天有 meter reset 時，手動輸入實際 reset 時間（HH:mm），只 narrow Game Record／Jackpot Abnormality 這兩支查詢的起點，EGM Hourly Meter 不受影響 |
| 查看判定結果 | 頂部橫幅直接顯示一致／不一致 + 差值 |
| 查看公式攤開 | 顯示算式各項數字來源，方便肉眼核對 |
| 查看三邊明細 | EGM Hourly Meter 差異值（Coin In/Out/Jackpot/RTP/WIN-LOSE，卡片標題刻意不叫「EGM Performance Meter」——EGM Performance Meter 那支日報表通常要等到約 15:15 才有當日數據，這裡顯示的是用 EGM Hourly Meter 差值算出來、可拿來即時對照的版本）、Game Record 加總（含 Bet Reward Credits／泥碼下注額，取自 `gameRecordList` sumData 的 `bet_nima` 欄位）、Jackpot Abnormality 明細列表並排顯示 |
| 查看原始欄位除錯表 | 展開查看該筆查詢的所有原始欄位，已驗證欄位標綠色 |
| 設定 OSM/GCP 後台連線 | Base URL / Origin / Channel ID / 登入帳密，分開設定兩組，可測試登入 |

---

## 19. OSM Tools — Egm DayCount 對帳（EgmDayCountPage）

**路由**：`POST /api/osm/meter-reconcile/egm-daycount`（目前只支援 OSM，沒有 GCP 對應版本）｜**歷史紀錄 feature key**：`egm-daycount`

### 功能說明
比對後台 `Egm DayCount`（`/egm/reports/gameCount`，一天一列彙總報表）與 `User Detail`（`/egm/reports/playerMachineCount`，player+machine 逐筆列）算出的值是否一致，Jackpot Amount 另外對照 `Jackpot Record`（`/egm/reports/jackpotRecordList`，逐筆中獎紀錄）。原本是 Performance Meter 對帳頁面內的第二個分頁，後來拆成獨立頁面。三支 API 皆已用真實 Network request 截圖確認（`backendservertest.osmslot.org`，跟 `meter_reconcile_config` 裡存的 OSM 帳密同一組，共用同一組後台設定，沒有自己的設定 UI）。

**欄位對應**（已用真實查詢驗證全部吻合，`allPass: true`）：
| 顯示欄位 | gameCount（Egm DayCount）| 對照來源 |
|---|---|---|
| Total Bet User | `betUsers` | playerMachineCount：逐筆列裡 `betTimes > 0` 的不重複 `playerId` 數（沒有現成的不重複計數欄位，自己從 items 算）|
| Total Bet Number | `betTimes` | playerMachineCount：`sumData.betTimes` |
| Total Bet Amount | `bet` | playerMachineCount：`sumData.bet` |
| Total Online Transfer In/Out Amount | `machineIn`/`machineOut` | playerMachineCount：`sumData.machineIn`/`machineOut` |
| Total Win Or Lose Amount | `platformWin` | playerMachineCount：`sumData.platformWin` |
| Total Win Lose Ratio | `platformWinPercent` | playerMachineCount：`sumData.platformWinPercent` |
| Jackpot Amount | `jackpotamount` | **jackpotRecordList**：`sumData.jackpotamount`（不是 playerMachineCount，那支沒有這個欄位）|

**`jackpotRecordList` 跟前兩支 API 的參數風格不一樣**（已用真實 Network request 截圖確認）：`dateTimeType=1`（不是 0），`dateTime[]` 是空白分隔的本地時間字串（例如 `"2026-07-28 00:00:00"`），不是 ISO UTC；其餘 `playerstudioid`/`channelId`/`isall` 參數規則跟前兩支一致。回應欄位是 `jackpotamount`（小寫，跟 `gameCount` 同一個命名慣例）、`userid`、`username`、`clientMachineName`、`payoutTime`。

**「有下注的帳號」彙整清單**：同一個 UserId 會在多台機台各出現一列 `playerMachineCount` 的紀錄，肉眼從逐筆明細裡自己抓「有下注的帳號」很麻煩，後端額外算了一份按 `playerId` 彙整（跨機台加總 Bet Number/Bet），前端顯示成獨立的表格區塊，不用使用者自己從 24 筆明細裡挑。

**⚠️ `gameCount` 的 `sumData` 跟 `items[]` 範圍不一致**（已用真實查詢驗證：查單一天 `total=1`，但 `sumData` 的數字是 `items[0]` 的好幾倍，`sumData` 看起來沒有正確套用日期篩選）——**只查單一天時要用 `items[0]`，不要用 `sumData`**；`playerMachineCount` 的 `sumData` 沒有這個問題，可以直接信任。

**`playerstudioid` 參數**：固定用 `cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL` 這組清單（已驗證精準對上後台「Player Channel: np +11」那個預設範圍），`channelId` 平常固定 `873`。**「All」全渠道模式**：已用真實 Network request 截圖確認正確做法是 `channelId=0` + `isall=true`（`playerstudioid` 參數維持不變，不是拿掉）——之前誤以為拿掉 `playerstudioid` 可以模擬「不篩選」，結果 API 直接回空資料，是錯的；現在前端有「All」勾選框，會同時切換 `channelId`/`isall` 兩個參數。

**Game Type 篩選**：下拉選單資料來自 `GET /public/gameNameAlias?channelId=873`（公開端點，不需要登入 token，`server/routes/meter-reconcile.ts` 的 `/api/osm/meter-reconcile/game-types` 直接代理），回應 `{ name, gameTag, id }[]`；查詢時傳的是 `name`（小寫，例如 `risingrockets`），下拉選項顯示的是 `gameTag`（例如 `RISINGROCKETS`）。三支報表 API 都吃同一個 `gameType` 參數。

**已知限制**：三張報表不是同一次登入 session 依序拉的，若查詢時有機台正在被 AutoSpin 持續 Spin，API 呼叫之間的時間差可能導致數字有微小落差，不代表算錯。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查詢對帳 | 輸入日期 + 查詢範圍（Gaming Day／自然日）+ Game Type 篩選 + All（全渠道）勾選，一鍵拉三支報表比對 |
| 查看判定結果 | 頂部橫幅顯示幾個欄位一致，逐欄位表格標示 ✓/✗ 與差值（含 Jackpot Amount）|
| 查看有下注的帳號 | 按 UserId 彙整（跨機台加總），不用自己從逐筆明細裡挑 |
| 查看 User Detail 逐筆明細 | 可展開查看每一筆 player+machine 紀錄，標示哪些被排除在 Total Bet User 計數外 |

---

## 20. 帳號境界稱號（design/xianxia 分支）

### 功能說明
側邊欄帳號區塊顯示一個小稱號徽章，依帳號**累計登入天數**自動晉升，靈感取自《凡人修仙傳》的修煉境界（練氣期→築基期→金丹期→元嬰期→化神期→煉虛期→合體期→大乘期→渡劫期，共 9 階，門檻單位為天，可調整）。純展示用途，不影響任何權限判斷。

**計數來源**：`server/shared.ts` 的 `recordLoginDay()` 對 `account_cultivation` 表做 upsert，同一天內重複呼叫只算一天，累計的是「有活躍過的不同日曆天數」，不是登入次數或操作次數（`operation_history` 本身每 7 天會被自動清空，不適合拿來算長期累計）。**掛在 `server/index.ts` 的全站共用 middleware**（`getAuthAccount(req)` 判斷有登入就呼叫），不是只掛在 `/api/auth/login`——原本只掛登入端點時，登入 session cookie 有效期 7 天，這期間內重新整理/重開瀏覽器都不會再打登入 API（cookie 還有效不需要重新輸入帳密），導致「有在用但沒重新登入」的天數完全沒被算到；改成任何一支已登入的 API 請求（含 heartbeat）都算，才是「今天真的有在用」的正確訊號。`GET /api/account/cultivation` 回傳目前境界、累計登入天數、下一階名稱與門檻。

**排行榜（群英榜）**：獨立頁面（`GroupId`/`page key` = `cultivation-board`，側邊欄「宗門維運」分區），`GET /api/account/cultivation/leaderboard` 回傳所有未停用帳號依累計登入天數排序的清單（不含 token），目前登入的帳號那一列會高亮（`.cultivation-row--me`）。跟其他「系統」分區頁面一樣走 `ALL_PAGE_KEYS`/`SystemAdminPage` 權限表控管可見性。

**管理員手動調整境界**（`server/routes/permissions.ts`）：`SystemAdminPage.tsx` 帳號列表每列新增「調整境界」按鈕，開啟小視窗可直接輸入累計登入天數，或用下拉選單快速帶入某境界對應的門檻天數。實作上直接改 `account_cultivation.active_days`（`setCultivationDays()`），不是額外的覆寫欄位——調整後帳號正常登入仍會從這個新天數繼續往上累計，跟自動累計共用同一個計數器。`PUT /api/admin/accounts/:email/cultivation`（`requireAdmin` 保護）、`GET .../cultivation` 讀目前境界、`GET /api/admin/cultivation-levels` 給前端下拉選單用的境界門檻清單。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看目前境界 | 側邊欄帳號名稱下方的小徽章，滑鼠移上去顯示累計登入天數與距離下一階還差幾天 |
| 查看群英榜排行 | 獨立頁面，列出所有帳號依境界/登入天數排名，自己的那一列會高亮 |
| 管理員調整境界 | 系統管理頁帳號列表「調整境界」按鈕，可直接輸入天數或用下拉選單快速帶入境界門檻 |

---

## 21. 普通版／修仙版切換（design/xianxia 分支）

### 功能說明
側邊欄底部「版面模式」開關，可在「普通版」（原本 main 分支的樣子）與「修仙版」（太玄道樞整套視覺）之間即時切換，選擇存在 `localStorage`（`toppath-theme-mode`），下次開啟沿用。

**實作方式**：`xianxia-complete.css`（全站修仙視覺層）不再用 `import` 靜態打包進主 CSS（那樣永遠會生效、無法整份關掉），改放在 `public/xianxia-complete.css`，由 `App.tsx` 在切到「修仙版」時動態插入 `<link rel="stylesheet">`，切回「普通版」時整個移除。

**普通版下會整個隱藏的修仙限定內容**：側邊欄雙標籤（只顯示原功能名一行）、境界稱號徽章、群英榜排行榜（連帶側邊欄的入口按鈕）、每日仙語小卡片與其管理頁（連帶側邊欄的入口按鈕）、背景境界（玄月／赤霄）切換、側邊欄品牌名稱（改回「Toppath Tools」）。這些判斷都以 `themeMode === 'xianxia'` 為準，不是靠 CSS 藏起來（CSS 沒載入時這些元素本來就不會被畫出正確樣子，所以直接不渲染）。

**已知限制**：目前只做了「全站共用外殼」（側邊欄、頂欄、境界稱號/排行榜）的切換；個別頁面內部如果有更深層的修仙化改動（例如 Dashboard 的 Hero 橫幅結構），普通版下 xianxia CSS 關閉後會變成無樣式的原始 HTML 排版，不是逐一還原成「main 分支當初那個版本」的樣子——真的要每個頁面都精準復原，工作量接近整個重做一次，目前先以「視覺上乾淨、可用」為標準，非逐頁像素級還原。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 切換版面模式 | 側邊欄底部「版面模式」按鈕組，選普通版或修仙版，選擇會記住 |

---

## 22. 每日仙語（design/xianxia 分支）

**路由**：`GET /api/xianxia/quote-of-day`、`GET/POST /api/xianxia/quotes`、`PUT/DELETE /api/xianxia/quotes/:id`、`POST /api/xianxia/quotes/ai-suggest`

### 功能說明
Dashboard（修仙版）Hero 橫幅下方顯示一張每日語錄小卡片，語錄來源為《凡人修仙傳》《仙逆》《斗破蒼穹》《誅仙》等知名國漫/仙俠小說的經典台詞。只在修仙版顯示，普通版整個隱藏（含側邊欄管理頁入口）。

**語錄庫存在 `xianxia_quotes` 表**（`id`/`text`/`source`/`created_at`/`last_used_cycle`），初始批次語錄透過 `server/xianxia-quotes-seed.json`（`INSERT OR IGNORE`，不覆蓋已編輯過的資料）在啟動時補齊，比對 `config-templates.json`/`machine-profiles.json` 既有的種子檔案載入慣例——**這批初始語錄是先用 WebSearch 查證多個獨立語錄整理網站交叉確認過的，不是純憑印象生成**，但仍建議使用者自己覆核一輪，用字/斷句可能因原著版本或轉載差異而有出入。

**每日抽選演算法（不重複循環制）**：`getDailyQuote()`（`server/routes/xianxia-quotes.ts`）——同一天內（Asia/Taipei 時區）所有人看到的都是同一則（存在 `settings` 表 `xianxia_daily_quote`，含 `date`/`quoteId`/`cycle`），隔天才會重新抽。抽選規則是「這一輪（`cycle`）還沒抽過的語錄裡隨機挑一則」，該則的 `last_used_cycle` 更新為目前 `cycle`；當整輪語錄都抽完（沒有 `last_used_cycle < cycle` 的候選）才會把 `cycle` +1、重新開始新一輪。語錄庫可以隨時新增，新加入的語錄 `last_used_cycle` 預設 0，會立刻被目前這輪視為「還沒抽過」，不用等下一輪才會出現。

**AI 建議只回傳草稿，不會自動寫入語錄庫**：`POST /api/xianxia/quotes/ai-suggest` 呼叫 `callGeminiWithRotation()` 請 Gemini 列出候選語錄，prompt 明確要求「不確定就不要列，寧可少列也不要列錯」，但 AI 仍可能編造不存在的句子或講錯出處，管理頁上每則候選都要人工按「加入語錄庫」才會真的存入（等同於再過一次 `POST /api/xianxia/quotes`），不會自動信任 AI 產出。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看每日語錄 | Dashboard（修仙版）Hero 橫幅下方自動顯示，每天固定一則 |
| 管理語錄庫 | 「每日仙語管理」頁（系統分區）手動新增/編輯/刪除語錄，可查看每則目前用到第幾輪 |
| AI 建議候選語錄 | 管理頁「AI 建議」按鈕，Gemini 生成候選草稿，需人工確認出處後才按「加入語錄庫」存入 |

---

## 23. 週報彙整（WeeklyReportPage）

**路由**：`POST /api/weekly-report/parse`、`POST /api/weekly-report/submit`｜**歷史紀錄 feature key**：`weekly-report`

### 功能說明
獨立工具（2026-08-11 新增，**不掛在 OSM Tools 底下**，跟 Jira/TestCase 生成同一層級），讓成員快速把本週工作內容寫進團隊共用的 Lark Base 週報表。每週該表是全新一張（不是同一張表累積、沒有日期/週次欄位），所以工具不寫死表格 ID，改成使用者每次貼上「本週 Lark Base 網址」，動態讀取該表的欄位選項。

**Lark Base 表格式**（已用真實表驗證，`FEyTb3Y7Ua6ntgsXt0nlKg5yg8e`/`tblBIv21zkPymWCO`）：只有 4 個欄位——`No`（自動編號）、`专案`（單選，~60-70 個專案代碼如 `P7-005-OSM`）、`成员`（單選，~45 個人名）、`补充说明`（純文字）。`parseLarkBaseUrl()`（`server/routes/weekly-report.ts`）解析 `/base/{appToken}?table={tableId}` 格式（跟 `parseLarkSheetUrl()` 解析 `/sheets/`、`/wiki/` 是不同格式，不能共用）。

**一人一週只佔一列，多個項目全部合併進同一個補充說明欄位**（2026-08-11 使用者明確決定）：`专案` 是單選欄位，但實際週報常常一人橫跨多個專案，兩者天生衝突——解法是 `专案` 欄位做成「主要專案，選填」（可留空，不強求反映全部），逐項實際是哪個專案的內容自己在文字裡標籤（例如 `[P7-005-OSM] 修正登入錯誤...`），欄位語意上不保證能完整拿來做跨專案統計，統計要看補充說明文字本身。

**Jira 單與手寫文本混寫在同一段文字**（不強制分模式）：Step 3 補充說明文字框上方有「貼 Jira 單號 → 帶入摘要」小工具，貼上單號（可逗號分隔多個）按下後呼叫既有的 `POST /api/jira/batch-fetch-fields`（跟 JiraPage 批量開單/評論用同一支端點），組成 `[CGMN-26] 修正登入錯誤（Done）` 格式的文字插入textarea——**插入是插在游標位置，不會覆蓋使用者已經打好的內容**（`textareaRef` 讀 `selectionStart`/`selectionEnd`，插入後游標移到插入內容之後），插入後可自由編輯，之後也能繼續手打其他內容混在一起。

**Jira 授權不需要另外選帳號**：本來討論時以為要加一個 Jira 帳號選擇器（`batch-fetch-fields` 需要 `x-jira-email` header），後來確認這個專案的登入帳號本身就是 Jira 帳號（`server/accounts.json` 同一份資料同時是 Toppath Tools 登入清單也是 Jira API token 清單，前端 `sessionStorage` 存的 key 直接叫 `global_jira_account`）——直接用 `loadGlobalAccount()?.email` 當 `x-jira-email` 打 API，不用額外 UI。找不到已登入帳號時「帶入摘要」會直接回錯誤訊息，不會盲目打 API。

**讀取失敗會擋在送出之前，不會等送出才報錯**：`POST /api/weekly-report/parse` 會先檢查回應是否包含 `成员`/`专案`/`补充说明` 三個必要欄位，缺少任一個直接回傳明確錯誤訊息列出缺什麼欄位；Step 2/3 的表單在還沒成功解析表格前是 disabled 狀態（`opacity: .5` + `pointerEvents: none`），不可能在沒讀到欄位選項的狀態下送出。

送出（`POST /api/weekly-report/submit`）直接呼叫 Lark Bitable `records` API **永遠新增一列**，`专案` 欄位允許空值（沒填就不放進 payload，不是送空字串）。成功後寫入 `operation_history`（`addHistory('weekly-report', ...)`），內容含實際送出的成員/專案/文字（截斷 300 字）。

**曾考慮「同成員已有列就 PATCH 附加」，最後刻意放棄改回永遠新增（2026-08-11 討論結論）**：一度做過「送出前查表格裡有沒有同一個成員的既有列，找到就把新內容加一段時間戳分隔線附加到既有補充說明後面，不覆蓋」的版本，但發現這個 read-then-write 模式有兩個真實併發風險：① 同一人短時間內兩次送出（手滑連點、兩個分頁）可能兩次查詢都查到「還沒有」，變成新增兩列而不是預期中的一列變兩次追加；② 查證過 Lark Bitable 的 record update API 沒有 revision/ETag 這類機制能偵測「PATCH 當下這筆資料是否已被別人在 Lark 網頁上手動改過」，沒有這個保護的話就是單純「後寫的贏」，有機會蓋掉別人剛好同時間的手動編輯。永遠新增一列完全不會共用/覆寫任何既有欄位，兩個風險直接消失；代價只是同一人這週送多次會在表上留下多列，判斷是「整理起來麻煩」的小不便，不是「資料被覆蓋」的風險，這筆交易划算。

**普通版／仙俠版**：跟 AutoSpin 三路對帳同一套模式——沿用全站共用的 `--cr-*`/`--xx-*` CSS 變數（不用寫兩份程式碼，切版面模式顏色自動對應），只有文字（標題/步驟說明/按鈕文字）在元件內用 `themeMode === 'xianxia'` 三元判斷切換兩套用詞（例如「送出至 Lark」↔「呈報宗門」、「成員」↔「道號」），沒有额外的裝飾結構差異，符合操作型工具「只換皮不換骨」的既有原則。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 貼上本週 Lark Base 網址 | 每週表格不同，貼上後自動讀取「成员」/「专案」欄位選項；上次用過的網址會記住（`localStorage`），下次開啟預先帶入 |
| 選擇成員（自己） | 必填，下拉選單選項來自剛讀取的表格 |
| 選擇主要專案 | 選填，可留空（內容自己在文字裡標專案） |
| 貼 Jira 單號帶入摘要 | 可一次貼多個（逗號分隔），自動抓摘要/狀態插入文字框游標位置，不覆蓋已打的內容 |
| 填寫本週工作內容 | 自由編輯文字框，可混寫 Jira 帶入的摘要與手寫文字 |
| 送出 | 直接在該 Lark Bitable 新增一列（成員/主要專案/補充說明） |

---

## 版本管理規則

- **Patch (x.x.N)**：bug fix、小調整、文字修正
- **Minor (x.N.0)**：新功能、新步驟、新頁面、流程重構 ← **必須進版，不可用 patch 代替**
- **Major (N.0.0)**：架構重寫、破壞性變更
- 每次功能更動後必須同步更新 `src/version.ts` 的版本號和 CHANGELOG
- 本 CLAUDE.md 的 Product Features 章節也需同步更新
- **任何動到 `server/` 代碼的改動，也需要推進版號**（不限於前端修改）

> **常見錯誤（禁止）**：新增功能卻只遞增 patch（例如從 3.9.x 一路流水號到 3.9.77 都沒進 minor）。
> 判斷標準：只要有「新增功能 / 新頁面 / 新流程 / 新步驟」，一律 minor 進版（x.N.0）。

---

## 新功能同步義務

**每次新增功能後，必須同時完成以下四項同步，不需使用者提醒：**

1. **`CLAUDE.md`** → Product Features 章節新增功能說明 + 操作清單
2. **`server/shared.ts`** → `ALL_PAGE_KEYS` 陣列加入新功能的 page key
3. **`src/pages/SystemAdminPage.tsx`** → `PAGE_META` 加入新功能的顯示名稱（讓權限管理頁面可以控管）
4. **歷史紀錄**（如需要）→ 功能觸發點加上 `insertHistory(db, { feature: 'xxx', ... })`，並在 CLAUDE.md 的 feature key 對照表新增條目

> 判斷標準：只要新功能有「可開關的使用者權限」需求，或有「需要稽核的操作紀錄」，以上四項都要做。
