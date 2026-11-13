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
- 判定門檻：Coin Out 完全一致（誤差 < 0.005）**且局數一致**才算 PASS（局數規則 v5.84.0，見下方「局數不同也判不一致」）
- **核心概念**：後台自己的 `TotalCoinOut = Jackpot Wins + Coin Out` 這個恆等式一定成立；而 Jackpot Wins 有沒有被同一筆 Game Record 的 Payout 吃掉，取決於該次中獎走哪個派彩管道——沒被吃掉的部分一定會走 Attendant Paid JP（getHandPayRecord），兩者互補、恆等式 `Game Record 總 Win + Attendant Paid JP = Jackpot Wins + Coin Out` 一定成立，移項就是上面 OSM 的公式。
- 已用三個真實案例驗證：Rising Rockets Emperor-141（2026-07-22，Jackpot Wins=0，公式退化成單純比對）、Triple Treasure Pot(4321aruze)（2026-07-27，Jackpot Wins=75,685 全部走 Attendant Paid JP，Payout 完全不含）、DFDC3 88 Fortunes（2026-07-28，Jackpot Wins=5,000 全部併入同一筆 Game Record 的 Payout，Attendant Paid JP=0）——三種情境皆 pass=true, delta=0。此工具仍屬「雛形」階段，公式在同一天內已經來回修正三次（見下方修正歷程），之後遇到新的不一致案例，優先懷疑公式本身還有沒覆蓋到的情境，而不是機台真的有問題。
- **公式修正歷程**（同一天內三次修正，記錄下來避免之後又走回頭路）：① 最原始版本會扣 Jackpot Wins + Attendant Paid JP，Triple Treasure Pot 算出離譜負數，一度以為「不該扣任何東西」；② 改成不扣任何東西後，DFDC3（Jackpot Wins 併入同一筆 Payout）又算錯，因為 Payout 本身已經含 Jackpot Wins；③ 最終發現關鍵是 Jackpot Wins 有沒有被同一筆 Game Record 吃掉，改成上面的「+ Attendant Paid JP − Jackpot Wins」公式，兩個相反案例才同時驗證通過。

**EGM Performance Meter 欄位語意**（已用 EGM Hourly Meter 差值反算 + 使用者提供公式驗證）：`2`=RTP（小數，**僅 daily 回應有效，hourly 回應這個 index 被挪用成 Unix timestamp**）、`5`=Games Played、`6`=Coin In、`10`=Coin Out、`26`=WIN/LOSE（=6−10−29，**hourly 回應完全沒有這個欄位**）、`29`=Jackpot Wins。所以 WIN/LOSE、RTP 一律在後端用 6/10/29 現算，不直接讀 daily/hourly 的欄位 2/26。畫面上 RTP 小數兩位**直接捨去**、不四捨五入，跟後台 EGM Performance Meter 一致（v5.83.2；同事 1112 比對 104,578÷1,871,480＝5.588%，後台 5.58%、工具原本 5.59%。負數往 0 捨去，後台負值行為未實測。v5.83.4 起規則在 `shared/meter-rtp.ts`：用原始 coinIn／coinOut／jackpotWins 做 BigInt 精確十進位運算再捨去，WIN/LOSE 也在前端重算——不能先四捨五入到固定小數位（5.5899996% 會進位成 5.59%），也不能用「離整數 <門檻就取整」（coinIn 夠大一樣會誤進位）；值大到只能指數表示才退回後端浮點 rtp；測試 `npx tsx shared/meter-rtp.test.ts`）。欄位 `3`/`4`（及鏡射的 `13`/`14`/`15`/`16`）疑似硬體 meter 累計值；欄位 `24`/`28` 語意仍未確認。

