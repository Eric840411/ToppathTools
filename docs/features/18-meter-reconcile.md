# Performance Meter 對帳

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

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
