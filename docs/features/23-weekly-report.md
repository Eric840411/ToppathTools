# 週報彙整

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 23. 週報彙整（WeeklyReportPage）

**路由**：`POST /api/weekly-report/parse`、`GET /api/weekly-report/week-range`、`POST /api/weekly-report/jira-by-range`、`POST /api/weekly-report/sheet-headers`、`POST /api/weekly-report/batch-scan`、`GET /api/weekly-report/tab-date-scan`、`POST /api/weekly-report/batch-submit`｜**歷史紀錄 feature key**：`weekly-report`

### 功能說明
獨立工具（2026-08-11 新增，**不掛在 OSM Tools 底下**，跟 Jira/TestCase 生成同一層級），讓成員快速把本週工作內容寫進團隊共用的 Lark Base 週報表。每週該表是全新一張（不是同一張表累積、沒有日期/週次欄位），所以工具不寫死表格 ID，改成使用者每次貼上「本週 Lark Base 網址」，動態讀取該表的欄位選項。

**Lark Base 表格式**（已用真實表驗證，`FEyTb3Y7Ua6ntgsXt0nlKg5yg8e`/`tblBIv21zkPymWCO`）：只有 4 個欄位——`No`（自動編號）、`专案`（單選，~60-70 個專案代碼如 `P7-005-OSM`）、`成员`（單選，~45 個人名）、`补充说明`（純文字）。`parseLarkBaseUrl()`（`server/routes/weekly-report.ts`）解析 `/base/{appToken}?table={tableId}` 格式（跟 `parseLarkSheetUrl()` 解析 `/sheets/`、`/wiki/` 是不同格式，不能共用）。

**初版設計（2026-08-11～2026-08-16，已整個移除）**：最早是「一人一週固定一列、自己手動選成員/專案、多個工作項目全部合併塞進同一格補充說明文字」，Step 3 提供「依時間範圍撈 Jira 單號插入純文字」與「從 Sheet 分析本週內容（alias 精確比對＋四級信心分級＋AI 摘要成一段文字）」兩個輔助入口。2026-08-16 使用者提供真實 Lark Base 截圖後發現團隊實際用法完全不是這樣（見下方「批次掃描審核模式」背景轉折），改寫成批次掃描；**2026-08-16 稍後使用者進一步確認「個人自助」這個舊流程可以完全移除**，不需要跟批次掃描整合或並存。前端整個 `mode === 'individual'` 區塊、`SearchableSelect` 之外的 Step 2/3 UI、`insertAtCursor`/`handleRangeSearch`/`handleSheetRun` 等 handler，以及後端 `POST /api/weekly-report/sheet-analysis`、`POST /api/weekly-report/sheet-analysis-draft`、`POST /api/weekly-report/submit`（單筆新增）三支端點與 `analyzeSheetRows()`/`NAME_COLUMN_HINTS` 皆已刪除。**`POST /api/weekly-report/jira-by-range` 保留**（批次掃描的「依時間範圍撈 Jira 單」功能複用同一支端點，見下方），`readLarkSheetTab()`／`parseSheetDateCell()`／`evaluateConcatFormula()` 等共用 helper 也保留（`sheet-headers`／`batch-scan` 仍在用）。

**撈單條件（`jira-by-range`）**：`(reporter = currentUser() OR assignee = currentUser() OR "QA驗證人員" = currentUser()) AND ((created >= start AND created < end+1天) OR (updated >= start AND updated < end+1天)) ORDER BY updated DESC`——Reporter、經辦人（assignee，**2026-08-20 使用者決定加入**）、QA驗證人員，三者符合其一即列出（**2026-08-20 修正**：原本查寫死的 `cf[10440]`，但「QA驗證人員」在這個 Jira 實例是**每個專案各自一個自訂欄位**——列 `/rest/api/3/field` 有三十幾個同名的 people 欄位，10440 只是 DSFT 專案在用的那個，所以這個條件長期只對一個專案有效、其他專案全部漏抓。真實案例：P5MA-9303 的 QA驗證人員確實有 Eric Wu，但該專案用的是 `cf[10087]`。改用**欄位名稱**查詢，Jira 會跨所有同名欄位比對；已實測確認是超集合不是替換——同一個專案用舊 ID 與用名稱查回傳完全相同的單，用名稱另外還抓得到 P5MA／P5BU／LBCMS／HYSL 等專案）；「建立」或「更新」落在時間範圍內都算，不限工作流程階段（To Do/In Progress/Done 都會撈到）；結束日用「+1天、`<` 排除」而不是 `<= 結束日`，避免 Jira 日期比較只算到當天 00:00 的邊界問題。**不限制 project**，撈這個人 Jira token 能看到的所有專案（使用者明確要求「只要有關這個人的共享專案都能撈到」，不要另外做專案篩選）。`currentUser()` 能正確解析成操作者本人，是因為 `userJiraAuth(req)` 本來就是讀 `x-jira-email` header 對應到後端存的**個人**（不是共用 service account）token 組 Basic Auth，跟批量開單/評論用同一套。批次掃描的多帳號查詢（見下方）就是對這支端點用不同帳號的 email 平行呼叫多次，後端邏輯完全沒改。

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

