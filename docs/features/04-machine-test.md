# 機台自動化測試

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

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
→ [checkOsm] iDeck 測試（XPath 或自動偵測按鈕點擊 + daily-analysis API 確認；API 查不到機台 → SKIP 未驗）
→ [checkOsm] 觸屏測試（span 文字點位 + daily-analysis API 確認；API 查不到機台 → SKIP 未驗）
→ [checkOsm] CCTV 號碼比對（截圖 + Gemini Vision OCR）
→ [checkOsm] 退出測試（btn_cashout → leaveGMNtc，errcode=10002 時自動重試最多 3 次）
```
> `[checkOsm]`：每步驟前檢查 OSMWatcher 狀態，若偵測到特殊遊戲（FG/JP/Handpay），執行指定 bonusAction 一次後持續 Spin 直到 status=0。

**Spin 測試面額選擇遮罩處理（2026-07-31 修復）**：`.select-main` 面額選擇遮罩蓋住 Spin 按鈕時點擊不會拋 Playwright 的「intercepts pointer events」例外——遊戲只是完全收不到 Spin 動作，`stepSpin()` 原本只在例外處理（catch）裡才 force click 的邏輯完全不會被觸發，會固定卡滿 8 秒判定逾時、餘額沒變化。跟 AutoSpin.py 早就修過的同一個問題（見上方 AutoSpin 章節「選面額遮罩攔截 Spin 點擊」），但 Machine Test 這邊當時沒有同步移植。修法：把 `stepIdeck()` 裡原本局部（closure）的關閉遮罩邏輯抽成模組層級共用函式 `dismissDenomOverlay(page, emit, source)`，`stepSpin()` 每次點擊 Spin 按鈕前都先呼叫一次主動關閉遮罩，不再只依賴例外處理；`stepIdeck()` 呼叫點同步改用共用版本。

### iDeck／觸屏判定與 iDeck 自動偵測（2026-09-24）

> ⚠️ 以下三項目前只改在本機 agent `C:\machine-test-agent-claude` 的 `server/machine-test/runner.ts`，**尚未同步進本 repo**；同步時請一併參照這段。

**1. 日誌 API 查不到機台 → 判 SKIP（未驗），不判 FAIL**
- iDeck／觸屏都是點完後查 `daily-analysis` timeline 裡新增的 `success_json`（`is_ideck`／`is_touch`）來確認。
- 原本 API 回錯時（`success:false`、HTTP 錯誤、例外）會被當成「0 筆回應」判 **FAIL**。實測 UAT `4186-SQUIDGAME-0312`：prod／qat 的 daily-analysis 都回 `CMDB未找到机器 4186-SQUIDGAME-0312 的IP`，連同一輪確定成功的 Spin 都查不到，這時的 FAIL 沒有任何證據。
- 改成：API 查不到 → `status: 'skip'`，訊息開頭 `未驗：機台 log API 查不到 <gmid>（<原因>）`。觸屏的前端觀察（`onTouchScreen` 收下幾次、`dealGMActionReq` 送出幾次）照樣附在訊息裡。
- 批次工具（`machine-test-batch.mjs` 的 `judge()`）把 skip 當「未驗」，QA 確認狀態（J 欄）不填。
- 要真正驗到盒子端，該渠道的機台必須先在 CMDB 登記（4186 渠道目前沒有）。

**2. iDeck 自動偵測改抓 `btn_bet` ＋ `btn_play`**
- 觸發條件：機種設定檔沒有 `ideckXpaths` 也沒有 `ideckRowClass`。
- 原本只抓 `[class*="btn_bet"]` 的可見元素。SQUIDGAME 的 iDeck 有兩排：
  - `btn_bet` ×4：面額 ₱1／₱2／₱5／₱10
  - `btn_play` ×6：注額 30／60／90／150／300／450 Credits
  
  只抓 `btn_bet` 會漏掉整排 `btn_play`，只點到 4 顆。現在兩種都抓，照畫面（DOM）順序點，SQUIDGAME 10 顆都點得到（使用者確認總數是 10）。
- ⚠️ `btn_play` 會**真的下注、扣餘額**。其他機種只要畫面上有 `btn_play`，iDeck 步驟也會點到。
- 回查用的 XPath 索引改成「所有候選元素中的位置（含隱藏的）」。原本用「可見元素的序號」，前面只要有隱藏的按鈕就會點錯顆。
- 對照紀錄改成：`🔍 iDeck 自動偵測對照：btn_bet＋btn_play 可見 N 顆`。

**3. 新增 iDeck 結構診斷紀錄（只讀不點）**
- 每次 iDeck 步驟都會多印一行 `🔍 iDeck DOM：…`，內容包含：
  - 每顆候選按鈕的類型（B＝btn_bet、P＝btn_play）
  - 狀態：V＝可見、OFF＝在畫面外、H＝隱藏
  - 座標與文字
  - 所在容器內各 class 的可見數／總數
- 用途：之後遇到「點到的顆數跟實際不符」可以直接從 log 判斷原因，不用再進遊戲量一次。
- 實作注意：tsx（esbuild keepNames）會把 `page.evaluate` 內部的箭頭函式包上 `__name()`，瀏覽器端沒有這個 helper。所以要先執行 `evaluate('window.__name = window.__name || (fn => fn)')` 補上。

**SQUIDGAME 設定檔**：原本的 `ideckXpaths` 有兩個問題，已清空改走自動偵測：
- 10 條裡第 7 條開頭多了一個字母 `b`，寫成 `b//div…`
- `[n]` 位置寫法在按鈕分散在不同容器時抓不到，實際只命中 3 條

另外中控上還有一份內容相同的 `SQUID GAME`（有空格）設定檔，機台代碼解析用不到它，未處理。

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
| `ideckXpaths` | iDeck 按鈕 XPath 列表（優先於 ideckRowClass；兩者都沒設 → 自動偵測可見的 `btn_bet`＋`btn_play`）|
| `entryTouchPoints` | 進入機台第一階段觸屏（選擇面額等）|
| `entryTouchPoints2` | 進入機台第二階段觸屏（YES/NO 確認）|
| `gmid` | gameid URL 參數，用於設定檔 fallback 比對 |

---
