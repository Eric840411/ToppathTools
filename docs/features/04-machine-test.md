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
  - 存檔／上傳（cctv-saves，batch 貼 Lark H 欄）一律是**整個 viewport**；OCR／鏡頭比對仍用裁到 `div.cctv_video` 的圖（v5.15.1）
→ [checkOsm] 退出測試（btn_cashout → leaveGMNtc，errcode=10002 時自動重試最多 3 次）
```
> `[checkOsm]`：每步驟前檢查 OSMWatcher 狀態，若偵測到特殊遊戲（FG/JP/Handpay），執行指定 bonusAction 一次後持續 Spin 直到 status=0。

**Spin 測試面額選擇遮罩處理（2026-07-31 修復）**：`.select-main` 面額選擇遮罩蓋住 Spin 按鈕時點擊不會拋 Playwright 的「intercepts pointer events」例外——遊戲只是完全收不到 Spin 動作，`stepSpin()` 原本只在例外處理（catch）裡才 force click 的邏輯完全不會被觸發，會固定卡滿 8 秒判定逾時、餘額沒變化。跟 AutoSpin.py 早就修過的同一個問題（見上方 AutoSpin 章節「選面額遮罩攔截 Spin 點擊」），但 Machine Test 這邊當時沒有同步移植。修法：把 `stepIdeck()` 裡原本局部（closure）的關閉遮罩邏輯抽成模組層級共用函式 `dismissDenomOverlay(page, emit, source)`，`stepSpin()` 每次點擊 Spin 按鈕前都先呼叫一次主動關閉遮罩，不再只依賴例外處理；`stepIdeck()` 呼叫點同步改用共用版本。

### iDeck／觸屏判定與 iDeck 自動偵測（2026-09-24）

> 以下三項原本只改在本機 agent `C:\machine-test-agent-claude`，已於 v4.260.0（2026-09-29）同步進本 repo。

**1. 日誌 API 查不到機台 → 判 SKIP（未驗），不判 FAIL**
- iDeck／觸屏都是點完後查 `daily-analysis` timeline 裡新增的 `success_json`（`is_ideck`／`is_touch`）來確認。
- 原本 API 回錯時（`success:false`、HTTP 錯誤、例外）會被當成「0 筆回應」判 **FAIL**。實測 UAT `4186-SQUIDGAME-0312`：prod／qat 的 daily-analysis 都回 `CMDB未找到机器 4186-SQUIDGAME-0312 的IP`，連同一輪確定成功的 Spin 都查不到，這時的 FAIL 沒有任何證據。
- 改成：API 查不到 → `status: 'skip'`，訊息開頭 `未驗：機台 log API 查不到 <gmid>（<原因>）`。觸屏的前端觀察（`onTouchScreen` 收下幾次、`dealGMActionReq` 送出幾次）照樣附在訊息裡。
- 批次工具（`machine-test-batch.mjs` 的 `judge()`）把 skip 當「未驗」，QA 確認狀態（J 欄）不填。
  - 「不填」＝把 J 欄**清成 null**（v5.15.2）。J 是下拉欄，寫空字串 Lark 會標「資料無效／請選擇下拉式清單中的選項」紅角、畫面卻看起來是空的。
  - J 欄規則（v5.16.0，使用者 1006）：有任一項 FAIL **或待人工確認**（CCTV 編號不符、退出未確認…）→「驗證未過」（verdict 仍寫「待人工確認：…」）；全過 →「驗證通過」；不填只剩舊 agent／已在遊戲內／只跑部分／必驗未驗／少結果。探針 `osm-qa-agent/scripts/machine-test-judge-probe.mjs`。
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

### BZZF 整批實戰後的修正（2026-09-30，v4.261.0）

判定規則由使用者（QA）定案、每條都跟 CodeX 對過；流程都抽在 `verdicts.ts` 並有模擬探針。

**1. 不在 OSMWatcher 監控的機台：退出被 feature 擋住時「盲推」**（`runBlindBurst`，探針 `scripts/blind-burst-probe.ts` 12 案例）
- 原本 tracker 沒有觀測可看，按一下就判「結束」→ 回去試退出 → 約 35 秒才推一下，feature 推不完，期間 agent 斷線整批停擺（BZZF 0254／0243）。
- 改成連續按 SPIN 60 秒（每 5 秒）再試退出。整台上限：96 下／淨扣款 100,000（每下之前先確認剩餘額度夠再付一把，餘額讀不到就停）／20 分鐘；Handpay、停止也停。**任一觸發都停整批、不換台**。
- 定位是**有條件的暫解**：扣款上限成立的前提是單把 ≤ 10,000 且讀到的餘額已反映上一把；算的是淨扣款（中途派彩會抵掉）。

**2. Spin 前的選面額選單閘門**（`runMenuGate`＋runner `spinMenuGate`，探針 `scripts/menu-gate-probe.ts` 10 案例）
- BZZF 停在機台的 CHOOSE A DENOMINATION 時按 SPIN 本來就無效（使用者確認），原本會被誤判成 spin no response。
- 用 `touch-refs/<機種>.png` 參考圖判斷選單是否開著 → 前端選面額、等 10 秒（使用者：約 5 秒內會自己關）→ 還開著就點 18,9 與設定檔觸屏點位（各等 8 秒）→ 都沒關＝觸屏 no response，Spin 不按（skip）。
- 每次判斷都要看到推流 currentTime 前進（停格不算）；操作途中判斷不了 → 整個閘門改判「選單狀態未知」，不判觸屏，照原流程按 SPIN 並在 Spin 結果附註記。
- Spin 期間另外聽 console 的 `moneyNtc begin`，結果附「開局訊號 moneyNtc begin N 次」；批次工具要「餘額沒變＋begin 0 次＋沒有選單未知註記」才判 spin no response。

**3. 會擋操作／汙染截圖的彈窗**
- 預約面板「Want to reserve this machine?」（退出被擋時 Exit 會留下）→ `closeReservePanel()` 點 X `.btn-close`，**絕不點 Reserve Now**。
- 全站 JACKPOT 廣播卡（前端元件 `JackpotNotification`）→ `closeJackpotNotification()` 點 X `.notification-close`，**絕不點 View**（`.view` 會 emit `watchMachine` 跳去中獎那台）；掛在每張截圖前（推流／iDeck／觸屏／CCTV／Preview）。
- 兩者都掛在 `dismissGameTips()` 開頭。

以上都**未在實機觸發過上限／彈窗**（盲推本身有 0259 實測推完退出、閘門有 0266 實測放行後正常開局）。

**4. 重任務鎖綁 session（給批次工具的斷線自動續跑用）**
- `/api/machine-test/start` 建立 session 時呼叫 `bindHeavyTaskOwner(token, sessionId)` 寫進 `heavy_tasks.lock_key`；`/api/heavy-tasks/me` 回傳 `lockKey`。
- 用途：osm-qa-agent 的 `machine-test-batch.mjs` 在 agent 斷線後要清殘留鎖才能續跑，**只有 `lockKey` 等於舊 session 才清**，沒有就停下交人工（不靠時間戳猜）。
- 只是紀錄：孤兒鎖判定（`autospinLockHasLiveOwner`）只對 `autospin-agent` 生效，機台測試鎖的釋放行為不變。
- 續跑流程本身在 osm-qa-agent（不在本 repo），狀態是**模擬驗證完成、待實機驗收**；需要中控部署本版才會真的清鎖。

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

### v5.12.5（CodeX review c189606）
- **[P1] 舊結果污染新測試**：進度事件（`event`，含 machine_done）也要擋——除了是目前連線、自己的 session，**那個 session 還要在跑**（`acceptsEvent` 看 `activeRunners`）。A 斷線取消整輪後 B 還掛著舊 sessionId、收尾時照樣送 machine_done，新一輪已開始的話會混進去、甚至觸發 Lark 回寫
- **[P2] 收尾冪等**：佇列和 runner 都不在＝早就收尾了，`abortMachineTestSession` 直接返回、不廣播（原本仍廣播 error／session_done，會關掉新一輪的監看）

### 測試
- `npx tsx server/agent-lifecycle.test.ts`（21，含跨 session：A 斷線取消第一輪 → 第二輪開始 → B 晚到的事件與晚斷線）：ready 先到／close 先到兩種順序、重複收尾、舊訊息晚到、多 agent 取消
- 突變驗過：拿掉「只做一次」、close 無條件刪 map、重連不收舊連線，各自有對應的測試變紅
- ⚠️ 沒有真 agent 斷線的實測：agent 要用真的 token 連線，本機無法偽造。下次真的斷線時看 log 有沒有「Agent disconnected: …（Agent … 重新連線，舊連線已中斷）」與 session 是否自動結束
- ⚠️ agent 端的修改要 agent「更新程式碼」並重啟才生效
- **待實測（CodeX GATE PASS 33e2379 時要求）**：真 agent 斷線 → 取消後**立刻開新一輪**，確認畫面顯示中斷、其他 agent 有停、重任務鎖有釋放（新一輪能開）、舊的那輪事件沒有混進新一輪

## 機台測試改動合併進 main＋種子檔（v5.15.0）

### 為什麼要合併
0929～1004 的機台測試改動（moneyNtc 開局判定、選單閘門、Occupied／AUDIT MODE、CCTV 判定、iDeck 兩段式…）**一直沒進 main**：
放在 `feat/machine-test-1003`（當時記成 5.2.0，跟 main 的 5.2.0 撞號）＋ osm-qa-agent 本機（10-04 MONEYGONG／COINCOMBO，+170／-9 行）。
正式站是 main 的部署，所以 agent 一按「更新程式碼」就會**退回舊 runner**，v5.12.4/5 的斷線修正也送不到 agent。
2026-10-06 由 osm-qa-agent 發現、CodeX 審合併計畫（先在整合分支驗完才進 main）。

### 合併取捨（三方比對：main／分支／agent 本機備份 `osm-qa-agent/data/agent-source-backup-1006`）
| 檔案 | 用哪一份 | 依據 |
|---|---|---|
| `machine-test/runner.ts` | 分支＋agent 本機那 179 行 | merge-base（75eb753）之後 main 沒碰；agent 那份 10-04 最新 |
| `agent-runner.ts` | main（斷線收尾等待、斷線停 runner）＋分支（`haltReason`、OSM observation） | 兩邊都改；agent 本機那份是 09-24 的舊版 |
| `uat-runner/*` | main | agent 本機那份是 09-21，缺 10-02～10-05 的修正 |
| `menu-gate.json`、`exit-playbook.json` | agent 本機（10-05 學到 COINCOMBO） | |

### 種子檔（`server/agent-seeds.ts`）
選單閘門設定、選單／觸屏參考圖、CCTV 構圖範例圖這類**執行時讀、agent 自己會學會改**的檔案（14 個）。
- **跟原始碼分兩條路**：原始碼（`AGENT_SOURCE_WHITELIST`）伺服器為準、「更新程式碼」會覆寫；種子檔**本機為準，缺檔才寫入**，已有的一律不動（CodeX：勿加入覆寫白名單）
- agent：`ensureSeeds()` 在連上時與「更新程式碼」之後各跑一次；下載後先驗 sha256 指紋才寫。API：`GET /api/machine-test/agent/seed-manifest`、`GET /api/machine-test/agent/seed/<路徑>`（只開放清單內的 key）
- server：開機 `ensureLocalSeeds()`（本機模式也跑 runner）
- `cctv-refs/` 整個被 .gitignore，構圖範例放 `seed-assets/cctv-framing-{good,bad}.png`，送到 agent 時擺回 `cctv-refs/_framing-*.png`。單一來源仍是 `osm-qa-agent/knowledge/machine-test/cctv-framing/`
- 不種：`menu-learn/`（自動學的候選擷圖）、`*-saves/`（執行證據）

### 需重啟清單
`machine-test/verdicts.ts` 只進了下載白名單、沒進 `RESTART_REQUIRED_SOURCES`（CodeX 抓到）——只改它時會顯示最新、記憶體卻跑舊版。
同時補上推導式守門抓到的 5 支（`expr.js`、`dangerous-actions.js`、`pc-node-hittest.js`、`record-window.js`、`ui-popup.js`）——**main 上就已經缺**，不是這次合併造成的。

### 驗證
- 型別、build、`agent-source-closure.mjs`（47 節點）、`agent-version-check.mjs`（23/23，第 6 項推導式守門）
- 分支探針：verdicts 62、blind-burst 12、touch-then-spin 15、menu-gate 11、exit-playbook、bonus-ocr 全過；`agent-lifecycle.test.ts` 21
- 種子檔用**真的 agent-runner**（臨時目錄、`AGENT_LABEL=SEED-TEST`、只連本機）：全新安裝 14 個全補、位元組一致、重連不重寫；既有 agent：本機改過的 menu-gate.json 保留、刪掉的那張圖補回、只補 1 個；注入「拿掉缺檔才寫」→ 本機那份被蓋掉（測得到）
- 臨時 agent 的 42 個原始碼指紋跟 server manifest 一致
- ⚠️ **還沒驗**：正式站部署後，真 agent（CLAUDE-LOCAL）按「更新程式碼」→ 重啟 → 指紋一致、斷線不重複派工——等部署後由 osm-qa-agent 用短批 ARUZE 驗

---

## JP／FG 點選 fallback（v5.17.0，2026-10-06 ARUZE 0335）

**問題**：ARUZE 不在影像辨識監控內，iDeck BET xN 開局可能中 JP（SELECT 元寶，15 顆）或 FG（SELECT A FEATURE，5 張卡），
要**觸屏點**才會往下走；runner 只會「依設定檔推進」按 SPIN，0335 卡住後是現場人工點完的，batch log 也沒有點擊紀錄。

**做法**：機種點位清單放 `server/machine-test/feature-taps.json`（機種＝代碼中段，`873-ARUZE-0321` → `ARUZE`），
**跟 profile 的 `touchPoints` 分開**（觸屏測試還在用那份）。種子檔有 ARUZE 一份（agent 缺檔才寫入）；
osm-qa-agent 的 `knowledge/games/<機種>/automation/machine-test.json` 可放 `featureTaps` 區塊，batch 開跑前會同步過去（有 machine-test.json 的機種以它為準）。

```json
{ "ARUZE": { "waitMs": 3000, "minChange": 0.05,
  "groups": [ { "name": "JP 元寶", "taps": ["3,3", "6,3", "…"] }, { "name": "FG 卡片", "taps": ["2,4", "…"] } ] } }
```

**觸發點**（只對清單裡有的機種）：
- **iDeck**：按鍵開局後 45 秒沒等到 moneyNtc end → 逐格點，最多 3 分鐘；iDeck 按鍵本身仍不補點。結果訊息附「JP／FG 觸屏推進 N 下（3,3→無、6,3→結束）」
- **退出**：被擋且有遊戲進行中證據 → 先點清單（每格最多點一次），有進展後 60 秒內不再點、走原本推進流程；清單點完都沒進展就只走原本流程。`auto_wait` 機種不點

**每一格**：點之前截圖 → 點 → 等 `waitMs` 看 moneyNtc end（＝結束，停）→ 沒結束就比畫面變動，比「點之前兩張的雜訊」多出 `minChange` 以上＝畫面有進展（例：選完 FG 卡），停；
否則點下一格（JP 翻一顆元寶畫面只動一小塊，正好繼續點下一顆）。每一下都 emit「點觸屏 x,y（群組）→ 有／無進展｜畫面變動 x%（雜訊 y%）」。
流程在 `verdicts.ts runFeatureTaps`，探針 `npx tsx scripts/feature-taps-probe.ts`。

⚠️ `[unverified]`：`feature-taps.json` 的座標與 `screenText` 關鍵字都**還沒在真的 JP／FG 畫面點過**；JP 結束後是否還要按 SPIN／TAKE WIN 待確認。**下次 ARUZE 自然觸發 JP／FG 時驗**（看 log 的 🎯 OCR 命中／「OCR 沒看到」與每一行「點觸屏 x,y」）。
使用者 1006 決定不等 0335 真機（JP 無法隨時觸發）就合進 main（v5.17.3）；CodeX 原本的條件是真機驗過再合，已告知這是使用者的決定。

### 決策紀錄（CodeX 1006 review，v5.17.1 補）

- **iDeck 逾時後改點觸屏是例外**：0929 的規則是「開轉逾時後不可再點任何東西」。CodeX 只同意**確認處於 JP／FG 選擇畫面**時例外——
  單靠 45 秒逾時不夠。做法：每一輪先截整頁跑 Gemini Vision OCR，命中 `feature-taps.json` 的 `screenText` 關鍵字（ARUZE：MATCH 3／JACKPOT LEVEL／SELECT A FEATURE／FREE GAMES FEATURE）才點；
  **讀不到字、沒命中、OCR 失敗一律不點**。沒設 `screenText` 的機種整份不啟用。退出路徑同一道關卡，每台最多 OCR 5 次。
  iDeck 按鍵本身仍然不補點。
- **畫面變動只是「暫停觀察」訊號**，不能證明進了 FG（整頁比對、雜訊只量一次、門檻未校準）。退出路徑有進展後的 60 秒內**所有推進都不做**（SPIN、觸屏、盲推），只重試退出。
- **量不到就停手**：點之前或點之後截圖失敗＝`unsure` → 立刻停止點觸屏、emit 🆘 交人工；不能把缺圖當成「沒變化」繼續點。
- **每一下點之前再查一次**結束（moneyNtc end）／停止／時限，查到就不點。
- **退出路徑每一輪怎麼推只聽 `verdicts.ts planExitAdvance`**（CodeX 第二輪 P1，v5.17.2）：
  `handOff`（觸屏推進量不到）→ **結束本台自動操作**、退出測試回 FAIL「待人工確認」並設 halt（batch 換帳號），不再落入 SPIN／盲推；
  `hold` → 只重試退出；`featureTap` → 跑一輪；`legacy` → 原本推進流程。
- 退出路徑每一下點之前的 guard ＝ 停止 **＋整台時限（EXIT_MAX_MS）＋動作上限（EXIT_MAX_ACTS，含這一輪已點的）**。
- **unsure 當輪就 FAIL＋halt**（CodeX 第三輪 P1，v5.17.3）：不能 `continue`——下一輪會先跑 `stepExit`（點 Cashout／Confirm），
  可能直接回 PASS，或進 retry 分支套手冊動作，繞過待人工確認。`applyFeatureRound` 對 unsure 回 `then: 'handOff'`，runner 當場 return。
- **觀察期也擋手冊**：沒有遊戲進行中證據的 retry 分支，在累計連續失敗與套手冊（exit-playbook）**之前**先查 `inFeatureHold`，觀察期內只等、不累計、不 halt。
- 探針 `scripts/feature-taps-probe.ts` 27 項。退出迴圈模擬照 runner 的**實際順序**（stepExit → retry／手冊 → 遊戲進行中推進），
  判定函式與 runner 同一支、迴圈膠水照抄——證明的是這個順序下不會繞過，runner 真實行為仍要 0335 真機驗。
  注入：unsure 改回 `retryExit`（804b0e8 的寫法）紅 2 條；觀察期失效紅 3 條。

## 證據上傳的 Lark Drive 資料夾（v5.28.1，2026-10-06 使用者經 claude-osm-3 要求）

- `scripts/machine-test/machine-test-batch.mjs` 的 `uploadDrive()`：`parent_node` 原本是空字串＝應用程式自己的根目錄（畫面上是「Casino Plus x IGO › 自动通知机器人」），改成 `CFG.driveFolder`
- 設定順序：環境變數 `MT_LARK_DRIVE_FOLDER` ＞ `machine-test-secrets.json` 的 `larkDriveFolder` ＞ 預設 `InhAftoJglxUzjdrYonl6a2bgBd`（使用者指定的資料夾）
- 實測（machine-test 的 Lark 應用程式）：`upload_all` → code 0（claude-osm-3 測）；**分片**（>20MB，upload_prepare／part×6／finish）21MB → 全部 code 0，tenant_readable 也成功（claude-toppath 測，用的是同一串 API 呼叫的獨立腳本，不是直接呼叫 uploadDrive）
- 限制：應用程式沒有 `drive:drive`，讀不到資料夾 meta、**刪不掉**資料夾裡的檔案（只能上傳）。測試留下的檔案要人手動刪

## 機台餘額只用機台內的值＋未監控機台疑似特殊遊戲（v5.29.0，2026-10-07）

規格：`osm-qa-agent/reports/spec-mt-feature-detect-balance-1007.md`（claude-osm-3 整理、主使用者 10/07 核准「1跟2不做，其他都做」）。做法 CodeX 定案（Discord 10/07）。

### B. 餘額
- **根因**：`PINUS_TRACKER_SCRIPT` 把 `pinus.request` 任何回應、`pinus.on` 任何推播，只要帶 coin 就寫 `__lastCoin`——退出時伺服器回的大廳錢包把機台餘額蓋掉（證據 `osm-qa-agent/reports/aruze-0330-balance-evidence-1006.txt`：before-quit 2,000,000 → end 31,566,687,267.61；0330 盲推關卡算成「已少 315 億」停批）
- tracker 另存 `__lastMachineCoin`／`__machineCoinAt`／`__moneyLog`（seq、coin、reason、ts），**只在 `pinus.on` 且 route＝moneyNtc** 更新（跟 AutoSpin `toppath-agent.py` 同一套）；`__lastCoin` 不動
- `readMachineBalance`：遊戲 iframe 的 `__lastMachineCoin` → Tips「Cash out credit: N」（`parseCashOutCredit`）→ null。舊的 `readBalance` 移除
- Spin：前後餘額、每下「有沒有新 moneyNtc」都改看機台內；**Spin 前還沒有機台餘額**（剛進機台沒開過局）不退回其他來源——本次有 begin 且有 end → pass、訊息寫「餘額變化未驗」（CodeX）
- 盲推扣款關卡、`extraSpinDecision`、退出紀錄（exitSnap）全部改讀機台內餘額；讀不到照舊停
- 盲推合理性（`runBlindBurst`）：跟上一次讀值比，**少掉**的超過「單把估價 × 期間按的次數 × 2」→ 停手、訊息「待核對」（可能讀錯，不說是資料汙染）；**變多不擋**（JP 大額派彩）——CodeX：扣款與派彩分開判，不取絕對值
- 驗證：`npx tsx scripts/machine-coin-tracker-probe.ts`（假 window 跑注入腳本，重放 0322／0324 順序：錢包回應後機台餘額仍是 200 萬、__lastCoin 被蓋證明情境重現）；突變「拿掉 route 過濾」紅。`blind-burst-probe` 加 3 條（派彩變多照推、一次少到 0 停手待核對、剛好在範圍內不擋）

### A. 疑似特殊遊戲
- 判斷（`verdicts.ts openRoundTrigger`）：OSMWatcher 沒這台或狀態 0；進機台之後有 begin；最後一筆是 begin；超過 **35 秒**（`OPEN_ROUND_SUSPECT_MS`）。35 秒的依據：claude-osm-3 從 9 份 batch log 配對 1354 局，p50 0s、p95 5s、最長 28s（ARUZE）；規格原本 20 秒會誤觸發
- 處理（`superviseOpenRound`，runner 的 `makeOpenRoundHandler`）：關 Tips／面額（含 Handpay 偵測）→ 有點位清單走 `featureTapRound` → 否則 bonusAction（touchscreen 點 touchPoints；spin 要 OCR `classifyBonusText`＝spin 而且距上一則 moneyNtc ≥ 8 秒才按）→ 2 分鐘沒進展救援一次（`bonusStallRescue`）。結束條件：收到**綁定那一筆 begin** 之後的 end
- 安全：每一下實際點擊前重查 end（關遮罩後、OCR 後都查）；沒有 begin 不啟動；上限 8 分鐘／60 次操作，到了 stalled；停止／Handpay 即停。CodeX：N 秒只能節流不能保證，所以 SPIN 另外要畫面證據，沒有就等
- 掛的位置：`checkOsm()`（每個步驟之前，含退出前）——未監控時先看有沒有開著的局，處理完記一筆「特殊遊戲等待」；iDeck 開局 45 秒沒結束時（未監控）改走處理器，收到 end 後該顆記「有開局（觸發特殊遊戲）」、繼續下一顆（原本 spinTimeout 整段中止）。OSMWatcher 有監控的機台照舊
- 驗證：`npx tsx scripts/open-round-probe.ts`（19 條：關遮罩／OCR 途中收到 end、畫面回普通局不按、節流、上限、點位、觸發條件…）；突變「拿掉 SPIN 前 end 重查」「拿掉關遮罩後與觸屏前重查」「拿掉沒訊號不啟動」各自紅
- **CodeX 審 2d513b6（v5.29.1 修）**：
  - [P1] `classifyBonusText` 把普通局的「PRESS PLAY TO SPIN」判成 spin → end 漏送時會再下注。改用 `openRoundScreen`：除了 spin 指示還要有特殊遊戲字樣（FREE GAMES／FREE SPINS／SPINS REMAINING／RE-SPIN／BONUS／FEATURE／JACKPOT），沒有就當看不出來、不按
  - [P1] 內層點擊缺即時防護：`doTouchPoints` 一次點完整串、救援只看快取。改成觸屏逐格點、每一格前 `endedNow()` 重讀流水＋停止狀態；按 SPIN 前最後再重讀一次；同步檢查（featureTapRound）用背景每 250ms 重讀的旗標。**拿掉卡住救援**（`bonusStallRescue` 用 classifyBonusText 決定按 SPIN，普通局也會按），卡住就 stalled 交人工
  - [P1] stalled／Handpay／停止只記 warn、後面照跑。改成 `stepGate`：之後每一步（含退出）都不做、記「未執行：疑似特殊遊戲未結束，已停止所有自動操作」，設 `_haltReason`（batch 換帳號／停批，同退出卡住）；同一局再問直接回快取結果，不重跑 8 分鐘
  - [P2] 60 次算實際點擊：featureTaps 用 onTapped 逐下計、觸屏逐格計，一輪多下都算
  - 實際 runner 路徑探針 `npx tsx scripts/open-round-runner-probe.ts`（跑真的 `makeOpenRoundHandler`，只換假 Page）：普通局畫面不按且 stalled、同一局再問直接回、特殊遊戲畫面按到 end 為止且 end 後 0 下、逐格觸屏第 1 格後收到 end 第 2 格不點、上限 3 只點 3 下、沒 moneyNtc 不啟動。突變「改回 classifyBonusText」「觸屏不逐格重查」各自紅
- **CodeX 審 35d17c9（v5.29.2 修）**：
  - [P1] 證據仍太寬：普通局有獎池看板「JACKPOT」、結算「BONUS COMPLETE TOTAL WIN」都按了。`openRoundScreen` 改成：結算字樣（total win／bonus complete／congratulations／collect…）→ wait 不按；spin 指示之外要有**計數器**（FREE GAMES 3／3 SPINS REMAINING／RE-SPINS: 2／SPINS LEFT 5），JACKPOT／BONUS／FEATURE 單獨出現不算
  - [P1] `nativeClick` 原生 click 逾時期間收到 end，接著 force 仍點。改用 `guardedClick`：原生／force／滑鼠每一種之前都 await `mustStop()`（重讀流水＋停止）；`featureTapRound` 加選填 `mustStop`，每一下點之前 await，拿掉 250ms 背景旗標
  - [P1] 停止時 gate 放行。抽成 `verdicts.ts stepGateBlock`：halt（疑似特殊遊戲沒結束）→ 全擋含退出；使用者停止 → 測試步驟擋、**退出照舊試**（沒有開著的特殊遊戲時，exitUntilLobby 依停止狀態收尾，不然帳號留在機台）；停止造成的 openRound 'stopped' 也設 halt
  - 探針：open-round 31 條（含關卡 5 條、畫面證據 6 條）、runner 路徑 9 條（含 JACKPOT 看板、結算畫面、原生 click 逾時期間收到 end）。突變「重試前不重查」「證據回到寬鬆」「拿掉停止擋」各自紅
- **CodeX 審 4c320d4（v5.29.3 修）**：
  - [P1] 計數器接受「0 SPINS REMAINING」→ 按了。改成取出計數器的數字，**至少一個 > 0** 才算局中；全是 0 → wait
  - [P1] 重查之後還隔著非同步查詢：取 `boundingBox` 期間、觸屏 `frame.$$` 查元素期間收到 end，仍點下去。`guardedClick` 改成只有一種點法：取座標 → `mustStop()` → 立刻 `page.mouse.click`（原生 click 有自動等待、無法在中間重查，拿掉）；`clickTouchCell` 加選填 `mustStop`，找到元素後、點之前重查
  - 停止：CodeX 接受「停止後只試退出、不再推進」；halt 仍全擋。停止會立刻關瀏覽器，退出可能沒做完——沿用既有「使用者中止：未確認已離機」的結果
  - 探針：open-round 33、runner 路徑 11（含 0 SPINS REMAINING、取座標期間 end、查元素期間 end）；突變「取座標後不重查」「觸屏查到後不重查」「0 次也算」各自紅
- **CodeX 審 edd347b（v5.29.4 修）**：[P1] `mustStop` 只在讀流水前看停止，讀的期間按停止、又沒收到 end 會放行。改成 `stop() || await ended() || stop()`。runner 路徑探針加 12 條（SPIN／觸屏 × 第 1～6 次讀流水期間按停止 → 停止後 0 下）；突變「讀完不再看停止」SPIN、觸屏各紅一條
- ⚠️ 還沒真機驗；runner 改了，本機 agent 要「更新程式碼」


## 提示框處理（v5.30.0，2026-10-07）

規格：`osm-qa-agent/reports/spec-mt-popup-handling-1007.md`（claude-osm-3 整理）。做法 CodeX 定案（Discord 10/07）。

### 辨識與處理分開
- **辨識**（共用，UAT 之後也可用）：`server/uat-runner/popup-catalog.js`
  - `POPUP_CATALOG`：依文字辨識 bonus-15min／cannot-quit／reserve-panel／quit-wait／cashout-credit／game-exception／other-device／conn-timeout／lhb-transfer／no-machine／no-permission；錯誤碼 entry-1044／entry-10006 要有「error／code／錯誤」字樣，避免餘額裡剛好有 1044 被認錯；依元素辨識面額 `.select-main`、`.closeBtn`、`.recommend`
  - `NEVER_CLICK`：Reserve Now／JP 卡的 `.view`／Play Now／機台裡的 Join／`.header_btn_item_return`／充值框的 Confirm。selector 類只在提示框裡才算。Join 標 `inMachineOnly`，因為大廳選機台本來就要按它
  - 加 agent 白名單（`AGENT_SOURCE_WHITELIST`）
- **處理**（機台測試）：`verdicts.ts` 的 `MT_POPUP_POLICY`／`decidePopup`，分成測試中與退出兩個階段
  - ack 按 Confirm，只限命中那個框裡的鍵
  - close 按 X 或面額
  - wait 不動
  - stop 分兩種範圍：account（別處登入）跟 machine（AFT error／game exception／offline／進場錯誤碼）
  - 沒命中的一律 unknown。cashout-credit 只有退出時才按；測試中出現代表誤觸，當 unknown 處理

### 執行（runner.ts `PopupGuard`）
- 進機台成功後掛上 guard，每 2 秒掃所有 frame
- close／ack 只在**操作鎖**裡點，點之前重查框和鍵還在，然後點中心一次真滑鼠
- stop／unknown 只記錄、截圖（`popup-saves/`，每台最多 20 張），並**立刻擋遊戲操作**。unknown 的 30 秒只是結案門檻
- 擷取步驟（推流、Spin、音訊、CCTV）期間暫停背景掃描，結束立刻補掃
- 每步之前（`stepGate`）同步掃一次，再交給 `popupStepBlock` 判斷：
  - account → 這個帳號連退出都不做，`_haltReason` 寫「帳號無法繼續使用（換帳號）」，batch 的 `STUCK_RE` 會換帳號續跑
  - machine 或 unknown 滿 30 秒 → 記「提示框」fail 步驟，測試步驟跳過、退出照走
- **所有點擊都收斂到 `uiAct(page, kind, label, el, fn)`**，kind 分 game／exit／popup／lobby：
  - game 在有 stop／unknown 時回 `'blocked'`
  - 命中禁點回 `'blocked'`
  - 在操作鎖裡執行
  - 逾時錯誤會補上 `elementsFromPoint` 前三層，說明被誰蓋住
  - 回 `'blocked'` 時呼叫端不得當成功，也不得改用 force 或座標再點。`nativeClick` 會整串停下、回 `'blocked'`
- 例外（頁面內 `.click()`，不經 uiAct）：`closeJackpotNotification`、大廳預覽的 SAFE close、面額 YES、CCTV 頁面內 Confirm、guard 自己的 `clickLocatorCenter`
- **第二層**：`context.addInitScript(NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED)`
  - 在 window capture 攔 pointer／mouse／touch／click 各階段，用 composedPath 找目標
  - 命中禁點就 preventDefault＋stopImmediatePropagation，記到 `__mtBlockedClicks`
  - uiAct 會比對 fn 前後的計數，有增加也回 `'blocked'`
  - Join 規則要 runner 設 `window.__mtInMachine`（attach 時設，每次掃描補設給新載入的 frame）
  - canvas 畫出來的按鈕認不到，所以只能當第二層
- batch：`popupVerdict` 讀「提示框」步驟。account in use 不算機台結果（J 欄留空）；其他提示框判定寫「驗證未過」，摘要優先顯示

### 驗證
- `npx tsx scripts/popup-handling-probe.ts`：51 條，純函式加真瀏覽器。用 page.route 真導頁；不要用 setContent，它的 document.open 會清掉 window 監聽器
- 每條都看遊戲 handler 有沒有真的跑（`window.__ran`）
- 涵蓋：
  - 預約面板只按 X
  - 未知框一顆不按、截圖、擋 SPIN，click／nativeClick／觸控都擋
  - Play Now 五種點法都擋，繞過 uiAct 的滑鼠和觸控也被頁面內層擋
  - Join 大廳可按、機台裡兩層都擋
  - 逾時訊息帶出 `.mask-layer`
  - 暫停期間不點、恢復就補掃
  - 遊戲點擊進行中背景不會插隊
  - 別處登入 → 換帳號
  - cashout-credit 只在退出時按
- 這支探針抓到一個真 bug：`(g?.note ?? …)(...)` 會丟掉 this
- 突變：見 commit 訊息
- ⚠️ 還沒真機驗；runner 改了，本機 agent 要「更新程式碼」

### CodeX 審 56e3d1b（v5.30.1 修）
- [P1] **面額框會死鎖**：scan 拿著鎖呼叫 `dismissDenomOverlay`，它裡面的 `uiAct` 又去等同一把鎖，連退出都卡住。修法：
  - `PopupGuard.withLock` 改成可重入，用 AsyncLocalStorage 判斷是不是同一串呼叫
  - `startWatch` 的計時器用 `held.exit()` 建立，不會繼承呼叫當下的鎖
- [P1] **退出時在整頁找 Confirm，可能按到未知框**：`uiAct` 的 exit／popup 類點擊加了 `unrecognizedBoxBlock`：
  - 按鈕所在的最外層框，必須是已辨識、而且這個階段可以按的（ack／close）
  - unknown 框、stop 框都不按
  - 按鈕不在框裡、但畫面上有未知框時，Confirm／OK 類也不按
  - 讀不到框資訊時，只要畫面有未處理的框就不按（fail closed）
  - 實際退出時的 Confirm 在「Tips｜Cash out credit」框裡，這個框已在目錄（batch log 892-COINCOMBO 退出紀錄可證）
- [P2] **未知框未滿 30 秒就進退出，判定永遠不會記**：新增 `settleUnknown`，退出前每 2 秒重查，直到框消失、滿 30 秒或使用者停止
- 例外收斂：
  - 面額 YES 改走 uiAct，被擋就停
  - 大廳的 SAFE close 只關中獎廣播卡（卡片裡要有 `.view`／PLAY NOW／JACKPOT）
  - CCTV 前的 Lucky hour bonus 改走 `scan`（lhb-transfer，Confirm 限定在框裡）
- ⚠️ **坑**：頁面內函式（`el.evaluate(fn)`）不要在 runner.ts 裡寫具名箭頭函式。tsx 會把它包成 `__name(...)`，頁面裡沒有 `__name`，evaluate 一丟錯就被 catch 吞掉，整個檢查靜默失效。這次就踩到了，所以 `ELEMENT_BOX_INFO_IN_PAGE` 改放在 popup-catalog.js
- 探針增加到 63 條：死鎖、面額兩階段、未知框和 stop 框的 Confirm、框外 Confirm、退出前等未知框（消失／滿 30 秒／停止）、鎖裡啟動的計時器不插隊、Lucky hour bonus 只按自己的框
- 突變 5 條全紅：鎖不可重入、退出不限框、計時器繼承鎖、退出前不等、框資訊改回 TS 內聯

### CodeX 複審 c3831fe（v5.30.2 修）
- [P1] 讀不到框資訊時，原本只有在 guard 已經記到 unknown／stop 才擋。新框可能還沒被掃到，所以 exit／popup 類點擊**讀不到就一律 blocked**，沒有元素也一樣
- [P2] 原本只排除 unknown／stop，wait 框（Quit game, please wait）的 Confirm 仍會按。現在**只放行 ack／close**
- 探針 66 條：換頁後的舊 handle、沒有元素、wait 框的 Confirm
- 突變 2 條全紅：讀不到資訊時改回看 guard、wait 放行
- 注意：CCTV 前關遮罩用的 `[class*="bonus-popup"]` 這類 class 含 popup 的框會被當成提示框。沒辨識出來的不再點（v5.30.1 起就是這樣），CCTV 可能因此被中獎動畫擋住，要真機觀察

### CodeX 審 19d3b6b：GATE PASS（v5.30.2 的 P1／P2），CCTV 清遮罩收斂（v5.30.3）
- CodeX 認為 CCTV 遇到**辨識不出的遮罩就不點**是對的，這輪可以接受「被遮擋、未驗證」。要提高完成率，之後再補明確的中獎遮罩辨識和專用的關閉動作，一樣要走同一把鎖和 guard
- 清遮罩的部分抽成 `clearCctvOverlays`，方便探針測：
  - 關閉鍵只在**這個遮罩裡**找。原本找不到就搜整個 frame，可能按到別處的關閉鍵
  - 任何一下被擋（點遮罩本體也算）就立刻停：不記「已 force-click」、不送 Escape，回 blocked
  - stepCctv 收到 blocked 就記 skip「未驗：CCTV 畫面被未辨識的遮罩擋住」，存一張證據截圖，不拿被擋住的畫面去比號碼
- 探針 68 條：未辨識的 bonus-popup 加上框外的關閉鍵 → 零操作、沒有 Escape；一般遮罩（div.bg）→ 按它自己裡面的關閉鍵
- 突變 2 條全紅：恢復搜整個 frame、本體被擋照樣往下
