# 35. API 參數紀錄（ApiCapturePage，v5.90.0）

> 2026-11-18 使用者需求：之後要上「獨立 OSM TP 系統」，要逐支 API 對參數。使用者拍板方案 A（照 CodeX 設計圖全做，含比對）。
> 參考實作：osm-qa-agent `reports/cp-level-1113/`（11/13 QAT 9421000006 機台 144 實跑成功）。架構 CodeX 定案（下面「架構」那段不要再改方向）。

**路由**：`/api/api-capture/*`（掛在 worker，main 用 proxyToWorker 轉）　**權限 key**：`api-capture`　**歷史 key**：`api-capture`

## 功能說明
指定帳號（大廳連結）→ Local Agent 開 OSM 大廳 → 進指定機台 → 用預設（最小）面額一直 Spin 到停止條件（有派彩／固定局數；另有最多局數上限）→ 退出機台放掉位子。
過程中錄前台 WebSocket（原始幀＋遊戲 console 解碼後的 pinus SEND/ON）與 HTTP（xhr/fetch）。
前台結束後 server 打 OSM 後台查**同帳號同時段**的 Log Third Http Req 與 Log Third Bet Req（API 回的就是 Show Details 的完整內容），
時間校正後彙整成時間軸，算出每支 API 的參數簽名，跟「上一次」比對，可匯出 Excel。

## 架構（CodeX 定案）
1. **前台錄製走 agent-hub 派工**（同 AutoSpin／機台測試），agent 本機 Playwright；Spug server 不開瀏覽器。
   - agent 端：`server/api-capture/front-runner.ts`（agent-runner 靜態 import，已加進 `AGENT_SOURCE_WHITELIST` 與 `RESTART_REQUIRED_SOURCES`；連帶 `types.ts`／`mask.ts`／`parse.ts`）
   - agent 能力 `api-capture`（`AGENT_CAPABILITIES` 預設值）。**舊版 agent 沒有這個能力**：要按「更新程式碼」並**重開 agent**，開始時會明講「版本太舊」
   - 協定：server → `api_capture_start`／`api_capture_stop`；agent → `api_capture_progress`、`api_capture_chunk`（每批 ≤200 筆，每 3 秒＋每局送一次）、`api_capture_done`（帶總筆數與批數，server 核對有沒有掉批）
2. **後台日誌由 server 端打後台 API**：`/auth/login`（code 20000 → token，header 帶 `token`／`lastlogintime`；40200 重新登入一次）→
   `POST /log/logThirdHttpReq`、`/log/logThirdHttpBetReq`（userName＋channelId＋時間區間，pageSize 100 分頁到底）。
   **任何一頁失敗、筆數跟 total 對不上、撞到 50 頁上限、登入失敗 → 標「不完整」**，不會當成功。
   - 後台帳密：管理員在頁面右上「後台設定」輸入，存 settings（`api_capture_backend_<env>` 放網址／帳號／渠道，`api_capture_backend_<env>_password` 放 **AES-GCM 密文**，也列進 `SECRET_SETTINGS_KEYS`）。密碼不回傳畫面，留空＝沿用
   - QAT 預設：`https://backendservertest.osmslot.org`、Origin `https://qat-cp.osmslot.org`、渠道 873（11/13 實跑驗過）
   - **UAT 預設：`https://uat-backendservertest.osmslot.org`、Origin `http://uat-cp.osmslot.org`、渠道 4186——取自 OSM QA 記憶（gameRecordList 實測過），Log 端點沒實測過**，畫面有標「尚未實測」
3. **鎖**：重任務鎖（`tryStartHeavyTask(req,'api-capture')`，綁 runId）＋本功能自己的機台鎖／帳號鎖（**含環境**：`qat|machine|144`、`qat|account|9421000006`）。
   正常結束（agent 送 `api_capture_done`）才放鎖。**「沒確認 agent 停下來」一律進隔離**（CodeX 1118 兩輪 [P1]：`stop()` 只是旗標、斷線也不代表停了）：
   - 逾時（60 分鐘，局數上限 300）與取消：先送 `api_capture_stop`，90 秒內沒回報 → 隔離
   - agent 斷線（worker `onLost` 的 `ac_` 分支）→ 隔離
   - worker 重啟：前台還沒結束的紀錄（`running`）→ 隔離；已在查後台的（`collecting`）→ 只標失敗
   - **隔離**＝紀錄標失敗、`quarantined=1` 存 DB，**機台／帳號鎖與重任務鎖都保留**（重啟時從 DB 復原），只有三種情況放：
     agent 送來這筆的 `api_capture_done`；這台 agent 重新連線、`agent_ready.apiCaptureActive` 回報手上沒有這筆（回報「還在收尾」就繼續等它的 done）；
     畫面按「人工確認已停止」（`POST /runs/:id/release`，本人或管理員）
   - 舊版 agent 不送 `apiCaptureActive`：重連也不放，只能人工確認
   - worker 重啟時，**不屬於隔離紀錄**的 `api-capture` running 重任務鎖用 `releaseHeavyTaskById` 放掉（重任務鎖會從 DB 復原，沒放會一直擋人）
   ⚠️ 機台鎖只擋「本功能自己」重複用同一台；機台測試在 Toppath 這邊沒有機台層級的鎖可以共用（它只有重任務鎖），同一個人同時開兩種重任務會被重任務鎖擋掉
