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

# Jira 身分邊界與代理授權（2026-08-20，v4.10.0）

**登入帳號就是 Jira 帳號**——同一張 `jira_accounts` 表，token 存後端，前端只送 `x-jira-email`。先前 `userJiraAuth()`（`server/shared.ts`）**完全信任這個 header**，而 `/api/jira/*` 沒有全域 auth gate，等於任何人只要知道別人的 email、改一個 header，就能用別人的 token 操作 Jira。這不是「還沒開放的功能」，是認證邊界本身錯了。

現在 `userJiraAuth(req, opts)` **預設只允許本人**：直接讀 cookie 對 `auth_sessions` 表判斷「這個請求真正登入的是誰」（不看前端說什麼），跟 header 不符就拒絕並印 `JIRA_IDENTITY_MISMATCH_DENY`。刻意不 import `auth-session.ts` 的 `getAuthAccount()`——那支檔案本身 import 了 `shared.ts`，反向 import 會形成循環相依，而 `shared.ts` 在模組載入當下就要開 DB／建表。

**代理授權**用 `jira_account_delegates` 表（`actor_email`／`target_email`／`scope` + `enabled`／`expires_at`／`revoked_at`，撤銷用狀態欄位不刪資料，才留得下稽核軌跡），判斷集中在 `hasJiraDelegation()` 一支 helper（啟用／未撤銷／未過期／scope 精準匹配），不散到各 route 各判一次。scope 目前兩種，**寫入與讀取刻意分開**：

| scope | 用途 | 目前誰在用 |
|-------|------|-----------|
| `jira.comment.batch` | 代理**寫入**：用別人的身分張貼批量評論 | 規劃中（Phase 2）|
| `jira.read.asOther` | 代理**讀取**：用別人的 token 查資料 | `POST /api/weekly-report/jira-by-range` |

**`weekly-report/jira-by-range` 是既有的跨帳號讀取功能，不是漏洞遺跡**：週報彙整的全自動載入本來就會用 Eric／Lusa／Siara 三個帳號的 email 平行呼叫，各自用各自的 token 撈自己的單（v4.5.0）。身分邊界加嚴時若不標註，這個每週在用的功能會當場壞掉。目前這支傳 `fallbackAllowUnauthorized: true`——查不到授權**仍然放行**，但印出可 grep 的 `JIRA_DELEGATION_FALLBACK_ALLOW`（含 actor／target／scope／route／時間）。**這是過渡狀態**：等從 log 確認實際用到哪些關係、補進授權表後，就要把這個 fallback 關掉。

> 已驗證：無 cookie＋他人 email → 401；本人 → 200；有 cookie 但用他人 email 打 `/api/jira/*` → 401；週報撈單跨帳號 → 放行並印 fallback 警告；補上授權列後警告消失；把該列 `enabled` 設 0 後警告恢復。

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
| Step 3 動態欄位開單 | 載入 Jira 專案實際欄位；摘要/描述/受託人/RD負責人/回報人 為強制必填並自動顯示，未填擋下送出；可從 Lark 自動帶入這些欄位值，其餘選填欄位可手動新增（「+新增欄位」加入後，若 Sheet 欄名跟 Jira 欄位名稱相符，帶入的值本來就會自動出現，不用重新點一次帶入）|
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition；完成後回填處理階段「已切換狀態」|
| 批量評論（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測 Issue Key 列，不需經過開單流程直接批量加評論 |
| 批量修改（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），選擇 Jira 欄位與 Sheet 欄位對應，批量修改摘要/描述/優先級等欄位 |
| 批量更新狀態（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測含 Jira 單號的列，批量執行 transition |
| 批量修改 — 描述附件 | Step 3 預覽表每列有附件欄：可選 Sheet 圖片欄自動讀取（點「讀取附件」），或 + 手動上傳；送出後圖片以 !filename! wiki markup 嵌入描述，影片以 [^filename] 方式嵌入；有未上傳影片時送出前彈出確認 |
| 重新讀取 Sheet | 批量開單/批量評論/批量修改/批量更新狀態 皆有此按鈕（Step 2 以後、頂部步驟列），操作到一半時可重新拉取最新 Sheet 資料，不切換 step、不清空已勾選/已填寫內容，只同步新增/移除的列 |
| 批量更新狀態 — Sheet 欄位篩選 | Step 2 預覽表格自動偵測 2~15 個唯一值的 Sheet 欄位，可篩選縮小範圍（跟批量修改/批量評論同一套模式）；全選只作用於篩選後可見的列；「重新讀取」保留篩選，換網址重新讀取則清空 |
| 批量更新狀態／批量修改 — Jira 目前狀態篩選 | 跟上面的 Sheet 欄位篩選不同資料來源——這個篩的是即時從 Jira API 抓回的單子狀態，選項從已載入資料動態收集、陸續補齊；還沒抓到狀態的列在篩選啟用時直接排除 |
| 切換工具自動帶入 Sheet 網址 | 批量開單/評論/更新狀態/修改 4 個工具切換時自動帶入「最後使用的 Sheet」網址，不用每次都重貼；切到評論/更新狀態/修改會自動帶入並自動重新讀取一次（每個分頁這次頁面停留期間只自動觸發一次，之後靠手動「讀取」/「重新讀取」按鈕），切到批量開單只帶入網址（Step 1 選專案/類型要先完成，不自動送出讀取請求）|
| 查看成員 / 專案 | 列出帳號可存取的 Jira 成員和專案清單 |

### 開單摘要的單一取值來源 `resolveRowSummary()`（2026-08-19，v4.6.1）

摘要有三個可能來源：AI 生成（`generatedSummaries[rowIndex]`，Step 3「AI 摘要生成」面板產生，那格輸入框的 onChange 也只寫回這個 state）、Step 3 手動填寫（`cellValues[rowIdx].summary`）、Sheet 原始「摘要」欄（`applyLarkPrefill()` 會把它寫進 `cellValues.summary`）。先前這三個來源的 fallback 順序散在四個地方各寫一組，而且不一致——最嚴重的是 `validateDynamicFields()` **只讀 `cellValues`**，完全不知道 AI 生成的值存在另一個 state，造成「畫面上明明看得到 AI 摘要、送出時卻整批被『摘要 為必填』擋下」。

**觸發條件是「Sheet 沒有『摘要』欄（或該列摘要是空的）」**：有摘要欄時 `applyLarkPrefill()` 會把它寫進 `cellValues.summary`，驗證剛好過關、送出時再被 AI 值蓋掉，這條縫就一直被遮著沒被發現。已查證**不是 v3.87.10 拆 `JiraCreateStep3.tsx` 造成的 regression**（拆分前後那段逐字相同），也不是任何一次驗證改版造成的——掃過 `JiraPage.tsx` 最近 60 個 commit 的每一版 `validateDynamicFields()` 本體，從來沒有任何一版提過 `summary`/`generatedSummaries`，所以這條縫從 v3.40.0（AI 摘要上線）就存在。

修法（跟 CodeX 討論定案，選「讓驗證去讀送出時的那套 fallback」而不是「生成時回寫 `cellValues`」——後者有「使用者清掉 AI 結果、`cellValues` 卻殘留舊摘要」的風險）：新增 `resolveRowSummary(rowIdx, record?)`，順序固定 `generatedSummaries → cellValues.summary → Sheet 摘要`，四個呼叫點（`validateDynamicFields()` 的 summary 欄、動態欄位模式送出、傳統模式送出、開單成功後的 Sheet 回填）全部改走這支 helper，之後不會再長出第五套順序。