**⚠️ Coin In/Coin Out/Jackpot Wins/Games Played 都是「累計值（自上次清帳 reset 起算，不是自當日 00:00 起算）」**，不是「當日」數字——同一機台若很久沒被 reset，數字會是好幾天/幾週的總和，直接拿來跟 Game Record 的當日加總比對會差好幾個數量級。已用真實資料驗證：**(查詢範圍內最後一個 bucket − 第一個 bucket) 的差值** 才會等於整天 Game Record 加總；若差值為負（代表當天發生過 reset），退回用最後一個 bucket 的原始累計值 best-effort（`meterDelta()` 函式）。

**Jackpot Abnormality（getHandPayRecord）語意（已由使用者確認）**：`Attendant Paid JP Meter`（OSM 後台報表欄位，機台實際硬體 meter 記錄）與 `getHandPayRecord` 的 `handpay`（本工具的 Jackpot Abnormality，QA 測試用人工派彩紀錄，不會真的寫進機台 meter）是不同東西，Triple Treasure Pot 那筆數字相等（都是 75,685）純屬個案巧合。**但公式上兩者現在是同一個角色**：`attendantPaidJp`（`getHandPayRecord` 的 handpay 加總）代表「沒有被同一筆 Game Record 的 Payout 吃掉的 Jackpot Wins」，會加回公式裡（見上方公式），不是巧合而是必要項目。另外這支 API 有個實測到的怪癖：**帶了 `clientMachineName` 篩選後，`dateTime[]` 日期範圍篩選會完全失效**（回傳的是該機台最近 N 筆 handpay，可能橫跨好幾個月），所以固定抓回後在後端用 `payoutTime` 字串跟查詢時間窗二次過濾，取真正範圍內的資料。

**`gameRecordList` / `getHandPayRecord` 的 `dateTime[]` 上界是「不含」**（exclusive）：要傳「查詢範圍結束時間點」本身當上界（例如 Gaming Day 邊界就傳隔天 06:00 的 ISO UTC），不能傳同一個時間點兩次，否則會查到 0 筆。EGM Performance Meter / EGM Hourly Meter 則沒有這個問題。

**⚠️ 更正（2026-07-29）：`dateTime[]` 其實真的支援秒級時間窗，先前「篩選只看日期部分、時分秒被忽略」的結論是錯的**——原本的「雙重驗證」測的是格式差異（空白分隔字串 vs ISO UTC），兩次都剛好整天範圍沒有真正縮小，並不是真正測試「narrow 到部分時段」，所以誤判成「時分秒被忽略」。已用 Cartin Gold-2002NCH（2026-07-29，GCP）真實案例重新驗證：直接呼叫 `gameRecordList` 帶入 `["2026-07-29T07:00:00.000Z","2026-07-29T08:17:01.000Z"]`（= 本地 15:00~16:17:01）只回傳 20 筆、總 Win 809.00，跟同一天整天查詢（30 筆、總 Win 1,209.00）明顯不同，且 809.00 恰好等於當時 EGM Meter Coin Out 讀數——證實 API 本身就能做到分秒級篩選。

因此新增「自訂起始時間」（選填，`customStartTime`，格式 HH:mm）：只 override Game Record／Jackpot Abnormality 這兩支查詢的起始時間（`windowStartIso`/`windowStartLocal`），EGM Hourly Meter 那邊的整天邊界不受影響（`meterDelta()` 的 reset 自動偵測已經會處理，不需要跟著調整）。用途：機台當天實際發生過 meter reset，若只查整天會把 reset 前的紀錄也算進 Game Record 加總、跟 meter 對不上，這時手動輸入實際 reset 時間即可對齊。

