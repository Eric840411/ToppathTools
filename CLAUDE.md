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
| 批次開單（Step 1–5） | 讀取 Lark Bitable → 選專案/Issue Type → 預覽清單 → 確認執行 → 進度追蹤（SSE）|
| PM 批次開單 | 從 Lark 讀取 PM 規格，自動建立 Epic + Story |
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition |
| 查看成員 / 專案 | 列出帳號可存取的 Jira 成員和專案清單 |

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
管理多個 AutoSpin Python Agent，每個 Agent 對應一台機器執行自動旋轉操作。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 啟動 Agent | 指定機台代碼與設定，啟動 AutoSpin session |
| 停止 / 停止所有 Agent | 手動停止單一或全部 Agent |
| 暫停 / 繼續 Agent | 暫停自動旋轉，保持連線 |
| 查看即時日誌 | SSE 串流 Agent 執行日誌 |
| 查看截圖 | 查看 Agent 捕捉的遊戲截圖 |
| 查看歷史紀錄 | AutoSpin 各 session 的執行紀錄 |
| 設定 Spin 間隔 | 調整每次 Spin 的等待時間 |
| 管理 Bet Config | 設定各機種的下注隨機配置 |
| 管理模板圖片 | 上傳/刪除用於比對的遊戲狀態模板圖 |
| 下載 Agent 安裝包 | 下載 `install.bat` / `launcher.bat` / `agent.py` |
| 對賬功能 | 比對遊戲紀錄與帳戶餘額，生成對賬報告 |

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
| `testcase` | TestCase 生成（Lark / PDF / Google Docs）|
| `imagerecon` | ImageRecon 週報解析 |
| `osm-components` | OSM 元件版本同步 |
| `luckylink-components` | LuckyLink 元件版本同步 |
| `toppath-components` | Toppath 元件版本同步 |
| `osm-sync` | OSM 全渠道同步 |
| `osm-alert` | 版本告警（手動 / 排程）|
| `osm-config-compare` | Config 比對 |
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

## 版本管理規則

- **Patch (x.x.N)**：bug fix、小調整、文字修正
- **Minor (x.N.0)**：新功能、新步驟、新頁面、流程重構 ← **必須進版，不可用 patch 代替**
- **Major (N.0.0)**：架構重寫、破壞性變更
- 每次功能更動後必須同步更新 `src/version.ts` 的版本號和 CHANGELOG
- 本 CLAUDE.md 的 Product Features 章節也需同步更新

> **常見錯誤（禁止）**：新增功能卻只遞增 patch（例如從 3.9.x 一路流水號到 3.9.77 都沒進 minor）。
> 判斷標準：只要有「新增功能 / 新頁面 / 新流程 / 新步驟」，一律 minor 進版（x.N.0）。