### 「從 Lark 帶入」自動帶入機制與格式轉換（2026-08-12）

`applyLarkPrefill()`（`JiraPage.tsx`）掃的是 Jira 專案**全部**可用欄位（`jiraFields`，不只必填的 5 個），依序試幾組別名去 Sheet 欄名裡找對得上、有值的欄位：`summary` 試 `[Jira 欄位名稱, "摘要", "summary"]`；`description`/`assignee`/`reporter`/`customfield_10428`(RD負責人) 這 4 個有寫死對照（`FORCED_LARK_ALIAS`：分別對到 Sheet 欄「內容」/「受託人」/「回報人」/「RD負責人」）；其餘欄位只試 `[Jira 欄位顯示名稱, 欄位內部 key]`。**這代表「+新增欄位」加進來的選填欄位（環境/難易度/開始日期等）也會被自動掃到**，只要 Sheet 欄名跟 Jira 欄位名稱一致，不用額外設定；且欄位載入完成或「重新讀取 Sheet」後就會自動跑一次，不用手動點「從 Lark 帶入」。

**各型別的格式轉換**（Jira API 對不同欄位型別要求的資料結構不同，Sheet 抓到的都是純文字，需要轉換才能送出，否則開單會失敗）：

- **user/multiuser**：Sheet 值（可能是 accountId 或顯示名稱）比對「查看成員」清單解析成正確的 accountId，比對不到就不帶（這是原本就有的邏輯）
- **select/multiselect**（2026-08-12 修正）：原本直接把 Sheet 文字（例如「簡單」）當成 Jira 內部選項 id 送出去，但 Jira 的 id 是一串代碼（例如「10023」），兩者不相等，一定送出失敗。改成 `resolveSelectOptionId()` 拿 Sheet 值去比對這個欄位在 Jira 裡的 `options[].label`（trim、不分大小寫），找不到再退一步直接比對 `.id` 本身（方便進階使用者直接填 id）；multiselect 支援逗號、頓號、換行分隔多個值。任一值對不到，**這個欄位不會被帶入**（`<select>` 元素本來就放不進去無效值），改寫進 `cellErrors` 讓使用者送出前就看到明確原因（例如「難易度：Sheet 值『簡單』對不到 Jira 選項。可選：容易、普通、困難」），不會靜默漏資料
- **date**（2026-08-12 新增）：原本完全沒轉換，直接把 Sheet 原始值送給 Jira。`normalizeDateValue()` 已用真實 Lark Sheet 資料驗證（真實案例：「本機測試完成時間」欄位，raw value 是數字 `46235`/`46246`，反推對應 `2026-08-01`/`2026-08-12`，跟畫面顯示完全吻合）——**Lark Sheets API 的日期欄位原始值是「序列數字」，不是格式化字串**（Excel/Lotus 慣例，第 0 天 = 1899-12-30，用 `Date.UTC` 換算避免時區偏移），畫面上看到的日期格式是 Lark 前端自己轉換顯示的。也接受已經是 `YYYY-MM-DD`/`YYYY/MM/DD`（含月/日不補零）字串格式的情況；會驗證是真實存在的日曆日期（拒絕 `2026-02-31` 這種會被 `new Date()` 自動 rollover 成 `2026-03-03` 的無效日期，不用 `new Date(rawVal)` 硬吞字串）。純數字只接受整數（沒有真實資料證實 Lark 會用小數表示時分），换算後年份要落在 1900~2447 合理範圍（避免把其他數字欄位誤判成日期序列）。解析失敗同樣不帶入、寫進 `cellErrors`
- **number/datetime**：原本就有正確處理，未變動

`validateDynamicFields()` 送出前會再次檢查所有作用中欄位（必填 + 已加入的選填）的 select/multiselect/date 是否都能正確解析，兩層（帶入當下 + 送出前）都會擋，不會有「帶入時漏檢查、送出時才爆炸」或反過來的縫隙。

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

### 批量更新狀態／批量修改 篩選功能補齊（2026-08-12）

批量更新狀態 Step 2 原本完全沒有篩選機制（批量修改/批量評論早就有），使用者反應對照截圖後補上，跟既有模式做法一致：`updateFilterableColumns`/`updateTabColFilters`/`updateColumnUniqueValues`/`updateFilteredRecords`（`JiraPage.tsx`），全選 checkbox 改成只作用於 `updateFilteredRecords`（不是全部 `updateRecords`），避免篩選後按全選誤選到被篩掉的隱藏列；`updateFilteredRecords` 用既有的 `_rowIndex` 比對回原始列，不重新解析 issue key，避免跟既有匯入邏輯產生兩套判斷。「重新讀取」（`handleReloadUpdateSheet`）不清空篩選；回到 Step 1 換網址重新「讀取」（`handleUpdateFetchBitable`）才清空篩選——這個區分刻意保留，使用者拖動作到一半重新整理資料不該把篩選條件洗掉，但換一份新表格篩選條件多半已經不適用。

**Jira 目前狀態篩選是完全獨立的第二層篩選，不是同一組**：預覽表格顯示的「狀態」欄（批量更新狀態）/「狀態 (Jira)」欄（批量修改，`jiraCols = ['summary','assignee','status']` 本來就有）是即時從 Jira API 抓回的資料（`updateJiraData`/`editTabJiraData`），跟上面 Sheet 欄位篩選的資料來源完全不同，混在同一排篩選容易誤導使用者以為 Sheet 欄位篩選也能篩到這欄。新增 `updateJiraStatusFilter`/`editJiraStatusFilter`（單一字串，不是 per-column，因為只有一個狀態欄可篩）獨立一排並標明「Jira 目前狀態篩選」；可選清單（`updateJiraStatusOptions`/`editJiraStatusOptions`）從目前已載入的 Jira 資料動態收集 unique 值，不寫死 workflow 狀態，且用整包 Jira data state 當 `useMemo` dep，資料非同步陸續載入時選項會自動補齊，不用等全部載完才能篩。**篩選啟用時，還沒抓到 Jira 狀態的列直接排除**（不是模糊顯示成「符合」或「不確定」），避免筆數隨著資料陸續到位而跳動、語意不準確。批量修改的「預覽變更」（Step 3）沿用 Step 2 篩選後的 `editTabSelectedKeys`，不需要另外接篩選邏輯。

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

**路由**：`/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*`｜**歷史紀錄 feature key**：`osm-components`、`luckylink-components`、`luckylink-protocol-versions`、`toppath-components`、`osm-sync`、`osm-alert`

### 功能說明
追蹤 OSM / LuckyLink / Toppath 各元件版本，同步渠道機器設定，發送版本告警。

**LuckyLink SAS/MML/G2S 版本統計（2026-08-12）**：`GET /api/luckylink/protocol-versions`——登入 LuckyLink 後台（跟既有 `/api/luckylink/version-history` 同一組帳密/token 流程），分頁撈完整台 `/slot/egmList`（依回應 `total` 動態算頁數，`pageSize=50`，不是一次帶大 pageSize——已實測帶 `pageSize:2000` 這類超過後端實際上限的值會直接回空結果，必須照後台實際支援的分頁大小逐頁撈；已用真實資料驗證撈滿 1480/1480 台、共 30 頁）。