**role 判定的兩次收緊**：v4.13.1 因為拿不到其他專案的驗證人員欄位值，用 JQL 語意反推「不是 reporter 卻被撈出來 → 必然是驗證人員」；**v4.16.0 加上 assignee 之後這個反推就不成立了**（可能只是被指派的），改成實際比對 assignee 的 accountId，反推條件收成「不是 reporter、也不是 assignee、且已知的驗證人員欄位裡沒有我」。之後如果再往撈單條件加新的角色，**這段反推一定要跟著收緊**，否則會把新角色的單全部誤標成驗證人員。

**Jira 單依標題中括號標籤歸集（v4.15.0，2026-08-20）**：撈回來的 Jira 單直接把單號寫進週報意義不大，改成可以依標題開頭的 `[xxx]` 標籤歸集成人看得懂的描述。規則是使用者當面確認的（第一版我猜成「沒有共同標籤就把所有標籤串成一句」，被當場糾正）：

1. **先依第一個標籤分組**——沒有共同標籤的單**不是串成一句，而是拆成不同項目各寫一條**
2. 每組取該組所有單的**共同標籤**（同組第一個標籤必然相同，所以至少有一個），組成「◯◯相關需求測試」
3. 標題沒有中括號的單另外歸一組、**保留原本的單號內容**，不硬生出沒有依據的描述

| 輸入 | 輸出 |
|------|------|
| `[OSM][GM][API日誌]` + `[OSM][API、GW]` + `[OSM][後端]`（使用者的真實三張單）| 一條「OSM相關需求測試」|
| `[OSM][H5]` + `[OSM][H5]` | 一條「OSM H5相關需求測試」|
| `[OSM][GM]` + `[LuckyLink][後端]` | **兩條**「OSM GM相關需求測試」「LuckyLink 後端相關需求測試」|
| 標題沒有中括號 | **直接寫該張單的標題**，一張單一條（v4.16.0 改，原本是保留單號）|

標籤只解析**標題開頭連續**的中括號（`/^(\[[^\]]+\])+/`），本文中間出現的中括號不算——「修正 [OSM] 顯示問題」的 `[OSM]` 不是分類標籤（CodeX review 建議）。

**`DraftItem` 新增 `jiraIssues?: { key, summary }[]`**：Jira 套用進草稿時原本只留單號（`content: g.keys.join('、')`），標題根本沒被帶進來，沒有原始資料就做不出可逆的歸集。存成「單號+標題成對」而不是兩個平行陣列，是因為只存 `summaries[]` 的話跟 key 的對應是隱性的，之後要追「這個標題是哪張單」很痛（CodeX review 建議）。`content` 仍然是使用者看得到、可編輯的單號串——歸集是**送出前的呈現規則**，不是草稿內容改寫，所以在 apply 當下就把 content 算成描述是不行的（太早失真，使用者也看不到原本是哪幾張單）。

**兩個合併開關的套用順序**：`原始草稿 → Jira 標籤歸集（依 summary 語意，較細）→ P7-005-OSM 每人合併（依專案，較粗）→ flatPreviewItems`。實作上 P7 那段**必須讀標籤歸集後的結果而不是 `draftEdits`**，否則同時開啟兩個開關時前者會被整個蓋掉。真的重疊時（Jira 單被歸到 P7-005-OSM）後者把前者結果再併掉，符合「P7-005-OSM 權重更高」的直覺。

