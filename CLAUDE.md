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

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇帳號 | 從全域帳號選單選擇 Jira 操作者身份 |
| 批次開單（Step 1–5） | 讀取 Lark Bitable → 選專案/Issue Type → 預覽清單（含欄位篩選）→ 確認執行 → 進度追蹤（SSE）|
| Step 3 欄位篩選 | 自動偵測下拉式選單欄位（2–15 個唯一值），可按嚴重度/類別/進度等篩選後再勾選列 |
| Step 3 動態欄位開單 | 載入 Jira 專案實際欄位；摘要/描述/受託人/RD負責人/回報人 為強制必填並自動顯示，未填擋下送出；可從 Lark 自動帶入這些欄位值，其餘選填欄位可手動新增 |
| PM 批次開單 | 從 Lark 讀取 PM 規格，自動建立 Epic + Story |
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition；完成後回填處理階段「已切換狀態」|
| 批量評論（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測 Issue Key 列，不需經過開單流程直接批量加評論 |
| 批量修改（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），選擇 Jira 欄位與 Sheet 欄位對應，批量修改摘要/描述/優先級等欄位 |
| 批量更新狀態（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測含 Jira 單號的列，批量執行 transition |
| 批量修改 — 描述附件 | Step 3 預覽表每列有附件欄：可選 Sheet 圖片欄自動讀取（點「讀取附件」），或 + 手動上傳；送出後圖片以 !filename! wiki markup 嵌入描述，影片以 [^filename] 方式嵌入；有未上傳影片時送出前彈出確認 |
| 重新讀取 Sheet | 批量開單/批量評論/批量修改/批量更新狀態 皆有此按鈕（Step 2 以後、頂部步驟列），操作到一半時可重新拉取最新 Sheet 資料，不切換 step、不清空已勾選/已填寫內容，只同步新增/移除的列 |
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

進入機台流程（entryTouchPoints/entryTouchPoints2 兩階段進入觸屏 + enterGMNtc 確認）與 Spin 點擊/餘額讀取（pinus WebSocket 攔截，非 DOM selector）皆與 `server/machine-test/runner.ts` 同步；`entryTouchPoints`/`entryTouchPoints2`/`spinSelector`/`balanceSelector`/`bonusAction`/`touchPoints`/`clickTake`/`ideckXpaths` 讀取自 `machine_test_profiles` 表（`ideckXpaths` 對應 DB 欄位是 snake_case 的 `ideck_xpaths`），由 `/api/autospin/agent/start` 合併進 configs 回傳給 Python 引擎。**對應 key 不是用 AutoSpin 自己的 `machineType`**（使用者手打、格式不受控，容易對不上）**，而是取 `gameTitleCode` 的中段**（例如 `"873-DFDC-0003"` 取 `"DFDC"`，跟 `machine_test_profiles.machineType` 的命名慣例一致），`gameTitleCode` 格式不對時才 fallback 回 `machineType`（`profileKeyFor()` 函式）。元素比對的是疊在畫面上、看不到的 `<span>` 觸控層文字（不是視覺上看到的按鈕文字），格式為「數字,數字」。Spin 按鈕若被上層元素（選面額面板、宣傳彈窗等）攔截點擊，改用 JS `el.click()` 直接觸發下層按鈕，不用真實滑鼠座標硬點。另有 pinus 訊息監控（攔截 `window.pinus.request`/`.on` 所有 request/response/push，非僅 coin 欄位）與瀏覽器 console.warn/console.error 攔截（WebSocket 斷線、遊戲端原生報錯），每台機每 2 秒批次轉發到執行日誌，前綴分別為 `[pinus:xxx]`/`[console:warn]`/`[console:error]`；所有回報用的網路呼叫（進度回報/截圖上傳/Lark 推播/日誌上傳）皆為背景執行緒非同步，不會卡住主 Spin 迴圈。