依 `sasversion` 欄位分類通訊協定：`'mml'` → MML、`'g2s'` → G2S、非空的其他值（例如 `'602'` 這類疑似 SAS 協定規格版號，**不是**字面上的 `'sas'` 字串——原本以為 SAS 機台會直接存 `'sas'`，已用全量 1480 筆真實資料驗證推翻這個假設）→ SAS、空字串 → NO_DATA（實測佔比最大，1300/1480，多數機台尚未回報協定資料）。**版號比對用 `clientversion` 欄位，不是 `sasversion`**——`sasversion` 只負責分類判斷是哪個協定，本身不是版本號（已用真實資料驗證：MML 機台的 `clientversion` 值為 `1.1.10`）。

SAS/MML/G2S 三組各自依 `name`（遊戲代碼）分組，組內列出每台機的 `gmid`／`clientversion`／連線狀態（`isactive`）；目標版本比對 `machine_type_targets` 表 `category='LuckyLink'` 底下的 `sas`／`mml_server`／`g2s_server` 三個 key（沿用既有「從 Lark 同步目標」機制，key-value 結構本來就支援任意新 key，同步端點本身零改動即可支援）。目標版本是「整個協定分類共用一個」，不是每個遊戲各自設定。`isactive` 只影響上線/離線徽章顯示，跟達不達標判斷無關（沒有目標版本時判定固定顯示「未設定目標」，不論線上線下）。NO_DATA 那 1300 台不列出逐筆明細（畫面效能與可讀性皆無意義），只顯示一行統計文字（總數＋其中離線數）；每個遊戲分組的機台明細表格預設收合，展開才顯示逐台清單。

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
| 取得 SAS/MML/G2S 版本 | LuckyLink 分頁下新區塊，抓取全部機台依協定分類、依遊戲分組顯示，與目標版本比對，NO_DATA 只顯示統計數字 |

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

### `machine_test_profiles` 主鍵歷史與反向遷移（2026-08-19，v4.6.2）

這張表的 PRIMARY KEY 來回改過兩次，之後動到它時要知道前因：v4.7.0（`e5ce7d8`）為了讓「同一個機型代碼依 `enterMachineType` 存多筆設定檔」，用 SQLite 表重建的方式把主鍵從單一 `machineType` 改成複合鍵 `(machineType, enterMachineType)`；後來 `f39d37a` 整批退回 v4.5.0，**程式碼退回去了（`ON CONFLICT(machineType)`），但資料表結構是單向遷移退不回來**，兩者對不上，SQLite 直接拒絕（`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`），正式環境所有「儲存機台配置」一律 500。

**教訓：退版能退程式碼，退不了已經跑過的 DB migration。**任何含 schema 遷移的版本被退版時，都要同時檢查資料表是否需要對應的反向遷移，否則會出現「程式碼是舊的、資料庫是新的」這種只在正式環境才炸得出來的不一致。

目前定案（跟 CodeX 討論選 A：讓 DB 對齊程式碼，不是讓程式碼去遷就殘留 schema——後者會讓全新安裝的環境反過來壞掉，因為新建的表本來就是單一主鍵）：`server/shared.ts` 有一段反向遷移，偵測到 `enterMachineType` 仍是主鍵成員時，把表重建回 `machineType TEXT PRIMARY KEY`。有重複 `machineType` 時規則寫死不猜：優先保留 `enterMachineType` 空白那筆（跟 v4.7.0 自己在 AutoSpin/ScriptedBet 挑設定檔的偏好一致），沒有空白才取 rowid 最小那筆，被丟掉的一律 `console.warn` 印出來不靜默覆蓋。已用合成資料驗證挑選規則正確，本機 16 筆真實資料遷移後零遺失、PUT 恢復正常。

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

**截圖監控依帳號開關（2026-08-17，v4.6.0）**：AutoSpin 原本固定每 `screenshot_interval`（20 次 Spin）就 `page.screenshot()` 一次並上傳存進「截圖監控」畫廊；機台一多，畫廊持續累積會把旁邊的 LuckyLink JP／SLS 錯誤日誌兩個面板往上推出可視範圍（見下方版面修正），使用者要求乾脆讓這個功能可以整個關掉。跟三路對帳的 `compareEnabled` 完全同一套「依帳號分開設定」模式（`autospin_notify_prefs` 表新增 `screenshotEnabled INTEGER NOT NULL DEFAULT 1` 欄位＋ALTER TABLE 補齊既有安裝、`isScreenshotEnabled(userLabel)` helper、`GET/PUT /api/autospin/screenshot-prefs`）：
- `/api/autospin/agent/start` 回應頂層多帶 `screenshotEnabled`（帳號層級偏好，不是逐機台設定，所以不塞進每台 machine config）
- `toppath-agent.py`：`main()` 從註冊回應讀出 `screenshot_enabled_data`，透過 `spawn_machine()` 的 `multiprocessing.Process` args 傳給每個 `machine_worker()` child process（沿用既有 `session_id`/`server_url`/`user_label` 那套「parent 讀一次、經參數傳給 child、child 內用 `global` 賦值」模式，因為 Windows/macOS 的 `spawn` 模式下 child 是重新 import 整份模組，不會自動繼承 parent 的全域變數）
- **關掉的範圍刻意只有「上傳存進截圖監控畫廊」這一步**（`async_call(send_screenshot, ...)` 那行），`page.screenshot()` 本身仍然要執行——因為同一個區塊下面的模板偵測（Bonus/Error）需要這張截圖才能運作，戰績紀錄/對帳資料（`post_history`/`fetch_and_post_pinus_records`）也共用同一個觸發點；只關閉上傳，不影響這些其他功能
- **只在下次啟動 AutoSpin session 時生效，不是即時的**（跟 CodeX 討論定案：要做成執行中即時生效需要多一條 agent polling 或 server push 機制，範圍變大，這版先做成本低的版本）——前端 checkbox 下方直接寫提示文字，避免使用者以為切換當下就會立即改變行為
- 前端 checkbox 位置：AutoSpin「執行監控」分頁的派工選項區，緊接在「啟用 LuckyLink JP 比對」下方；掛載時 `GET` 讀目前偏好、切換時 `PUT` 立即寫回（這裡「立即寫回」是指「偏好值」立即持久化，不是指「行為」立即生效，兩者不要混淆）
- 已直接對本機在跑的 server 驗證過 `GET/PUT /api/autospin/screenshot-prefs` 端到端行為（預設 true → PUT false → GET 回 false → PUT true 還原），`npx tsc --noEmit`／`npm run build`／`python -m py_compile` 皆乾淨