**P7-005-OSM 每人合併成一條（v4.14.0，2026-08-20）**：同一個人一週可能有十幾筆 OSM 需求（真實案例：一次掃描 39 筆草稿，Eric 一個人就 5 筆都是 P7-005-OSM），逐條寫進週報沒有意義。草稿清單標題列新增開關，開啟後**每個人各自**把 `projectName` 等於 `MERGE_PROJECT_NAME`（沿用既有的 `DEFAULT_SCAN_SHEET_PROJECT_NAME = P7-005-OSM` 常數，不寫死第二份）的項目合併成一筆，補充說明統一寫 `OSM需求`。**預設關閉**——使用者明確要求「需要做開關，或是讓使用者選擇，不要硬改」；選擇存 localStorage（`toppath-weekly-merge-osm`），開過一次就記住。

實作位置刻意選在 `flatPreviewItems`（`WeeklyReportPage.tsx`）這一層做**衍生轉換**，不動 `draftEdits` 原始資料：① 關掉開關完全恢復逐筆，草稿裡個別編輯過的內容不會因為切換開關而消失；② `flatPreviewItems` 同時是「預期結果預覽」和「送出 payload」的唯一來源，在這裡合併，畫面跟實際寫進 Lark 的內容一定一致，不會有兩套邏輯要同步。專案名稱比對前 `.trim()`，因為 Sheet／Jira 來源的字串可能帶前後空白（CodeX review 建議）。

**唯一會把合併結果寫回草稿的路徑是「部分失敗」**：`handleBatchSubmit` 在部分失敗時會用送出當下的 `flatPreviewItems` index 對應後端回傳、把已成功的移除避免重送（見上面那段說明）。開啟合併時「送出單位」就是合併後那一筆——成功代表那幾筆都已寫入、整組移除；失敗就整組留著重試，此時 `draftEdits` 會被固化成合併後的形態。跟 CodeX 討論後把這條當成正式規則，不做「失敗時還原成原本 N 筆」。

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

**只用表單名稱的來源 Sheet（v4.53.0，2026-08-27）**：有些表加進來只是要記「這週有處理它」，逐列展開反而是雜訊。來源 Sheet 讀完表頭後多一個勾選框「只用表單名稱，不讀裡面的內容」，勾了之後：

- **這份完全不進 `batch-scan` payload**（`sheets: scanSheets.filter(s => !s.nameOnly)`）——不是掃了再過濾，後端根本沒讀到它，所以日期欄位／填寫人欄位不用選（`scanReady` 對 nameOnly 的那份只要求有 `tabName`）
- **內容就是分頁名稱**，來自 `/api/weekly-report/sheet-headers` 本來就有回的 `tabName`（這支端點不用改）
- **沒有填寫人欄位可以自動分類，所以手動勾成員**，沿用頁籤日期式報表那套 `SearchableMultiSelect`（可複選）＋「套用」按鈕，每個勾到的人各拿一筆
- **`sourceRowId` 是 `手動指派 · 表單 · {url}`**——「手動指派 · 」前綴讓 `isSheetSourced()` 判定為非 Sheet 來源，重跑掃描時會被保留，跟 Jira 套用／手動新增／未識別人員指派待遇一致（2026-08-16 那個「重掃把非 Sheet 項目整包蓋掉」的 bug 的修法）；同一份表對同一人重複按套用會跳過，不會長出第二筆
- **逐份獨立**：勾選狀態存在各自的 `ScanSheetConfig.nameOnly`，勾這份完全不影響其他份
- 勾選成員的 state（`nameOnlyMembers`）**key 用網址不用陣列 index**——移除中間那份時 index 會位移，勾好的成員會跑到別份表上

專案比對只試 `matchLarkProjectByJiraName(tabName, ...)`，對不到就留空由「預期結果」標紅擋送出，不硬猜。

**定時備稿提醒（v4.54.0，2026-08-27）**：`GET/PUT /api/weekly-report/reminder`＋`POST .../reminder/test`，設定「每週幾、幾點」，到點發一則 Discord 提醒。**只提醒、不自動送出**（使用者選 B）。

**為什麼後端不自己把草稿產好**（跟 CodeX 討論定案）：備稿整條鏈都在前端——Sheet 掃描、Jira 撈單、專案關鍵字比對、P7-005-OSM 合併、Jira 標籤歸集、手動指派，全部是 `WeeklyReportPage.tsx` 的狀態。搬到 server 等於同一套規則前後端各維護一份，之後改比對規則一定會漏一邊。要做的前提是先把週報核心邏輯抽成前後端共用的 service，不是直接在 server 複製一份。所以這版只負責「到點提醒去開頁面」，開頁面之後既有的全自動載入本來就會自己跑完備稿。