**OSM/GCP 的 gaming day 是本地時間 06:00 到隔天 05:59:59，不是自然日 00:00~24:00**（已用真實 hourly bucket 資料驗證：每個 gaming day 第一筆固定是 06:00:00；也已用後台 EGM Hourly Meter 頁面截圖確認有「Gaming Day」勾選框 + 「06:00:00-06:00:00／00:00:00-00:00:00」Date Type 單選）。`egmMeterHourList` 請求帶 `gameDay`/`dateType` 參數控制這個邊界（`gameDay='1'` + `dateType='0'` = Gaming Day 06:00 邊界，`gameDay='0'` + `dateType='1'` = 自然日 00:00 邊界）。**選 Gaming Day 邊界時，bucket 比對邏輯要接受跨日**：查詢日期 `date` 當天 06:00 之後的 bucket，加上隔天日期、但小時 < 6 的 bucket（例如隔天 05:59:59 仍屬於今天開始的 gaming day），只比對 `rowDate === date` 會漏掉這些跨日的尾端 bucket。

**dateTime[] 真正格式是 ISO UTC**（已用後台 Game Record 頁面的 DevTools Network 截圖反推驗證）：例如 `2026-07-26T22:00:00.000Z`，不是單純日期字串或空白分隔的 `"YYYY-MM-DD HH:mm:ss"`。使用者操作介面的時區固定是 UTC+8（本地 06:00 = UTC 前一天 22:00）。`toUtcIso(dateStr, hh, mm, ss)` 函式負責這個轉換。

OSM／GCP 是兩個不同後台（OSM 用 CP 後台 `qat-cp.osmslot.org`，GCP 用 NC 後台 `qat-nc.osmslot.org`，channelId 不同），憑證存在 `meter_reconcile_config` 表，登入 token 過期時自動重新登入一次再重試。**v5.76.0 起依環境×後台分四組**（`qat_osm_`／`qat_gcp_`／`uat_osm_`／`uat_gcp_`），見下方「QAT／UAT 環境切換」。

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

## 沒資料／沒活動不再判通過（v5.57.0，osm-qa-agent 1014 回報、CodeX 定案）
- 原本 EGM Hourly Meter 沒資料時 `actualCoinOut = meter?.coinOut ?? 0`，Game Record 又是 0 筆 → 「0 = 0」被判「通過 — Coin Out 完全吻合」
- 判定抽到 `server/meter-verdict.ts`（`meterVerdict`），回 `status`，`pass` 只有真的對上才是 true：
  - `apiError`：任一支 API 回應無效（code 不是 20000、缺資料欄位）——不能被 `?? 0`／`num()` 轉成 0 當成沒資料或沒活動。⚠️ Game Record 沒有紀錄時後台回 `code 20000＋data:{}`（1014 QAT 實測），這是有效的 0 筆
  - `noData`：視窗內 0 個 hourly bucket（就算 fallback 到 daily 或 Game Record 有筆數；**daily 只當參考、不判通過**），或只有 1 個 bucket（最後 − 第一必然 0，算不出差值）
  - `noActivity`：≥ 2 個 bucket、Game Record 0 筆，而且 coinIn／coinOut／jackpotWins／gamesPlayed／Bet／Win／Attendant JP 全是 0
  - 其他照舊 `pass`／`fail`
- 畫面依 status 顯示：沒資料／沒活動／API 無效是**灰色卡片**＋原因；noData／apiError 的實際值與差值顯示「—」。歷史紀錄摘要也依 status（`meterHistoryLine`）
- 各 API「有效」的判斷 `METER_VALID` route 與測試共用一份
- Egm DayCount 對帳（兩邊都是 0 也算一致）可能有同樣的問題，**另案**（CodeX）
- 測試：`scripts/ui-checks/meter-verdict.test.ts` 19 條；真 server 對 data.db 副本打 QAT：查不存在的機台 → noData（原本是「完全吻合」）

## 局數不同也判不一致＋分段定位（v5.84.0，Lusa 1113、CodeX 同意）