**執行監控右側欄版面修正（2026-08-17，v4.5.1，同一天稍早發現的相關問題）**：LuckyLink JP／SLS 錯誤日誌／截圖監控三個面板原本共用同一個 `overflow: 'auto'` 捲動欄位，截圖越疊越多會把上面兩個面板往上推出可視範圍，要滑很久才找得到。改成「截圖監控」單獨限制最高 420px、自己捲動，其他兩個面板留在外層一般排版流裡不受影響，永遠可見不用捲——這個修正跟上面的「截圖監控依帳號開關」是同一輪對話裡使用者連續回報的兩個相關但獨立的問題，一起記錄在這裡方便之後查閱前後脈絡。

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
| 查看即時日誌 / 截圖 | SSE 串流 Agent 執行日誌與遊戲截圖；日誌框固定高度＋內部捲動，支援分類篩選（全部/系統/Spin/截圖/錯誤警告）+ 關鍵字搜尋 + 自動捲到底開關 + 清空；pinus 訊息預設收合，可依 7 類（Spin動作/餘額異動/狀態廣播/進入遊戲/連線登入/心跳列表/其他）分別展開；SSE 斷線（如伺服器重啟）會在 2 秒後自動重連。截圖監控為 2 欄縮圖網格獨立限高 420px 自己捲動，標示最新一張，不會把 LuckyLink JP／SLS 錯誤日誌面板擠出可視範圍 |
| 啟用/停用截圖監控（依帳號） | 派工選項區「啟用截圖監控」勾選框，預設開啟；關閉後不再上傳截圖到畫廊（模板偵測/戰績紀錄/對帳資料不受影響），只在下次啟動 AutoSpin session 生效，執行中切換不即時改變行為 |
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
| `luckylink-protocol-versions` | LuckyLink SAS/MML/G2S 版本統計 |
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

**路由**：`POST /api/weekly-report/parse`、`GET /api/weekly-report/week-range`、`POST /api/weekly-report/jira-by-range`、`POST /api/weekly-report/sheet-headers`、`POST /api/weekly-report/batch-scan`、`GET /api/weekly-report/tab-date-scan`、`POST /api/weekly-report/batch-submit`｜**歷史紀錄 feature key**：`weekly-report`

### 功能說明
獨立工具（2026-08-11 新增，**不掛在 OSM Tools 底下**，跟 Jira/TestCase 生成同一層級），讓成員快速把本週工作內容寫進團隊共用的 Lark Base 週報表。每週該表是全新一張（不是同一張表累積、沒有日期/週次欄位），所以工具不寫死表格 ID，改成使用者每次貼上「本週 Lark Base 網址」，動態讀取該表的欄位選項。

**Lark Base 表格式**（已用真實表驗證，`FEyTb3Y7Ua6ntgsXt0nlKg5yg8e`/`tblBIv21zkPymWCO`）：只有 4 個欄位——`No`（自動編號）、`专案`（單選，~60-70 個專案代碼如 `P7-005-OSM`）、`成员`（單選，~45 個人名）、`补充说明`（純文字）。`parseLarkBaseUrl()`（`server/routes/weekly-report.ts`）解析 `/base/{appToken}?table={tableId}` 格式（跟 `parseLarkSheetUrl()` 解析 `/sheets/`、`/wiki/` 是不同格式，不能共用）。

**初版設計（2026-08-11～2026-08-16，已整個移除）**：最早是「一人一週固定一列、自己手動選成員/專案、多個工作項目全部合併塞進同一格補充說明文字」，Step 3 提供「依時間範圍撈 Jira 單號插入純文字」與「從 Sheet 分析本週內容（alias 精確比對＋四級信心分級＋AI 摘要成一段文字）」兩個輔助入口。2026-08-16 使用者提供真實 Lark Base 截圖後發現團隊實際用法完全不是這樣（見下方「批次掃描審核模式」背景轉折），改寫成批次掃描；**2026-08-16 稍後使用者進一步確認「個人自助」這個舊流程可以完全移除**，不需要跟批次掃描整合或並存。前端整個 `mode === 'individual'` 區塊、`SearchableSelect` 之外的 Step 2/3 UI、`insertAtCursor`/`handleRangeSearch`/`handleSheetRun` 等 handler，以及後端 `POST /api/weekly-report/sheet-analysis`、`POST /api/weekly-report/sheet-analysis-draft`、`POST /api/weekly-report/submit`（單筆新增）三支端點與 `analyzeSheetRows()`/`NAME_COLUMN_HINTS` 皆已刪除。**`POST /api/weekly-report/jira-by-range` 保留**（批次掃描的「依時間範圍撈 Jira 單」功能複用同一支端點，見下方），`readLarkSheetTab()`／`parseSheetDateCell()`／`evaluateConcatFormula()` 等共用 helper 也保留（`sheet-headers`／`batch-scan` 仍在用）。

**撈單條件（`jira-by-range`，沿用至今未變）**：`(reporter = currentUser() OR cf[10440] = currentUser()) AND ((created >= start AND created < end+1天) OR (updated >= start AND updated < end+1天)) ORDER BY updated DESC`——Reporter 是這個人「或」QA驗證人員是這個人，符合其一即列出（驗證人員欄位沿用 `jira.ts` 批次開單時寫入的同一個 `customfield_10440`，env `JIRA_VERIFIER_FIELD_ID` 可覆蓋，不用另外動態偵測）；「建立」或「更新」落在時間範圍內都算，不限工作流程階段（To Do/In Progress/Done 都會撈到）；結束日用「+1天、`<` 排除」而不是 `<= 結束日`，避免 Jira 日期比較只算到當天 00:00 的邊界問題。**不限制 project**，撈這個人 Jira token 能看到的所有專案（使用者明確要求「只要有關這個人的共享專案都能撈到」，不要另外做專案篩選）。`currentUser()` 能正確解析成操作者本人，是因為 `userJiraAuth(req)` 本來就是讀 `x-jira-email` header 對應到後端存的**個人**（不是共用 service account）token 組 Basic Auth，跟批量開單/評論用同一套。批次掃描的多帳號查詢（見下方）就是對這支端點用不同帳號的 email 平行呼叫多次，後端邏輯完全沒改。

**撈取範圍拿掉手動選日期，固定跟隨週期（v4.2.0，2026-08-17）**：原本「依時間範圍撈 Jira 單」面板讓使用者自己選開始/結束日期（預設帶今天/本週一），使用者反應不需要再選、直接跟 Sheet 掃描同一套「週五~週四」週期即可。新增 `GET /api/weekly-report/week-range`，直接複用既有的 `getFridayAnchoredWeekRange()`（跟 `batch-scan` 算的是同一套邏輯，不會有兩套週期定義），額外回傳 `startDate`/`endDate`（`YYYY-MM-DD`，從 `startUTC`/`endUTC` 直接 `toISOString().slice(0,10)`，因為這兩個 Date 是用 `Date.UTC(y,m-1,d)` 疊純日曆年月日組出來的，不是真正的 UTC 時間點，slice 拿到的年月日不會因時區換算跑掉）給前端當 `jira-by-range` 的查詢參數。前端頁面最上方（Step1 卡片之上）新增常駐 banner：即時時鐘（`setInterval` 每秒更新，用 `Intl.DateTimeFormat` 固定 `Asia/Taipei` 時區，不用瀏覽器當地時區——避免使用者裝置時區不是台灣時，顯示時間跟撈取週期對不上）+「本次資料撈取範圍」；`week-range` 掛載時只抓一次，不隨時鐘 tick 重新計算（兩者關注點分開，跟 CodeX 討論定案；頁面長開跨過週五午夜的情況目前沒有自動偵測，仰賴使用者下次操作前重新整理）。**`week-range` 抓取失敗會硬擋，不 fallback 成今天或空值**：`weekRangeInfo` 是 `null` 時查詢按鈕直接鎖住、頁首 banner 顯示「無法取得本週撈取範圍」，避免撈錯資料到不對的時間範圍卻沒有察覺。`scanResult` 裡原本重複顯示的「今天/撈取範圍」兩行拿掉（跟新的頁首 banner 重複），只保留「已排除範圍外/日期無法解析」這個警示，沒有排除筆數時整個提示不渲染。