- cron 沿用 `server/routes/osm.ts` 的 `restartCron` 那套（`node-cron` +`{ timezone: 'Asia/Taipei' }`），模組載入時套用一次，所以 server 重啟後排程自動恢復
- `reminderCronExpr()` 把 `HH:mm` 的**時分先轉成數字再組**——`"09:05"` 直接塞進 cron 表達式會變成 `05 09 * * 4`，前導零不是所有 cron 實作都吃
- Webhook URL 沿用 AutoSpin 那組全域設定（`settings.discord_webhook_url`），不另外設一份；mention 一定要放 `content` 不能塞在 embed 裡（AutoSpin 那邊踩過，embed 裡的 `<@id>` 不會真的 ping）
- 訊息裡的連結來自 `TOPPATH_BASE_URL`，**沒設就會是 `http://localhost:3000`**——每個環境的 `.env` 要各自設
- 已用真實 cron 觸發驗證：排在 11:44，log 在 `11:44:00` 準點印出「已送出提醒」且 Discord 真的收到

**訊息附預覽（v4.55.0）**：使用者要求訊息裡看得到內容。**文案一定要維持「預覽」的定位**（跟 CodeX 定案）——備稿有一半規則只活在前端（專案預設帶入、P7-005-OSM 合併、Jira 標籤歸集、頁籤報表與未識別人員的手動指派），server 只跑得了 Sheet 掃描那段，數字跟最後送進 Lark 的內容不保證一致。假裝它等於最後結果比不給預覽更糟——使用者會照著它核對然後發現對不上。

- **server 不知道要掃哪幾份表**：`scanSheets` 是 `WeeklyReportPage.tsx` 的前端 state，連 localStorage 都沒存。所以前端在**每次掃描成功當下**把設定 PUT 到 `/api/weekly-report/reminder/sources`（settings key `weekly_report_reminder_sources`），cron 用「你上次實際用的設定」跑。**刻意不在 server 端另外寫一份預設來源常數**——那等於同一組設定前後端各一份，改了一邊就不一致
- **`runBatchScan()` 與 `loadWeeklyBaseOptions()` 從既有端點抽出來共用**，不是在 cron 那邊複製一份掃描邏輯
- **Jira 撈單刻意不放進預覽**：要用某個人的 Jira token 去查，而身分一律以登入 cookie 為準（v4.10.0 收緊的邊界）。cron 沒有請求也沒有登入者，要撈就得繞過那條邊界
- **預覽算不出來絕不能連提醒都發不出去**——整段包 try/catch，失敗就在欄位裡寫明原因，提醒照發
- **Discord 單一 field value 上限 1024 字元**，人多時一定要截；超過會被 API 整包拒絕，訊息完全發不出去，比少列幾個人嚴重得多

**Discord 按鈕直接送出（v4.56.0 + v4.57.0，2026-08-27）**：使用者建了 Discord App 之後做的。

**Webhook 送 `components` 會被 Discord 靜默丟掉**（HTTP 200、訊息照送、回應裡 `"components":[]`、不報錯，已實測）。要有按鈕就一定得是 application 發的訊息。**專案裡本來就有 `discord.js`**（`server/discord-bot.ts` 在用），不用自己接 Gateway。

**規則抽到 `shared/weekly-report-rules.ts`（v4.56.0）**：按鈕的意思是「不開頁面就送出」，那要求後端算得出跟頁面一模一樣的內容。抽的是純運算——`matchLarkProjectByJiraName`／`leadingTags`／`jiraTagGroups`／`applyDefaultScanSheetProject`／`buildPreviewItems`。**`shared/` 只放純函式、型別、常數，不碰 fs／DB／env／Express／React**（跟 CodeX 定案）——放 `server/lib/` 沒有這道界線，哪天不小心 import 到 server-only 的東西前端 build 會直接炸。前端 `moduleResolution: bundler` 吃得下 `.js` 後綴指向 `.ts`，`tsconfig.server.json` 的 `include` 要加 `shared/**/*.ts`、`exclude` 要排掉 `**/*.test.ts`。

**抽不進來的三件事**（Discord 按鈕的範圍限制，不是還沒做）：

| 項目 | 為什麼 |
|------|--------|
| Jira 撈單 | 要用某個人的 Jira token，而身分一律以登入 cookie 為準（v4.10.0 收緊的邊界）。cron 沒有請求也沒有登入者，要撈就得繞過那條邊界 |
| 手動指派 | 頁籤日期式報表、未識別人員指派，本質上要有人看著決定 |
| 只用表單名稱的來源 | 同上，也是手動勾成員 |