- **起因**：UAT CP 150 Rising Rockets 11/11，Game Record 一局寫了兩次（spinid 696，兩筆單號不同、沒中獎），Coin Out 照樣吻合 → 原本判「一致」。同事要求：局數不同直接判不一致，並協助找原因。
- **判定**（`server/meter-verdict.ts`）：apiError／noData／noActivity 優先序不變；之後 Coin Out 差值或局數（Meter Games Played 差值 − Game Record 筆數）任一不對 → fail，兩個原因都寫進 `why`。下注額（Coin In vs 總 Bet）只顯示不判。歷史摘要改寫 `why`，不再寫「差值 0.00」。
- **分段定位**（`server/meter-count-diag.ts`，只在 fail 且局數有差時跑）：相鄰 hourly 快照的 Games Played 差值＝那段 Meter 局數，同時段打 gameRecordList（pageSize 1 只讀 total，併發 4）比筆數；回 `countDiag`。
  - 實測（QAT 1112）：dateTime[] **含頭不含尾、以秒為單位**（小數秒捨去），用快照時間切段不會重複算；hourly 欄位 2＝快照 Unix 秒；自然日一天 26 筆（多 05:59:59、23:59:59）；Squid Game - 1199 逐段全部吻合、加總 1404＝整天。
  - `useLastData=1`（沒收到新快照）→ 併到下一個真快照、標「跨 N 個快照」；差值為負＝計數器重置 → 該段 Meter 局數 null；視窗頭尾沒被快照涵蓋 → edge 段（Meter 0）。
  - 相鄰兩段一正一負互相抵銷 → 標「疑似快照時間差」（Meter 整點快照在整點後幾秒才讀），**照樣索取日誌**——也可能是漏寫＋重複各一筆（CodeX 5faf105，v5.84.1）；同方向或不相鄰不算抵銷。
  - 只用查詢視窗內的快照（自訂起始時間時視窗較短，起點到第一個快照交給 edge）；快照缺時間（欄位 2）或局數欄位 → 略過並標不完整，不用 `Number()` 收（null／空字串會變 0）（v5.84.1）；視窗內 0 個快照（自訂起點晚於最後快照）→ 明講無法定位、不標完整（v5.84.2）。
  - 查詢失敗不當 0、標不完整；分段加總 ≠ 整天 → 提醒重查。定位失敗不改判定。
  - 「請提供」：每個可疑時段的盒子日誌（首尾各 +5 分）＋ Game Record 明細（看同 spinid 兩筆）。
- **限制**：只能定位區間，不能證實原因；「疑似重複寫入」（同 spinid＋開局時間）要拉全部明細，尚未做。
- **測試**：`npx tsx scripts/ui-checks/meter-verdict.test.ts`（67 條；拿掉局數規則紅 5 條）、`npx tsx scripts/ui-checks/meter-count-diag.test.ts`（35 條；拿掉併段、抵銷不看正負、視窗篩選、抵銷段索取日誌、缺值檢查都會紅）

## 盒子日誌逐局比對（v5.85.0，Lusa 1113 要求；CodeX 審過設計）