**讀取失敗會擋在送出之前，不會等送出才報錯**：`POST /api/weekly-report/parse` 會先檢查回應是否包含 `成员`/`专案`/`补充说明` 三個必要欄位，缺少任一個直接回傳明確錯誤訊息列出缺什麼欄位；`BatchScanSection` 在 `parsed` 還是 `null` 時直接顯示提示文字、不渲染掃描表單，不可能在沒讀到欄位選項的狀態下操作。

**曾考慮「同成員已有列就 PATCH 附加」，最後刻意放棄改回永遠新增（2026-08-11 討論結論，批次送出沿用同一個判斷）**：一度做過「送出前查表格裡有沒有同一個成員的既有列，找到就把新內容加一段時間戳分隔線附加到既有補充說明後面，不覆蓋」的版本，但發現這個 read-then-write 模式有兩個真實併發風險：① 同一人短時間內兩次送出（手滑連點、兩個分頁）可能兩次查詢都查到「還沒有」，變成新增兩列而不是預期中的一列變兩次追加；② 查證過 Lark Bitable 的 record update API 沒有 revision/ETag 這類機制能偵測「PATCH 當下這筆資料是否已被別人在 Lark 網頁上手動改過」，沒有這個保護的話就是單純「後寫的贏」，有機會蓋掉別人剛好同時間的手動編輯。永遠新增一列完全不會共用/覆寫任何既有欄位，兩個風險直接消失；代價只是同一人這週送多次會在表上留下多列，判斷是「整理起來麻煩」的小不便，不是「資料被覆蓋」的風險，這筆交易划算。

**普通版／仙俠版**：跟 AutoSpin 三路對帳同一套模式——沿用全站共用的 `--cr-*`/`--xx-*` CSS 變數（不用寫兩份程式碼，切版面模式顏色自動對應），只有文字（標題/步驟說明/按鈕文字）在元件內用 `themeMode === 'xianxia'` 三元判斷切換兩套用詞（例如「送出至 Lark」↔「呈報宗門」、「成員」↔「道號」），沒有额外的裝飾結構差異，符合操作型工具「只換皮不換骨」的既有原則；`BatchScanSection` 本身目前是純classic 文字（未接 themeMode），維持既有簡化。

### 批次掃描審核模式（2026-08-16，取代原本單列合併設計）

**背景轉折**：原本 2026-08-11 的決定是「一人一週固定一列，多個工作項目全部合併塞進同一個補充說明欄位的文字」。使用者提供真實 Lark Base 截圖後發現團隊實際用法完全不是這樣——同一人同一週會出現在多列，每列是獨立工作項目、各自有自己的專案欄位值。工具原本的設計判斷錯了實際用法，改成「掃描來源 Sheet、抓出所有出現的人、一次幫全部人產草稿」。剛推出時頁面曾有「批次掃描」／「個人自助（舊流程）」分頁切換，**2026-08-16 當天稍後使用者確認個人自助可以整個移除**（不需要整合、不需要保留），現在批次掃描是唯一模式，`WeeklyReportPage.tsx` 已不再有 `mode` state 或分頁切換 UI。

**流程**：貼來源 Sheet 網址（最多 3 個）→ 讀表頭後自選「日期欄位」「填寫人欄位」（各必選一個）「內容欄位」（可複選，依勾選順序組合成備註，中間用空格接起來，不做方括號樣板）→ 按「開始掃描」→ 依人員分組顯示可編輯草稿清單 → 唯讀「預期結果」預覽表格 → 「呈報宗門」一次批次建立多筆記錄。

**已用真實資料驗證過的三個關鍵格式**（避免用猜的寫 parser，這幾個都曾經猜錯過一次才改用真實資料驗證）：
1. **「填寫人」欄位是純文字逗號分隔，不是 Lark 結構化多選欄位**——真實原始值就是字串 `"Eric Wu,Jack"`（`splitPersonCell()`，`server/routes/weekly-report.ts`），拆分時支援半形/全形逗號、頓號混用，並排除字面上等於欄位表頭本身的殘留列（真實資料出現過一列「填寫人」欄位值就是「填寫人」三個字，疑似誤植的表頭殘留）。
2. **日期欄位是 Lark 序列數字**（例如 `46250`），跟 Jira 開單帶入功能踩過同一種坑，沿用已驗證過的轉換公式（epoch `Date.UTC(1899,11,30)`，`parseSheetDateCell()`）；也接受 `YYYY-MM-DD`/`YYYY/MM/DD` 字串格式，驗證是真實存在的日曆日期。
3. **公式儲存格（如常見的「摘要」欄位）用 Lark Sheets API 讀到的是公式原始文字（例如 `"["&F2&"]["&E2&"]"&I2`），不是算好的結果**——因此設計上不依賴任何公式欄位，改成使用者自選的「內容欄位」自己組字串（例如勾選「類別」+「主題」+「描述」）。**2026-08-16 補修**：使用者實測時仍選了「摘要」這個看起來最方便的欄位，畫面上直接看到公式原始文字沒被轉換，才發現只是「建議別選」不夠，還是要處理。加了 `evaluateConcatFormula()`（`server/routes/weekly-report.ts`）：只處理最常見的「字串字面值 + 同列儲存格參照，用 `&` 串接」這個窄範圍樣式（不是通用公式引擎），偵測依據是抽出來的文字以 `"` 開頭且含 `&`（`looksLikeFormulaText()`，正常填寫的文字內容幾乎不會長這樣）；欄位參照（例如 `F2`）用字母轉 0-based 欄位索引，从同一列的其他欄位取值代入，任何不符合這個窄樣式的 token 直接放棄評估、保留原始文字（不會猜錯）。已用真實資料驗證：`"["&F2&"]["&E2&"]"&I2` 正確算出 `[OSM][H5]修改loading图`，跟 Lark 前端顯示的結果一致。

**時間窗**：週期固定「週五 00:00 ～ 下週四 23:59:59」（不是週一開頭），本地時區（Asia/Taipei）固定算，不用 UTC 當下時間（`getFridayAnchoredWeekRange()`）。今天剛好是週五時起日就是今天；週四時屬於上一個週五開的週期；不用特判跨月跨年，單純日期加減（已用 2027/1/1 跨年、2026/2/28 跨月等邊界案例驗證過）。畫面上方橫幅明確顯示「今天幾號／撈取範圍幾號到幾號」，範圍外與日期無法解析的筆數也明確列出（`excludedOutOfRange`/`excludedUnparsableDate`），不靜默過濾。

**人名比對只允許命中既有成員名單，不用 substring**（避免「Jack」誤中「Jackson」這類問題）：trim 後不分大小寫精確比對 Step 1 讀到的真實成員名單（`memberSet`）。比對不到的人整批列在獨立「未識別人員」區塊，不會被丟棄——可以手動指派給某個既有成員（內容原封不動複製過去）或忽略。已用真實資料驗證：目標 Lark Base 的成員名單裡沒有「Eric Wu」這個確切字串（只有「Jack」），掃描時「Eric Wu,Jack」這一列正確地把 Jack 歸進正常草稿、Eric Wu 歸進未識別人員，證實比對邏輯與防呆都正確運作。