4. **資料**：
   - `api_capture_runs`：env、channel_id、account、machine、machine_key（比對用，`DFDCGRAND-144`／`144`）、lobby_url_masked、停止條件、agent、task_id（重任務鎖 id）、狀態、階段、開始／結束、前台起訖（agent 時鐘）、`time_calibration`、`completeness`、`baseline_run_id`、`signature`（參數簽名 JSON）、`summary`
   - `api_capture_events`：前台事件（step／ws／console／http），一筆一列
   - `api_capture_backend`：後台日誌，`in_window` 標是否在前台時間窗內（窗外的保留、不列入時間軸）
   - 事件明細保留 180 天
5. **比對**：預設基準＝同環境＋同渠道＋同帳號＋同機台、比這筆早、狀態「完成」的最新一筆；沒有就顯示「無基準」；可下拉選任一筆歷史。
   以 **API＋方向＋request/response 巢狀路徑** 比對（陣列用 `[]`），分「新增／缺少／型別變更／值變更」；
   時間戳、流水號（key 像 time/timestamp/reference/roundId/transactionId/hash/token/_id，或值像 13 位毫秒、24 位 ObjectId）**只忽略值**，存在與型別照樣比；
   基準有、這次沒錄到的 API 標「**未觀測**」，不算刪除；這次多出來的 API 標「新 API」。
   參數簽名有格式版本（`SIGNATURE_VERSION`，目前 2）：比對時遇到舊版本，從 DB 裡的原始事件重建再存回，不拿舊格式直接比（CodeX 1118 [P2]）。
   **原始事件已過 180 天保留期被清掉時不重建**（重建出空簽名會把舊的蓋掉、之後全報未觀測），保留舊簽名、畫面與 Excel 標「無法跨版本比較」、不出差異（v5.90.3，CodeX 1118 [P2]）。
   比對對象：後台每個 event（authenticate／balance／recharge／recordBet…）、前台 HTTP（排除雜訊與靜態檔；送出參數＝`request.query.*`＋`request.body.*`，v5.90.1 起含網址 query）、前台 WS route（console 的 SEND/ON，`ON: 0` 是推播）。
6. **遮罩**：`server/api-capture/mask.ts` 一支，agent 送出前、server 落盤前、匯出 Excel 前各過一次。OSM 玩家 token（`32hex-uid`，含網址編碼後的 `%3D…`）、後台登入 token、JSON／網址／console 裡的 token、password、privateMapKey 等一律 `***`。
   前台 HTTP 預設把 GA、xtrace（阿里雲 RUM）、posthog、RTC 等第三方當雜訊：照樣保留但內容截短、畫面與 Excel 預設不顯示、不進比對。

## 時間校正
agent 本機時鐘常常不準（本機慢 160 秒那次）。順序：
1. **recordBet 對齊**：前台每局 moneyNtc end 的時間 vs 後台 recordBet 的 reqtime，**依順序**嘗試每種位移（不用「找最近一筆」——一局 4 秒、時鐘可能差幾分鐘，最近那筆常是隔壁局）。
   排序：先比「局識別」——前台每局派彩（moneyNtc end − begin）要等於 recordBet 的 payout，對不上的位移扣分；再比差值集中度。誤差 > 3 秒不採用。
   **歧義**（局距均勻、派彩都是 0，多種位移一樣吻合）：用 agent↔server 時差挑最接近的，且要明顯比第二名近；挑不出來就退回伺服器時差／不校正，**不能隨便選最早那個**（v5.90.1，CodeX 1118 [P2] 重現：實際時差 0 卻採 −60 秒）
2. 退而求其次：`api_capture_done` 收到當下的 server 時間 − agent 時間（假設 server≈後台）
3. 都沒有：未校正
時間窗：校正後的前台起訖，前緣留 10 秒（recordBet 校正時；只有伺服器時差時留 60 秒）、後緣留 120 秒。窗外的後台日誌保留在 DB、不列入時間軸與比對——1113 那次前面 3 次找不到機台的重試所產生的 authenticate 就是這樣排掉的。
1113 fixture：offset ≈ +183.7 秒、4 局誤差 < 1 秒（跟 osm-qa-agent 當時手算一致）。畫面進度列與 Excel 說明頁都會寫用了哪一種。