**特殊遊戲偵測（OSMWatcher + bonusAction）**：只讀取 Machine Test 現成維護的 `osmMachineStatus` map（`server/routes/machine-test.ts` export，未修改該檔案本身），透過 `/api/autospin/agent/:id/should-stop` 心跳（每 3 秒）把整個狀態 map 一起帶給 Python 引擎快取。行為對齊 Machine Test 的 `checkOsm`/`waitForNormalStatus`：偵測到特殊狀態（FG/JP，status 1/2/3/4/5/8）時執行機種設定檔的 `bonusAction`（spin/takewin/touchscreen/auto_wait，讀自 `machine_test_profiles`，由 `/agent/start` 合併進 configs）一次，之後持續 Spin 直到狀態恢復（或 15 分鐘逾時），恢復後再 10 秒 cooldown spin；status=9（Handpay）只記錄不處理，需人工介入。**相容 fallback**：完全沒有 OSMWatcher 資料時（該機台從未出現在 `osmMachineStatus` 裡），改用連續 10 次 Spin 前後餘額都相同來推測進入特殊遊戲，觸發時執行一次 `bonusAction`（不做等待迴圈，執行完就重置計數繼續正常 Spin）。

**Spin 前後餘額記錄**：`do_spin()` 現在回傳 `(balance_before, balance_after, rejected)`（失敗回傳 `None`），每次有變化或每 10 次 Spin 會記錄一行輸贏差額到執行日誌；目前只寫日誌，未存進 `autospin_history` 資料庫欄位（該表目前只有單一 `balance` 欄位，沒有 before/after 配對欄位）。`rejected` 代表這次 Spin 的 pinus `dealGMActionReq` 請求被遊戲伺服器直接拒絕（例如 errcode:100「請求超時或未確認錯誤」）——這種情況下 spin 動作根本沒在伺服器端執行，按鈕 disabled 切換／coin 更新兩個完成訊號都不會觸發，`do_spin()` 靠監控腳本追蹤 `window.__lastSpinErr`（`dealGMActionReq` 回應 errcode≠0 時寫入）立即中斷等待並記錄真正原因，不會再傻等滿 8 秒被誤標成 `timeout_8s`；main loop 也不會把這種「餘額沒變」計入連續無變化次數，避免誤判成特殊遊戲亂觸發 `bonusAction`。

**選面額遮罩（`.select-main`）攔截 Spin 點擊**：這種遮罩點擊時不會拋例外（跟「上層元素攔截點擊拋 intercepts pointer events」不同），遊戲只是完全收不到 Spin 動作，靠例外處理的 JS 強制點擊 fallback不會被觸發，會固定卡滿 8 秒判定 timeout_8s。`dismiss_denom_overlay(page, mt)` 完整移植自 `machine-test/runner.ts` 的 `dismissDenomOverlay()`：偵測 `.select-main .select-btn, .select-main .my-button`，找到就點第一個選項（JS 強制 click）。`do_spin()` 一開始就會呼叫，不只在剛進場時才處理——Bet Change/Cashout 等操作之後這個遮罩也可能重新彈出蓋住 Spin。

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

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇執行 Agent | 從線上、含 `autospin` capability 的 agent 清單挑一台 |
| 派工啟動 | 命令選定 agent spawn Python 引擎執行 AutoSpin（`/api/autospin/hub-dispatch`）|
| 停止 | 命令 agent 停止並結束 Python 程序（`/api/autospin/hub-stop`）|
| 伺服器端 fallback | 切到「伺服器端」可直接在 server 本機 spawn（舊模式）|
| 暫停 / 繼續 Agent | 暫停自動旋轉，保持連線 |
| 查看即時日誌 / 截圖 | SSE 串流 Agent 執行日誌與遊戲截圖；日誌框固定高度＋內部捲動，支援分類篩選（全部/系統/Spin/截圖/錯誤警告）+ 關鍵字搜尋 + 自動捲到底開關 + 清空；pinus 訊息預設收合，可依 7 類（Spin動作/餘額異動/狀態廣播/進入遊戲/連線登入/心跳列表/其他）分別展開；SSE 斷線（如伺服器重啟）會在 2 秒後自動重連。截圖監控為 2 欄縮圖網格，標示最新一張 |
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
| `jira` | Jira PM 批次開單 |
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