**專案自動比對是關鍵字比對，不是 AI 判斷**：先檢查整段組合後的內容字串是否包含某個專案選項的完整名稱，比對不到再退一步檢查各個內容欄位的原始值是否被包含在某個專案名稱裡（例如內容欄位「主題」的值是「OSM」，能比對到專案「P7-005-OSM」，已用真實資料驗證）。比對不到的項目「專案」留空，「預期結果」預覽表格會用紅色「⚠ 未選專案」標示，送出前必須手動補齊，按鈕會被鎖住無法點擊——不會讓 AI 或規則靜默猜錯歸類。

**送出防呆**：確認送出前顯示完整統計（幾位成員、幾筆記錄、幾筆未識別人員待處理、幾筆缺專案待補），缺專案時送出按鈕鎖住並顯示原因；`POST /api/weekly-report/batch-submit` 逐筆呼叫 Lark Bitable records API（不是真的批次 API，Lark 沒有提供），各自記錄成功/失敗，不是同批 all-or-nothing；跟既有單列送出端點一樣是 append-only、不做 PATCH（同一套併發風險考量，見上方「曾考慮 PATCH...」段落）。

**依時間範圍撈 Jira 單（可多選帳號，2026-08-16 補上）**：原本評估「Jira 只能得知目前登入操作者自己的單，無法自動判斷該歸給掃描結果裡的哪個人」，後來發現這個顧慮想複雜了——帳號的 Jira token 本來就存在後端（`jira_accounts` 表），跟「目前誰登入這個網站」無關，`userJiraAuth()` 只看前端傳的 `x-jira-email` header 去查對應 token，所以可以直接對既有的 `/api/weekly-report/jira-by-range` 用不同帳號的 email 平行呼叫多次（沒有改後端邏輯）。真正的重點是**不要用 Jira 帳號的 label 自動對應 Lark 成員名字**——已用真實資料證實兩份名單不完全對得上（Jira 帳號有「Eric Wu」，但目標 Lark Base 成員名單裡沒有這個名字，只有「Dean」「Tim」等其他人存在於兩邊）。所以撈完之後永遠是手動選「加入到哪個人」，帳號只負責查詢、不負責分類。

**已用真實資料驗證過兩個真實帳號（Eric Wu／Dean）平行查詢，各自正確撈回不同的真實 Jira 單，沒有互相污染。**

**修正：先套用 Jira 再重跑 Sheet 掃描時，Jira 加的項目會被整包蓋掉（2026-08-16，跟 CodeX 討論定案）**：`handleRunScan()` 原本收到新掃描結果後直接 `setDraftEdits(d.draftsByPerson)` 整包覆蓋 `draftEdits`——`applyJiraToPerson()`/`applyJiraAuto()` 是用 `setDraftEdits(prev => ({ ...prev, ... }))` 函數式更新疊加上去的，所以「先跑 Sheet 掃描、再套 Jira」正常（Jira 疊在 Sheet 結果上），但「先套 Jira、再跑 Sheet 掃描」會讓 Jira 加的項目整批消失（覆蓋掉整個物件，不只是同一個人）。修法：`handleRunScan()` 改成「Sheet 來源重建、非 Sheet 來源保留併回」——後端 `batch-scan` 產生的 `sourceRowId` 固定是 `"{sheetIndex}-{rowIndex}"` 格式（純數字-數字），用這個格式判斷一個 `DraftItem` 是不是這次 Sheet 掃描的產物；不符合這個格式的（Jira 套用產生的 `Jira · ...`、手動新增的 `手動新增`、未識別人員手動指派的 `手動指派 · ...`）視為非 Sheet 來源，掃描完成後保留原樣併回新的 `draftsByPerson`，不會被新掃描結果覆蓋。同一個人若原本有 Jira 項目、Sheet 重掃又抓到新項目，結果是「新 Sheet 項目 + 原本保留的 Jira 項目」都在同一個人底下，不會互相取代。

**CodeX review 後再補兩處（v4.1.1，2026-08-17）**：① `handleRunScan()` 原本用 closure 裡的 `draftEdits`（呼叫當下的值）合併，若 Sheet 掃描 request 還沒回來時使用者又套用 Jira／手動新增，回應回來時會用過期的 `draftEdits` 合併，把這段期間新增的非 Sheet 項目吃掉——改成 `setDraftEdits(prev => ...)` functional update，讀的一定是最新 state。② `assignUnidentified()`（未識別人員手動指派給某個成員）原本沿用 `row.sourceRowId`（後端 batch-scan 給的原始 Sheet 格式），代表這筆手動指派會被下一次 Sheet 重掃當成「舊 Sheet 產物」一併清掉重建，跟其他手動操作（Jira 套用/手動新增）待遇不一致；改成塞進去的 `sourceRowId` 固定加上 `手動指派 · ` 前綴，這樣就會被 `isSheetSourced()` 判定為非 Sheet 來源、重掃時保留。

**已知範圍限制**：沒有做跨 session 持久化的疑似重複送出偵測（例如同一來源列/同一人/同一週是否已經送過），目前完全仰賴 append-only 設計本身的安全性與使用者自行注意，之後如果真的發生重複送出問題再補（CodeX review 時建議先觀察，不是本版必需）。

**CodeX review 後修正的四個問題（2026-08-16）**：① Sheet 讀取失敗不再靜默略過，新增 `sourceErrors` 明確顯示是哪個來源失敗；② 專案關鍵字 fallback 比對從「任一內容欄值 ≥2 字元命中」改成「最長命中優先＋最短 3 字元才參與比對」，避免 `v2`/`QA` 這類泛用短字誤配（已驗證 `OSM` 這類合法短代碼不受影響）；③ **最關鍵**：批次送出部分失敗時不再整批保留重送——已成功的項目用送出當下 `flatPreviewItems` 的順序對應後端逐筆 index，直接從清單移除，避免重送造成重複建立；④ `batch-submit` 整個 handler 包進 try/catch，跟其他端點錯誤格式一致。

**公式儲存格修正（2026-08-16）**：使用者實測時選了「摘要」這欄（畫面上看起來最方便，因為 Lark 前端會顯示算好的結果），結果送進來的內容是公式原始文字沒被轉換。修法不是叫使用者避開這欄，而是新增 `evaluateConcatFormula()` 直接把常見的「字串字面值＋同列儲存格參照、用 `&` 串接」這個窄範圍公式樣式算出來（不是通用公式引擎，遇到看不懂的樣式直接放棄評估、保留原始文字，不會猜錯）；已用真實資料驗證 `"["&F2&"]["&E2&"]"&I2` 正確算出 `[OSM][H5]修改loading图`，跟 Lark 前端顯示一致。

**「頁籤日期式報表」來源類型（v4.3.0，2026-08-17，跟 CodeX 討論定案）**：跟現有「一欄式 Sheet」（一個頁籤裡用某一欄的值當日期篩列）完全不同的資料結構——這類報表是同一份文件底下有一堆頁籤，**頁籤名稱本身就是日期開頭**（例如「20260811 NP 5台」），沒有任何「填寫人」欄位。設計上跟一欄式 Sheet 並存，不是取代：