## 狀態
`running`（前台錄製）→ `collecting`（查後台）→ `done`／`incomplete`（前台或後台任一不完整、或完全沒校正）／`failed`／`cancelled`。
只有 `done` 會被當成預設比對基準。

## Excel（四分頁）
時間軸（後台時鐘 UTC+8、動作、API、方向、送出、回傳、來源）／前台WS（原始幀＋已解碼 console）／前台HTTP（預設不含雜訊，可勾選）／說明（紀錄資訊、校正、完整性、**比對摘要與逐項差異**）。單格截 32000 字。

## 使用者可執行的操作
| 操作 | 說明 |
|---|---|
| 選環境 | QAT／UAT |
| 填帳號 | 貼含 token 的大廳連結或按「帳號池」挑；帳號＝連結的 `username`（後台以此查） |
| 填機台 | `144`、`DFDCGRAND-0144`、`873-DFDCGRAND-0144` 都可（873 是渠道不是機台號） |
| 停止條件 | 有派彩／固定局數＋最多局數 |
| 渠道、Local Agent、顯示瀏覽器視窗 | 渠道留空用後台設定的預設；agent 留空自動挑自己的空閒 agent |
| 開始新紀錄／取消這筆 | 取消會讓 agent 退出機台放位子，已錄到的內容保留 |
| 看本次紀錄 | 時間軸／前台 WS／前台 HTTP／說明，點時間軸一列看完整送出／回傳 |
| 切換紀錄 | 「本次紀錄」右邊下拉選歷史紀錄 |
| 與上次比對 | 基準下拉、忽略時間戳／流水號值差異勾選、逐 API 卡片展開 |
| 匯出 Excel | 依目前的基準與勾選匯出 |
| 後台設定（管理員） | 各環境後台 API 網址、Origin、預設渠道、帳號、密碼 |

## 驗證
- `npx tsx server/api-capture/core.test.ts`（78 項，含 CodeX 1118 的兩個重現：均勻局距歧義、HTTP query 變更）：遮罩、機台輸入、時間校正（1113 fixture）、時間軸、參數簽名、**注入差異**（新增／型別變更／缺少／時間戳忽略／新 API／未觀測）、Excel 四分頁與遮罩、後台分頁（假 fetch：分頁、total 不符、某頁失敗、登入失敗、40200 重登）
- 突變（`.tmp` 腳本，跑完還原）：拿掉比對邏輯 8 紅、型別混成值 1 紅、未觀測當缺少 3 紅、時間戳不忽略 1 紅、時間校正失效 6 紅、歧義選最早 3 紅、HTTP query 不進比對 1 紅、遮罩拿掉玩家 token 1 紅、筆數不符不標不完整 1 紅
- 端對端冒煙（DB 副本＋build 後 main 3999／worker 3998＋假 agent WS＋假後台 3997 回 1113 fixture）66 項：過期舊簽名不重建、不出差異、不被蓋掉；斷線隔離（重連回報收尾中仍鎖、done 後才放）、舊版 agent 只能人工解除（別人不能解）、重啟後機台鎖與重任務鎖從 DB 復原、agent 重連回報已停止才放、**舊格式簽名重建不誤報**；注入「斷線直接放鎖」＋「舊簽名不重建」→ 8 項紅；其餘：權限、密碼密文、網址檢查、機台鎖、完成＋recordBet 校時、遮罩、預設基準與注入的型別變更、Excel 四分頁、取消、agent 斷線、**逾時→送 stop→寬限期過了標失敗但鎖保留→遲到的 done 才放鎖**、**worker 重啟→紀錄標失敗＋重任務鎖釋放→可再開**、普通版／修仙版畫面無 pageerror、無 emoji
- fixture：`server/__fixtures__/api-capture/front-1113.json`、`backend-1113.json`（由 osm-qa-agent 1113 原始資料轉換，已遮罩、WS 只留部分幀）
- ⚠️ **未經真 agent／真機台驗證**；UAT 後台 Log 端點未實測

## 已知限制／待辦
- 只做 H5（PC 版 Cocos 大廳沒接）
- 派彩判斷靠遊戲 console 的 moneyNtc（QAT/UAT 預設有印）；看不到時無法判斷「有派彩」，會跑到最多局數，前台標不完整
- 「最小注」＝進機台時面額選單選第一個（預設最小）、不按加注，沒有另外去讀注額確認