所以按鈕送的是「Sheet 掃描這條路上可以自動判定的部分」，其餘一律進 `blockers` 並在訊息裡逐條列出原因——**不能安靜地漏掉**。

**部分送出而不是整批擋下**（跟 CodeX 定案）：使用者按按鈕的期待是「能送的先幫我送」，不是因為一個未識別人員就讓整週可判定的資料全部卡住。

**防重複一定要「先搶再送」不能「查了再寫」**（CodeX review 抓到）：後者中間有 race，連按時兩個 request 會同時查到不存在。做法是拿 `(週期起日, 人, 內容, 專案名)` 算 key 直接 `INSERT` 成 `processing`，撞 unique 就代表別人在處理或處理完了。**key 用專案名稱不用 id**——頁面那條路的 payload 只有名稱沒有 id，用 id 兩邊算出來的 key 不一樣、查重整個失效。`failed` 與卡超過 10 分鐘的 `processing` 會被清掉允許重試，否則失敗一次就永遠卡住。

**頁面送出的也記進同一張表，但只記錄不擋**：頁面本來就有自己的防重複設計（append-only ＋ 部分失敗時移除已成功的），改成會擋是行為變更；記錄只是讓按鈕那條路知道「這筆頁面已經送過了」。

**兩個合併開關要跟著來源設定一起存到後端**：它們原本只在瀏覽器 localStorage，server 讀不到。不一起存的話，Discord 送出的結果會跟使用者在頁面上勾的開關不一致——那正是這整件事要避免的不一致。前端在**掃描成功當下**一起 PUT。

**Discord 的 3 秒硬限制**：按鈕被按之後 3 秒內一定要回應，否則顯示「此互動失敗」。送 Lark 一筆一筆寫必定超過，所以按下當下先 **`update()`**（它同時是 ACK 也是編輯）把按鈕改成反灰的「發送中…」，跑完再 `editReply()` 出結果。實測編輯約 500ms，來得及。

**⚠️ `deferUpdate()` 只 ACK、不動訊息**（v4.98.7 修）：原本用它佔位，結果整段送出期間按鈕還是可點的「確認送出到 Lark」，使用者怕重複點（2026-09-03 回報）。**但按鈕 disabled 只是視覺防呆，不是正確性保證**（CodeX 原話）——真正擋重複的一直是送出前「先 INSERT 搶 claim」那層，連點本來就不會產生重複的 Lark 列。

**⚠️ 一旦按下就 disable，就必須有復原路徑，否則比原本更糟**：process 死在送出途中的話，卡片永遠停在「發送中…」、從 Discord 再也按不了（原本至少還停在可點狀態）。做法是按下當下把 `{channelId, messageId, startedAt, userTag}` 記進 `settings.weekly_report_submit_pending`，bot 下次 `ClientReady` 時發現遺骸就把卡片改回「重試送出」。

- **刻意不做 timeout 判斷**：timeout 的用途是分辨「還在跑」跟「已經死了」，但這支只在 ClientReady 跑——**能跑到那裡就代表舊 process 已經不在**，留著的必然是遺骸。加 timeout 只會讓復原白晚 N 分鐘，而使用者當下看到的就是卡死。
- **順序是「先記 pending，再改按鈕」**。反過來的話，改完按鈕、記錄失敗（`writePending` 自己吞例外）＝卡片停在「發送中…」但沒有任何復原線索，永遠鎖死。現在的順序最壞只會多記一筆用不到的 pending。
- **復原文案一定要講「不確定完成到哪一筆」**：送到一半掛掉時前面那幾筆是真的寫進 Lark 了，說成「沒有送出」會誤導；但重試本身安全，claim 會擋掉已成功的那幾筆。
- 送出失敗也改成可點的「重試送出」，不再是永遠反灰的「送出失敗」——`clearRetryableSubmissions()` 本來就是為了讓失敗能重試而存在，把出口關掉等於那段程式碼白寫。

- **pending 的清除要用 `try/finally` 包住整段，不要每個出口各清一次**（CodeX review 點名）：後者靠擺放位置成立，之後有人加一個 early return 就會靜默漏掉，症狀是「這次正常收尾了，下次重啟卻把一張已經有結果的卡片覆蓋成『上一次送出中斷了』」。
- **已知範圍限制**：`ClientReady` 直接清 pending 的前提是**單一 process**。之後若變成多 instance 同時跑 bot，一台重啟會把另一台正在跑的送出誤判成遺骸——目前 pm2 單 process 重啟模型下沒問題（CodeX 提醒）。真要水平擴 bot 的話，pending 復原要改成帶 owner／lease／heartbeat 的模型，不能只看「有沒有這筆紀錄」。