- **文件寫死在後端，不吃前端輸入**：`TAB_DATE_REPORT_SOURCES`（`server/routes/weekly-report.ts`）固定文件的 `spreadsheetToken`（使用者提供的網址解析出來）+ 顯示用 `label`——因為文件本身固定不變，只有頁籤會持續新增，不需要使用者每次貼網址。**目前只有 1 份，顯示名稱「線上機台測試表單」**（`spreadsheetToken=JFplspG3Mh8LAXtFxsRlSgTRgmg`，Lark 文件本身叫「測種測試表」，v4.4.4 使用者要求對外顯示改叫這個名字）——v4.3.1 一度誤把使用者提供的第二個網址（`JjLosMhsShlrfatriEBlX3d7gLd`）也當成這個類型加進來，v4.4.0 使用者澄清那份其實是一般的一欄式 Sheet（見下方「來源 Sheet 第一筆自動導入」，該份文件現在的顯示名稱是「OSM需求單」，跟這裡改名後撞名才改的），已移除，不要重新加回這裡。
- **`listLarkSheetTabs(spreadsheetToken)`**：只打 `sheets/v3/.../sheets/query` 拿完整頁籤清單（sheetId+title），刻意跟 `readLarkSheetTab()`（一欄式 Sheet 用，只挑一個頁籤讀內容）各自獨立、不共用內部邏輯（CodeX review 建議），避免互相影響既有流程。
- **`parseTabTitleDate()`**：頁籤標題開頭抓 8 位數日期（`/^(\d{4})(\d{2})(\d{2})/`），驗證是合法日曆日期（沿用既有 `isValidCalendarDate()`），落在本週 `getFridayAnchoredWeekRange()` 範圍內才算命中；解析不出日期的頁籤（例如可能存在的說明/範本頁籤）直接跳過，不當命中也不當錯誤。
- **`GET /api/weekly-report/tab-date-scan`**：每份文件各自讀取失敗互不影響（回 `sourceErrors`，不整支端點失敗，比照 `batch-scan` 做法）；已用真實資料驗證過（真實抓到兩份文件的完整頁籤清單、日期解析結果跟畫面上肉眼比對一致，2026-08-17 當週 08/14~08/20 範圍內兩份文件都沒有命中頁籤——正確，因為當時最新的頁籤是 08/11，本來就在範圍外）。
- **沒有填寫人欄位，全部手動指派，且支援複選**（跟「未識別人員」assign 那種一次只能選一個不同）：命中的頁籤不讀內部資料，整個頁籤標題文字（例如「20260811 NP 5台」）當一個項目的補充說明，前端用新的 `SearchableMultiSelect` 元件（下拉+搜尋+ checkbox 複選，v4.3.2 取代原本使用者反應不好用的原生 `<select multiple>` 清單框）讓使用者一次勾選多個成員，套用後同一份內容各自複製一份加進每個人的草稿。
- **`sourceRowId` 格式 `手動指派 · 頁籤 · {sourceKey}:{sheetId}`**（CodeX review 建議帶來源 key，避免兩份文件剛好 `sheetId` 撞名時難追）——不符合 Sheet 掃描的 `"{sheetIndex}-{rowIndex}"` 格式，歸類為非 Sheet 來源，`handleRunScan()` 重跑 Sheet 掃描時會保留不會被清掉，跟 Jira 套用/手動新增待遇一致。
- **防重複套用**（CodeX review 建議）：`applyTabDateItem()` 套用前檢查該成員草稿裡是否已經有同一個 `sourceRowId`，有就跳過，避免同一個頁籤對同一人重複點套用造成重複項目。
- **自動預設專案「P7-007-第三方測試」（v4.4.2）**：頁籤標題是機台代碼（例如「20260811 NP 5台」），不是乾淨關鍵字，既有的專案自動比對（見下方「來源 Sheet 第一筆自動導入」段落同樣的比對邏輯）抓不到，使用者要求直接固定預設。`applyTabDateItem()` 用既有的 `matchLarkProjectByJiraName()`（模糊比對，空格/連字號都吃）查 `DEFAULT_TAB_DATE_PROJECT_NAME`。
- **v4.4.3 修正下拉選單被裁切**：每個來源卡片外層原本 `overflow: 'hidden'`（為了讓標題列背景色跟著外框圓角），結果連 `SearchableMultiSelect` 往下展開的下拉選單也一起被切掉，使用者截圖回報「看不到人員名單」。改成外層不裁切，標題列自己套 `borderRadius: '8px 8px 0 0'`——見 [[feedback_dropdown_overflow_clip]] 記憶，這是通用教訓不是只有這裡會踩。

**「來源 Sheet」第一筆自動導入（v4.4.0，2026-08-17；v4.4.4 顯示名稱改叫「OSM需求單」）**：使用者要求「OSM需求單」（`JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf`，分頁「驗證表單_v2」）固定當「來源 Sheet」第一筆，頁面載入時自動讀表頭+套用已知欄位對應，不用手動設定。跟頁首 Lark Base 網址（`DEFAULT_WEEKLY_URL`）同一種「預設帶入＋自動讀取」模式，但這裡是額外多一個「自動套用欄位對應」的步驟：

