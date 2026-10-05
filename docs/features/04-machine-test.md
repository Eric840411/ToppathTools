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

## Agent 斷線重連後 session 卡在執行中（v5.12.4）

> 2026-10-06 01:05 正式站（osm-qa-agent 回報）：機台 0214 跑到一半 agent 斷線（1006），5 秒後用**同一個 agentId** 重連；伺服器把 0214 一直顯示 running，40 分鐘沒動靜，要手動 `POST /api/machine-test/stop/<session>` 才清掉。
> agent 端還印了「No more jobs — session complete」，誤導了排查。

### 原因
1. worker 的 `agent_ready` 直接 `agentConnections.set(agentId, 新 info)` 覆蓋 → 舊連線手上的 sessionId 不見
2. 舊 socket 的 close 比重連晚到，讀 map 拿到**新** info（沒有 sessionId）→ 不取消 session，還把**新**連線刪掉
3. agent 端 `job_done` 只在連線開著時送，斷線就丟了；claim-loop 把「連線關了」當成「沒工作」→ 印 session complete
4. agent 斷線只把 `currentRunner` 設成 null，舊的那台其實繼續跑

### 修法（CodeX 2026-10-06 同意：**這次先取消整個 session**，維持既有斷線語意；只讓那台失敗、其他繼續是另一項行為改動）
- `server/agent-lifecycle.ts`：每條 socket 持有**自己的** AgentInfo；收尾（onLost）**每個 info 只做一次**——重連與舊 close 走同一個入口；close 只在 map 裡還是自己時才刪；重連時先把舊連線當斷線收尾再登記新的（在 token 驗證成功之後）
- 舊連線晚到的 `claim_job`／`job_done`／`agent_done` 一律不算數（`ownsSession`）
- 取消要完整（`abortMachineTestSession`）：沒跑完的機台標失敗並廣播佇列、`activeRunners` 的 stop（停其他參與 agent、釋放重任務鎖）、廣播錯誤與 session 結束。原本只刪佇列，漏了 `finishHeavyTask` 和停其他 agent
- UAT、AutoSpin 下注等各自的斷線收尾規則照舊，只是改從同一個入口呼叫
- agent 端：斷線時要求正在跑的 runner 停止；重連後的新派工**先等上一輪收尾**（`claimLoopDone`）；斷線結束的迴圈印「連線中斷」不印 complete；`job_done` 送不出去會記一行

### 測試
- `npx tsx server/agent-lifecycle.test.ts`（17）：ready 先到／close 先到兩種順序、重複收尾、舊訊息晚到、多 agent 取消
- 突變驗過：拿掉「只做一次」、close 無條件刪 map、重連不收舊連線，各自有對應的測試變紅
- ⚠️ 沒有真 agent 斷線的實測：agent 要用真的 token 連線，本機無法偽造。下次真的斷線時看 log 有沒有「Agent disconnected: …（Agent … 重新連線，舊連線已中斷）」與 session 是否自動結束
- ⚠️ agent 端的修改要 agent「更新程式碼」並重啟才生效