- **操作**：查詢列「盒子日誌（選填）」選一個或多個日誌檔 → 按查詢對帳 → 對帳結果下面多一張「盒子日誌逐局比對」。不選就跟原本一樣。
- **日誌不上傳**：瀏覽器用 `shared/box-log-spins.ts` 的 `parseBoxLogs` 解析（16MB 約 0.14 秒），只把每局清單（spinid、begin_time、bet、win、結束訊息送幾次）送 `POST /api/osm/meter-reconcile/box-log`；server 不存日誌。
- **日誌格式**（0150 實檔）：`HH:MM:SS.mmm|LEVEL|…`；`DoactionResultReq action_type:4 {…}` 開局（spinid、bet、begin_time）、`action_type:5 {…}` 結束（win、isError、nima）。spinid 1～999 循環 → 配對鍵是 **spinid＋begin_time**。日誌行只有時分秒，日期用第一局的 begin_time 反推；跨午夜自動 +1 天。
- **Game Record 明細**：整個查詢視窗（跟 /query 同一套邊界、自訂起始時間）分頁 500 抓完，`order_id` 去重；任一頁失敗直接回錯（不拿殘缺明細判漏寫）；去重後筆數 ≠ total 標不完整、叫人重查；超過 20,000 筆要縮小範圍。
- **配對**：Game Record `box_begin_time` 只有 4 位小數 → 日誌 begin_time（整數微秒，不經浮點）截斷與四捨五入到 0.1ms 都算候選；一筆對到兩局以上標「對到多局」不強配。
- **分類**：重複寫入（同局 GR ≥2 筆）、疑似漏寫（日誌已結束、GR 沒有）、疑似多出（GR 有、日誌涵蓋時間內沒有）、押注或贏分不同；另列盒子重送結束訊息（留次數與內容是否不同）、isError 局。
- **不判的**：日誌沒涵蓋的時間、斷檔（超過 15 分鐘沒有任何一行；閒置心跳約 10 分鐘一行）、結算離視窗邊界 <10 秒、日誌在那局中間截斷（沒有結束紀錄）、結算時間在視窗外（GR 依結算時間篩選）、isError 局不算漏寫。各自寫進說明。
- **限制**：日誌記的是盒子「送出」，不代表後台收到 → 漏寫／多出一律寫「疑似」。不影響對帳判定。
- **實測依據**（claude-osm-2，0150 11/11 全天 6586 局）：`box_begin_time` 是 begin_time 四捨五入到 4 位（不是截斷）；第 5、6 位剛好 50 的平手局後台是浮點四捨五入、方向不定（.55195→.5519）→ 兩邊都當候選。bet／win 單位一致。斷線重送不再印 JSON，只印 `thread_loop_check_action resend!!!`、斷線是 `start reconnect`；重送一次後台就多一個 order_id、box_begin_time 不變。跨日開始的局只有 action 5。真資料跑出 6585 對上＋spinid 696 三筆重複＝GR 6588 筆。
- **v5.85.1（CodeX 審 4581462）**：多候選涉及的日誌局不判漏寫；被截斷的開局／結束行算 badLines、標不完整；GR 沒抓完整時不判疑似漏寫（重複、金額不同照判）；GR bet／win 缺值算缺欄位；前端每次查詢一個序號（`querySeq`），舊回應不蓋新結果。
- **v5.85.2（CodeX 複審 4c75d9a）**：解析不了的行的時間（badSecs）一起送 server；開局～結算前後 5 秒內有壞行的 GR 列「證據不足」（nearBadLine），不判疑似多出。
- **測試**：`npx tsx shared/box-log-spins.test.ts`（46 條；壞行附近照判多出也會紅；配對只用 spinid、拿掉涵蓋檢查、未結束不歸類、多候選強配、拿掉邊界、isError 判漏寫、視窗外也判、不去重、多候選局判漏寫、GR 不完整照判漏寫、截斷行安靜略過、不看 querySeq，各自會紅）；`node scripts/ui-checks/meter-box-log-shot.mjs <日誌檔>` 打本機真路由截圖

## UAT 設定值（1014 osm-qa-agent 從 UAT CP 後台頁面的 config.js 讀到）
工具沒有綁環境，換「後台設定」的值就能查 UAT：
- Base URL：`https://uat-backendservertest.osmslot.org`（UAT CP 後台 `config.js` 的 `DOMAIN_URL.serverUrl`）
- Origin：`https://uat-cp.osmslot.org`
- Channel ID：`4186`
（QAT 是 `https://backendservertest.osmslot.org`／`qat-cp`／873）

## QAT／UAT 環境切換（v5.76.0，使用者 1104 要求；CodeX 確認做法）