- `DEFAULT_SCAN_SHEET_URL`/`DEFAULT_SCAN_SHEET_DATE_COLUMN`/`DEFAULT_SCAN_SHEET_PERSON_COLUMN`/`DEFAULT_SCAN_SHEET_CONTENT_COLUMNS`（`WeeklyReportPage.tsx`）：`scanSheets` 初始狀態第一筆直接帶入這個網址；掛載時的 `useEffect` 呼叫既有 `/api/weekly-report/sheet-headers`，成功後除了填入 `headers`，額外直接套用日期欄位＝`日期`、填寫人欄位＝`填寫人`、內容欄位＝`['摘要']`（使用者確認只要摘要）——**不是**呼叫 `handleLoadSheetHeaders()`，那支函式讀成功後固定把 `dateColumn`/`personColumn`/`contentColumns` 重設空白（給使用者自己選新 Sheet 用），跟這裡「已知固定答案、要直接套用」的需求相反，所以獨立寫一份 mount effect。
- **真實表頭已用 `POST /api/weekly-report/sheet-headers` 對本機在跑的 server 驗證過**：`日期`/`填寫人`/`嚴重度`/`類別`/`主題`/`版本`/`摘要`/`描述`/`圖`/`確認OK`/`進度`/`備註`/`RD`/`本機測試完成時間`/`Jira issue key`/`Jira URL`/`處理階段`/`處理時間`/`環境` 等，`日期`/`填寫人`/`摘要` 三個欄名都確實存在，不是憑空假設。
- **競態防護**：套用預設欄位對應時檢查 `i === 0 && s.url === DEFAULT_SCAN_SHEET_URL`，如果這支 fetch 回應回來之前使用者已經手動把 slot 0 的網址改掉，不會被回應覆蓋回預設值。
- 欄位仍可編輯、網址仍可手動改成別的重新讀取，不是鎖死不能改——跟 `DEFAULT_WEEKLY_URL` 同一個「預設值，非強制」原則。
- **全自動載入延伸到 Jira 撈單／頁籤日期式報表（v4.5.0，2026-08-17）**：使用者要求把「Jira 撈單」跟「頁籤日期式報表」也整合進全自動載入，固定自動帶入 3 位使用者：Eric、Lusa、Siara。**本機跟正式服的 Jira 帳號清單不同**（本機 `jira_accounts` 混了測試帳號如 `lusa`/`OM`/`ad`，正式服「太玄道樞」是乾淨的真實帳號如 `Eric Wu`/`Lusa`/`Siara Lin`），所以用 `AUTO_IMPORT_TARGET_KEYWORDS = ['eric','lusa','siara']` + `matchesAutoImportTarget()` 對現有清單做「小寫子字串」模糊比對，不寫死特定 email，兩邊環境都能自動選到對得上的帳號/成員——已用真實資料驗證：本機只有 Eric Wu／lusa 兩個帳號能匹配（本機沒有 siara 測試帳號，屬預期），這個 Lark Base 的成員清單三個關鍵字都能匹配到（`Eric Wu`／`Lusa`／`Siara`）。
  - **Jira 撈單自動流程**（`autoJiraImportTriggeredRef`，`parsed` 和 `weekRangeInfo` 都就緒時觸發一次）：自動 fetch 帳號清單（若未載入）→ 關鍵字篩出目標帳號 → 自動勾選＋開啟面板 → 自動查詢（複用跟 `handleJiraRangeSearch` 相同的多帳號查詢/合併邏輯，但用區域變數而非讀 state，避免 setState 非同步時序問題）→ **不是複用既有 `applyJiraAuto()`**（那支是精確比對帳號 label 跟 Lark 成員名字，「Siara Lin」精確比對不到「Siara」會失敗；這裡刻意寫獨立邏輯用關鍵字模糊比對，不去放寬 `applyJiraAuto()` 本身，避免影響其他人手動用「自動套用」時的比對準確度）→ 用「關鍵字」建立 帳號↔Lark成員 對應表，直接產生草稿項目。
  - **頁籤日期式報表自動流程**（`autoTabDateScanTriggeredRef`＋`autoTabDateApplyTriggeredRef` 兩個 ref，各自對應「觸發查探」「查探完成後自動套用」兩個階段）：`applyTabDateItem()` 新增可選的 `membersOverride?: string[]` 參數——傳入時直接用這份清單，不讀 `tabDateSelectedMembers` state（避免同一個問題：`setTabDateSelectedMembers` 之後立刻呼叫沒被更新的 state）；手動流程（畫面上勾選+按套用）不傳這個參數，行為完全不變。
  - **範圍**：只做到「自動準備好草稿」，最終「呈報宗門」送出仍然要使用者手動確認點擊，不會自動寫入 Lark——這條全自動載入鏈路全部只影響前端草稿狀態。
  - **失敗容忍**：整個自動流程包在 try/catch 裡，失敗不跳錯誤訊息干擾使用者（All-or-nothing 不是必要的，failing silently 讓使用者仍可以照原本手動流程操作）。
- **連「開始掃描」也自動觸發一次（v4.4.1）**：使用者反應光是欄位自動帶入還不夠，希望連掃描本身也自動跑。`autoScanTriggeredRef`（`useRef`）擋重複觸發，只在「Step1 Base 已解析＋`scanSheets` 目前唯一一筆且就是 `DEFAULT_SCAN_SHEET_URL`＋欄位都已套用好」這個瞬間自動呼叫一次 `handleRunScan()`；使用者手動編輯過欄位、或後續新增/改變 Sheet 清單，都不會再自動重跑。
- **自動預設專案「P7-005-OSM」（v4.4.2）**：內容欄位（摘要）是完整句子（例如「[OSM][H5]修改loading图」），跟既有的專案關鍵字比對邏輯（`content.includes(p.name)` 或 `findBestProjectByContentColumns`）都對不上——前者要求專案全名整串出現在內容裡，後者要求內容欄位「整格」的值被包在專案名稱裡，兩種都假設內容欄位本身就是乾淨關鍵字，這份表的「摘要」不是。使用者要求固定預設。`handleRunScan()` 收到 `batch-scan` 回應後，若 `scanSheets[0].url === DEFAULT_SCAN_SHEET_URL`，對 `sourceRowId` 開頭是 `"0-"`（sheetIndex 0）且後端沒比對到專案（`projectName` 空）的項目，補上 `matchLarkProjectByJiraName(DEFAULT_SCAN_SHEET_PROJECT_NAME, parsed.projects)` 的結果；後端已經比對到的不覆蓋（後端關鍵字比對比較準時優先採用）。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看頁首即時時鐘／撈取範圍 | 頁面最上方常駐顯示，即時時鐘每秒更新（固定 Asia/Taipei 時區）+ 本次資料撈取範圍（跟 Sheet 掃描同一套週五~週四週期）；讀取失敗會明確顯示「無法取得本週撈取範圍」 |
| 貼上本週 Lark Base 網址 | 每週表格不同，貼上後自動讀取「成员」/「专案」欄位選項；預設帶入固定連結並自動讀取一次，欄位仍可編輯、可手動改連結重新讀取 |
| 新增來源 Sheet | 最多 3 個，第一筆固定帶入「OSM需求單」並自動讀表頭＋套用已知欄位對應（日期/填寫人/摘要），仍可手動改網址重新讀取；其餘筆各自貼網址後「讀取表頭」，自選日期欄位／填寫人欄位（各必選一個）／內容欄位（可複選，公式儲存格如「摘要」欄位會自動嘗試評估成真正的值，評估不了才保留原始文字） |
| 開始掃描 | 依週五起始時間窗過濾、依填寫人拆分、比對成員名單與專案關鍵字，畫面顯示統計卡片；來源讀取失敗會明確顯示，不靜默漏資料 |
| 依時間範圍撈 Jira 單（可多選帳號） | 頁面載入時自動勾選 Eric/Lusa/Siara（關鍵字模糊比對現有帳號清單）、自動查詢、自動套用成草稿；撈取範圍固定跟隨頁首顯示的週期，不用手動選日期；也可以手動勾選其他帳號各自用自己的 token 平行查詢，結果合併顯示（同張單被多個帳號查到會標示來源），撈完手動選「加入到哪個人」套用——不論先跑 Jira 還是先跑 Sheet 掃描，兩邊加的項目都會保留、不會互相蓋掉 |
| 查探頁籤日期式報表 | 頁面載入時自動觸發查探，命中的頁籤自動勾選 Eric/Lusa/Siara（關鍵字模糊比對）並自動套用；來源文件寫死不用貼網址，一鍵掃描固定文件裡「標題開頭是本週日期」的頁籤，命中的頁籤標題整串當內容；也可以手動改勾選其他一或多個成員（可複選）後套用，沒有填寫人欄位所以沒有自動分類 |
| 依人員分組編輯草稿 | 人員 tab 切換，每人清單可編輯專案／備註／刪除／新增項目 |
| 處理未識別人員 | 比對不到既有成員名單的列另外列出，可指派給某個成員或忽略，不會被吞掉 |
| 查看預期結果 | 唯讀表格，欄位對齊真實 Lark Base（No/專案/成員/補充說明），缺專案的列標紅 |
| 呈報宗門 | 缺專案時鎖住送出；送出後顯示成功/失敗筆數 |

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