> 已驗證 22 項（`scripts/ui-checks/weekly-submit-button-state.mjs`，用假 client 不連 Discord，跑完還原 settings 表），含「清除必須在 finally 裡」的結構檢查——**已注入違規確認它會變紅**。
> ⚠️ **`update()` 在真實 Discord 上的行為沒辦法在本機驗**——本機的 `WEEKLY_DISCORD_BOT_TOKEN` 是刻意註解掉的（兩個環境同時跑 bot 會造成重複寫入 Lark），只有 Spug 上才驗得到。

**乾跑端點 `GET /api/weekly-report/submit-preview`**：按鈕按下去就真的寫進團隊共用的週報表、收不回來，所以要有一個不產生副作用的方式先看會送什麼。防重複的驗證（`scripts/ui-checks/weekly-dedupe-check.mjs`）也刻意**完全不碰 Lark**，用合成資料直接驗 claim 行為。

**Bot 跟既有那支是不同的機器人、不同 token**（`WEEKLY_DISCORD_BOT_TOKEN` vs `DISCORD_BOT_TOKEN`），刻意分開避免動到既有 `discord-bot.ts` 的行為。Webhook 保留當 fallback——bot 沒設定或還沒連上時照樣發得出提醒，只是沒按鈕。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看頁首即時時鐘／撈取範圍 | 頁面最上方常駐顯示，即時時鐘每秒更新（固定 Asia/Taipei 時區）+ 本次資料撈取範圍（跟 Sheet 掃描同一套週五~週四週期）；讀取失敗會明確顯示「無法取得本週撈取範圍」 |
| 貼上本週 Lark Base 網址 | 每週表格不同，貼上後自動讀取「成员」/「专案」欄位選項；預設帶入固定連結並自動讀取一次，欄位仍可編輯、可手動改連結重新讀取 |
| 勾「只用表單名稱」 | 來源 Sheet 讀完表頭後可勾，勾了就不逐列掃描這份表，改成一筆內容＝分頁名稱，手動勾成員（可複選）按套用；逐份獨立，不影響其他份 |
| 新增來源 Sheet | 最多 3 個，第一筆固定帶入「OSM需求單」並自動讀表頭＋套用已知欄位對應（日期/填寫人/摘要），仍可手動改網址重新讀取；其餘筆各自貼網址後「讀取表頭」，自選日期欄位／填寫人欄位（各必選一個）／內容欄位（可複選，公式儲存格如「摘要」欄位會自動嘗試評估成真正的值，評估不了才保留原始文字） |
| 開始掃描 | 依週五起始時間窗過濾、依填寫人拆分、比對成員名單與專案關鍵字，畫面顯示統計卡片；來源讀取失敗會明確顯示，不靜默漏資料 |
| 依時間範圍撈 Jira 單（可多選帳號） | 頁面載入時自動勾選 Eric/Lusa/Siara（關鍵字模糊比對現有帳號清單）、自動查詢、自動套用成草稿；撈取範圍固定跟隨頁首顯示的週期，不用手動選日期；也可以手動勾選其他帳號各自用自己的 token 平行查詢，結果合併顯示（同張單被多個帳號查到會標示來源），撈完手動選「加入到哪個人」套用——不論先跑 Jira 還是先跑 Sheet 掃描，兩邊加的項目都會保留、不會互相蓋掉 |
| 查探頁籤日期式報表 | 頁面載入時自動觸發查探，命中的頁籤自動勾選 Eric/Lusa/Siara（關鍵字模糊比對）並自動套用；來源文件寫死不用貼網址，一鍵掃描固定文件裡「標題開頭是本週日期」的頁籤，命中的頁籤標題整串當內容；也可以手動改勾選其他一或多個成員（可複選）後套用，沒有填寫人欄位所以沒有自動分類 |
| 依人員分組編輯草稿 | 人員 tab 切換，每人清單可編輯專案／備註／刪除／新增項目 |
| 處理未識別人員 | 比對不到既有成員名單的列另外列出，可指派給某個成員或忽略，不會被吞掉 |
| 查看預期結果 | 唯讀表格，欄位對齊真實 Lark Base（No/專案/成員/補充說明），缺專案的列標紅 |
| 呈報宗門 | 缺專案時鎖住送出；送出後顯示成功/失敗筆數 |

---