- **畫面**：Performance Meter、Egm DayCount 查詢列最前面加「環境 QAT｜UAT」（使用者選放上面，跟 Meegle 測試／正式空間同一種位置）；後台設定標題顯示目前環境，切換後顯示那一組。各頁各自記住上次選的環境（localStorage，讀不到就 QAT）
- **為什麼要拆**：原本只有 `osm_`／`gcp_` 一組，Meter、DayCount、AutoSpin 對帳台、Live Ledger 共用。使用者為了查 UAT 把 OSM 那組改成 UAT 網址，等於 AutoSpin／Live Ledger 也跟著打到 UAT
- **不跨環境借值**：某環境沒設定＝沒設定，回「尚未設定 UAT 的 OSM（CP）後台連線」；寫死的 QAT 網址 fallback 已移除。Channel ID 只有 QAT 保留預設（873／892），UAT 沒填就擋下
- **API**：config（GET/PUT）、test、game-types、egm-daycount、query 都收 `env`（`qat`／`uat`）；沒帶＝qat（舊呼叫端相容），亂帶 → 400。改 Base URL 時清掉該組 token（是別的後台發的）
- **固定讀 QAT 的**：AutoSpin 對帳台（`loadReconcileConfig` 讀 `qat_{osm|gcp}_`；自己的 `reconcile_config` 指向的網址跟共用設定不同時整組不用）、Live Ledger（`PROFILE_OF` 的 uat 仍是 null，CodeX：設定存在≠驗證可用，之後另開）
- **一次性搬移**（`server/meter-config-core.ts` 的 `migrateMeterConfigEnvOn`，transaction＋`__env_split_v1` 標記）：舊 `osm_`／`gcp_` 用 **hostname 比對已知清單**判定環境（backendservertest／qat-cp／qat-nc＝QAT，uat-backendservertest／uat-cp／uat-nc＝UAT），不用「有沒有 uat- 字樣」。未知、空值、base_url 與 origin 不同環境 → 不搬，記 `__legacy_unclassified_{profile}`（只存網址），畫面提示重填。目標環境已有設定不覆蓋；舊 key 保留不刪、不再讀
- **舊 OSM 那組其實是 UAT 時**：Live Ledger 的 QAT 那段時間抓的是 UAT 後台 → 搬移時清掉 `recon_watermark` 的 qat 水位讓它重新起算，並記 `__qat_ledger_suspect_since_split`。**已經抓進來的資料沒有刪**，要看那段時段再決定（待辦）
- **測試**：`npx tsx server/meter-config.test.ts`（25 條：env 參數、hostname 判定、截圖那種情況的搬移、重啟不重搬、不覆蓋、未知留提示、LIKE 底線）；把判定改回「有沒有 uat-」會紅 5 條
- **v5.76.1（CodeX review 三個 P1）**：AutoSpin 對帳台只在「QAT 共用設定有網址、且 reconcile_config 記的網址一樣」時才用 reconcile_config（沒網址的 token 不知道是誰發的，不借）；Meter 頁儲存／測試登入從按下那刻固定環境與序號；清水位只清 `gameRecordList`（LuckyLink 的 poolChangeReport／awardsReport 是獨立來源），原值存在 `__qat_ledger_suspect_since_split`（JSON：時間＋被清掉的水位列）給回補用
- **真 server 驗證注意**：3999 的 server 會把 `/api/autospin/*` 轉給 `WORKER_URL`（預設 127.0.0.1:3010＝本機 pm2 的主 repo worker、讀主 repo DB）。驗 worktree 的 AutoSpin 路由要另起 `WORKER_PORT=3998` 的 worker 並設 `WORKER_URL`，否則測到的是舊程式
- **v5.76.2**：AutoSpin 對帳台 `reconcileLogin(cfg, env)` 的 token 存回 `qat_{env}_token／lastlogintime`（綁 QAT＋profile），reconcile_config 只在網址相同時一起更新；token 過期重試直接用這次登入回傳的 token，不靠重讀
- **v5.76.3**：AutoSpin 對帳台**不再讀 `reconcile_config`**（只有一組、不分 OSM／GCP，兩個 profile 又共用同一個網址，網址比對擋不住互蓋）。執行路徑只讀寫 `qat_osm_`／`qat_gcp_`；`/api/autospin/reconcile/config` 的 GET/PUT 還在、但存進去的值不再被使用
