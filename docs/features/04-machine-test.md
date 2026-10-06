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
  - 「不填」＝把 J 欄**清成 null**（v5.16.1）。J 是下拉欄，寫空字串 Lark 會標「資料無效／請選擇下拉式清單中的選項」紅角、畫面卻看起來是空的。
  - J 欄規則（v5.17.0，使用者 1006）：有任一項 FAIL **或待人工確認**（CCTV 編號不符、退出未確認…）→「驗證未過」（verdict 仍寫「待人工確認：…」）；全過 →「驗證通過」；不填只剩舊 agent／已在遊戲內／只跑部分／必驗未驗／少結果。探針 `osm-qa-agent/scripts/machine-test-judge-probe.mjs`。
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

## JP／FG 點選 fallback（v5.16.0，2026-10-06 ARUZE 0335）

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

⚠️ `[unverified]`：座標還沒在真的 JP／FG 畫面點過；JP 結束後是否還要按 SPIN／TAKE WIN 待確認。
