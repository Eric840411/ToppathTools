# Meegle（飛書項目）個人綁定

> Jira 未來會全面停用，批量開單等工具會改用 Meegle（`project.larksuite.com`，Lark 國際版雲端租戶）。
> 這份是第一步：**讓每個人把自己的 Meegle 身分綁進工具**，之後伺服器用本人身分操作 Meegle。

---

## 28. Meegle 個人綁定（MeegleAccountPage，v4.262.0）

**入口**：側欄「個人帳號」（修仙版「本命道籍」）｜**路由**：`/api/meegle/*`、`/api/admin/meegle-identity-overrides`｜
**歷史紀錄 feature key**：`meegle-account`｜**權限**：個人設定頁，所有登入者都能進，**不做權限開關**（不在 `ALL_PAGE_KEYS`）

### 使用者操作
| 操作 | 說明 |
|------|------|
| 驗證並綁定 | 貼上 Meegle → MCP 設定 → HTTP Header 的「複製 Token」，伺服器先實際打一次 Meegle 驗證，通過才加密存起來 |
| 重新驗證 | 用已存的 token 再驗一次。**連不上／逾時不會把綁定標成失效**，只會顯示「這次驗證沒有完成」 |
| 更換 token | 驗證通過才替換；**驗證失敗時舊綁定完全不動** |
| 解除綁定 | 只刪本站存的 token。要讓 token 真正作廢，需到 Meegle 同一頁按「重置 Token」 |
| （管理員）身分對照 | 系統管理 → 帳號管理 → 「Meegle 綁定與身分對照」：登入 email 跟 Meegle email 不同的人，把登入 email 對到他的 Meegle user_key；也看得到誰綁了、狀態如何（**看不到 token**） |

### 設計（跟 CodeX 討論定案）
- **token 類型**：Meegle MCP 設定頁「HTTP Header」分頁的個人 token，標頭 `X-Mcp-Token`，頁面寫「長期有效」，本人可重置。
  CLI 用 `MEEGLE_ACCESS_TOKEN_HEADER=X-Mcp-Token` + `MEEGLE_USER_ACCESS_TOKEN=<token>` 帶它。不用 OAuth（2 小時過期、要 keychain 才能自動換新，Spug 上沒有）
- **身分比對**：`user me` 回的 email 跟登入 email 相同（不分大小寫）才算本人；否則只認管理員建的對照（登入 email → Meegle user_key）。
  **不能把第一次貼進來的身分直接認作本人**——那等於拿到別人 token 就能綁。同一個 Meegle 帳號也不能綁在兩個工具帳號上
- **加密**：AES-256-GCM，金鑰只在環境變數 `MEEGLE_TOKEN_KEY`（32 bytes base64 或 hex），不進 DB。沒設金鑰 → 綁定功能直接回「伺服器未設定金鑰」，**不退回明文**。
  ⚠️ 換金鑰＝所有綁定解不開，重新驗證會標成失效（`DECRYPT_FAILED`）並提示重綁
- **錯誤分類**：`TOKEN_INVALID`（伺服器明確拒絕）／`IDENTITY_MISMATCH`／`ALREADY_BOUND_ELSEWHERE`／`UNAVAILABLE`（連不上、逾時）／`KEY_NOT_CONFIGURED`／`CLI_MISSING`。
  只有 `TOKEN_INVALID` 和「身分變了」會把綁定標成失效
- **併發**（v4.262.1，CodeX review `ff1fb71` 抓到三個 [P2]，流程抽到 `server/meegle-account-service.ts` 才測得到）：
  - **修訂號用隨機 UUID（`rev`），每次綁定或解除都換新**，而且解除後仍留在 `meegle_account_revs`。v4.262.0 用遞增的 `token_version`，
    「解除再重綁」會從 1 重來，舊驗證結果剛好對得上，就把新綁定標失效
  - **綁定在等 CLI 前先記下 rev、提交時必須沒變**，否則回 `CONFLICT`（409）不寫入。解除也會換 rev——「換 token 途中另一個分頁解除」
    舊請求回來寫不進去，**憑證不會復活**
  - **暫時性錯誤只記錄這次嘗試、不寫 status**，而且綁定已經失效時連錯誤碼也不寫——原本拿讀取當下的舊狀態寫回，
    會把另一個請求剛寫的「已失效」蓋回 valid
  - 重新驗證只在 rev 沒變時寫結果
  - **較舊的驗證不能蓋掉較新的**（v4.262.2，CodeX review `495a0e0`）：兩次重新驗證共用同一個 rev——A 在 token 重置前驗證成功但回應延遲、
    B 重置後先回「被拒」，A 回來會把狀態改回有效並清掉原因。每次重新驗證開始時拿遞增序號 `check_seq`，
    寫入條件 `applied_seq < 自己的序號`；暫時錯誤不推進 `applied_seq`，但一樣不能蓋較新的紀錄
- **資料表**：`meegle_accounts`（email 為鍵，存密文、Meegle 身分、狀態、`rev`、最後成功驗證／最後嘗試時間與錯誤）、`meegle_account_revs`、`meegle_identity_overrides`。
  啟動時自動把 v4.262.0 的表遷移成 `rev`（`ALTER ADD rev`、`DROP COLUMN token_version`、既有列補 rev）

### ⚠️ 踩坑（2026-09-30 實測，都有測試守著）
1. **沒帶 token 時，CLI 會自己沿用主機上的登入。**CLI 會去作業系統憑證庫（Windows 憑證管理員／macOS keychain）找 `meegle auth login` 留下的登入——
   把 HOME/APPDATA 全換成空目錄照樣找得到。伺服器若不小心沒帶 token，**開出去的單會掛在那台主機登入者名下**。
   所以 `runMeegle()` token 為空直接丟 `NO_TOKEN`，連子程序都不起；子程序環境不繼承 `process.env`、HOME 指到獨立暫存目錄、host 寫死。
   突變驗證：把 token 從子程序環境拿掉，測試當場拿到 `ok:eric.wu@toppath.tw`（這台機器的登入）而轉紅
2. **CLI 失敗時結束碼常常還是 0**，錯誤在輸出 JSON 裡；假 token 打 `user me` 甚至只印 `unknown command "user"`（命令清單是用 token 動態抓的）。
   所以驗證先跑 `auth status`：它的結束碼有契約——0 有效／1 被拒／2 連不上
3. **連不上 ≠ token 失效**：`auth status` 結束碼 2 一律 `UNAVAILABLE`；突變驗證把它改成 `TOKEN_INVALID`，單元與真 CLI 兩條都轉紅

### Spug 上線需要
1. **環境變數 `MEEGLE_TOKEN_KEY`**：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` 產生。沒設的話頁面會顯示「伺服器尚未設定金鑰」
2. **`npm install` 會多裝 `@lark-project/meegle`**（版本鎖 1.0.23，內含各平台執行檔，約 68 MB）。版本鎖死是因為輸出格式是我們解析的，升級要重跑測試
3. Spug 要連得到 `project.larksuite.com`

### 驗證
- `npx tsx server/meegle.test.ts`：36 條（分類、身分判斷、加密、空 token、**真 CLI**：假 token 被拒且沒有沿用主機登入、斷網判成 UNAVAILABLE、執行檔不存在）
- 突變三個都紅在對應那幾條：token 沒帶進子程序／連不上判成失效／拿掉空 token 檢查
- `npx tsx server/meegle-race.test.ts`：23 條，記憶體 DB＋手動放行的假驗證控制回應順序，重現 CodeX 抓的四個競態＋舊表遷移。
  突變六個都紅在對應那幾條：驗證不檢查 rev（①）、綁定不檢查 rev（②②b）、解除不換 rev（②）、暫時錯誤拿舊狀態寫回（③）、
  狀態寫入不看序號（④）、暫時錯誤寫入不看序號（④c）
- ⚠️ 教訓：36 條測試全綠，但**一條都沒有測到路由層的競態**——單元測試只驗「每一步對不對」，驗不到「兩個請求交錯時對不對」
- 打本機真 server：未登入 401、假 token 400、未綁定驗證 404、非管理員打對照 403、表單式 POST 被擋、綁定失敗舊綁定不動（`token_version` 不變）、已存 token 失效後重新驗證變 invalid 且最後成功時間保留、解不開標 `DECRYPT_FAILED`、DB 只有密文、log 裡搜不到 token
- ⚠️ **還沒驗的**：**真的 `X-Mcp-Token` 綁定成功**這條（需要使用者本人的 token），以及 CodeX 要求的首輪四情境（本人／他人／重置後／斷網）要用真 token 跑

### 還沒做
- 用綁定的 token 真的去開單／評論／流轉（批量工具改接 Meegle），這次只做身分綁定
- 代理授權（用別人的 Meegle 身分操作）
- Jira 退場：登入帳號、PIN、角色目前都存在 `jira_accounts`，停用 Jira 時登入系統要一起搬（CodeX 提醒，另案）

---

## 28b. Meegle 批量開單（Jira 頁「Meegle 開單」分頁，v4.263.0）

**入口**：Jira 批量工具 →「Meegle 開單」分頁｜**路由**：`/api/meegle/batch/*`（`server/routes/meegle-batch.ts`）｜
**歷史紀錄 feature key**：`meegle-batch-create`｜**權限**：跟 Jira 批量工具同一個 page key `jira`（伺服器也檢查）｜
**前提**：使用者已在「個人帳號」綁定 Meegle（用本人 token 開單，前端沒有參數能指定用誰的 token）

**目標空間／類型**：預設「TP-項目管理-測試」的「任務項」。正式上線改環境變數
`MEEGLE_PROJECT_KEY`／`MEEGLE_TASK_TYPE_KEY`（還有 `MEEGLE_REQUIREMENT_TYPE_KEY`、`MEEGLE_REQUIREMENT_FIELD_KEY`）。⚠️ Master 是正式空間，**不要拿來測**。

### 畫面：分步驟（v4.265.0，CodeX 設計、使用者要求 1:1 還原）
① 讀取與預設 → ② 人員對照 → ③ 預覽與勾選 → ④ 送出結果，一次只顯示一步。全員已對照會自動跳過 ②（仍可點回）；上一步保留設定、勾選與驗證；③ 有未對照名字會提示回 ②；送出後自動切到 ④；底部進度列跨步驟保留（沿用 Dashboard 靈脈素材）。逐列編輯已併入批量設定（只勾一列＝單列修改）。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 讀取 Sheet | 貼 Lark Sheet 網址（會帶入其他 Jira 分頁最後用的網址）。只支援 Lark |
| 關聯需求預設 | Meegle「任務項」的關聯需求是**必填**。整批選一個；Sheet 有「關聯需求」欄（填名稱或需求 ID）就以那欄為準 |
| 受托人／Code Review | Sheet 沒有這兩欄，整批選一個（下拉只列已對照過的人），可逐列改 |
| 開單後推到 | 整批選一個狀態；不選就停在初始狀態。**「進度」欄不使用**（使用者：進度不等於 Meegle 狀態） |
| 編輯（逐列） | 改這列的關聯需求、五個角色（填 Sheet 上的人名） |
| 批量設定（v4.264.0） | 勾幾列 →「批量設定已勾選的 N 列」→ 一次設關聯需求／五個角色；留空不改，人名取代 Sheet 值；「清除這些列的手動設定」回到 Sheet／整批預設。被擋下的列也能勾（才補得了設定），送出仍只取通過檢查的 |
| 進度列（v4.264.0；v4.268.2 調整） | 送出時固定在畫面下方：進度、已開單／推狀態失敗／待確認／失敗；在 ①～③ 顯示，「看結果」跳到 ④。**到了 ④ 固定列就不顯示**，只看 ④ 頁面內那條進度（v4.268.2 使用者決定；v4.268.1 曾刪成相反方向）。⚠️ 取捨：結果列很多時 ④ 那條在列表下方，要捲動才看得到——這是 CodeX 34e4e1e P2 當初要保留固定列的原因 |
| 人員對照 | 列出 Sheet 出現過的人名，填 email →「驗證」→ 記住，下次自動帶入；已對照的可「修改」 |
| 送出 | 逐列開單；被擋下的列不送 |
| 重推狀態 | 已開單但推狀態失敗的列，只重推狀態，不重開 |
| 查詢結果 | 結果待確認的列，去 Meegle 查到底有沒有開出來 |
| 修正後重送 | 開單失敗（伺服器明確拒絕、沒開出任何東西）的列 |
| 匯出結果 | 前端產 CSV |

### 規則（跟使用者、CodeX 討論定案）
- **列規則只有一份**：`shared/meegle-batch-rules.ts` 的 `planRow()`，前端預覽與伺服器都用它（CLAUDE.md 跨功能踩坑 #3）
- **任務名稱**：「摘要」→「標題」；都空就擋
- **人員欄名**（v4.263.5，使用者決定不改 Sheet）：回報者／回報人／填寫人、RD負責人／RD、QA驗證人員。依序找**第一個存在的欄位**；該欄這列空白就是沒人，不會跳去下一個欄名（`roleColumn()`）
- **重複的標題列**（v4.263.5）：分段的 Sheet 每段開頭會再出現一次標題列。至少 2 格等於自己欄名 → 擋下，人名清單也略過它。不擋的話會開出一張叫「摘要」的單（`isRepeatedHeaderRow()`）
- **關聯需求**：逐列指定 → Sheet「關聯需求」欄 → 整批預設。**有填但對不到（找不到、同名多筆）就擋，不退回預設**——退回等於掛到使用者沒選的需求底下。送出前伺服器再確認需求還在允許的空間
- **人員**：Sheet 存的是暱稱，靠 `meegle_person_map`（Sheet 寫法正規化後 → Meegle user_key）換。用 Sheet 的**完整寫法**當鍵：「Jenny Hsu」「Jenny Lin」是兩筆。
  **對不上的名字，那個角色留空、不擋整列**（使用者決定，CodeX 原建議是擋；為了不靜默丟資料，預覽標黃、寫明哪個角色留空）。前端送人名，**伺服器自己查對照表**，不收前端給的 user_key
- **驗證 email**：先 `user search`；查不到再從空間既有單子的參與人找（MQL `all_participate_persons()` 用顯示名稱精確比對）。**兩條路都要 email 完全相同才算**，名稱只用來縮小範圍
- **推狀態**：比對 **state_key**，不比名稱；每張單即時查 transition（Jira 那次 transition id 套錯的教訓，見 `01-jira.md`）

### 防重複開單（`server/meegle-batch-store.ts`，CodeX review）
前端逐列呼叫，斷線／逾時／重整後再按一次送出，伺服器不記得就會開第二張。表 `meegle_batch_rows`（batch_id＋列號）：

| 狀態 | 再送一次會怎樣 |
|---|---|
| `creating`（開單中） | 不開，回目前狀態 |
| `created` | 不重開，只補推狀態 |
| `unknown`（逾時／看不懂回應／開單途中重啟） | 不開，要先「查詢結果」 |
| `failed`（伺服器明確拒絕，`retriable=false`） | 可以重送 |

- 認領用 `BEGIN IMMEDIATE` 交易，兩個請求同時進來只有一個拿得到；結果只能從 `creating` 寫出去，晚到的舊結果蓋不掉
- `creating` 超過 5 分鐘（伺服器在開單途中重啟）→ 轉 `unknown`，不會被當成可重送
- **查詢結果**：用名稱＋關聯需求＋建立日期（MQL 只到「日」）找，排除已記在別列的單號；唯一一張才收，零張改 `failed`，多張維持待確認請人判斷
- **跨批次**：記下來源 Sheet（v4.265.0 起存 token＋sheet id 的識別值，不存完整網址——CodeX review `0c30dde` [P2]：`&from=share` 這種尾巴會讓比完整網址的防重複被繞過），下次讀同一份 Sheet，同列號＋同名稱開過的標「已在 Meegle 開過」、預設不勾；Sheet 已有「Jira issue key」的也預設不勾
- **批次綁定來源 Sheet**（v4.263.1，CodeX review `999f895` [P1]）：同一個 batchId 已有別份 Sheet 的列 → 拒絕（`SOURCE_MISMATCH`）。
  否則換 Sheet 沿用舊批次時，B 表第 3 列會撞到 A 表第 3 列，回傳 A 的單號、B 沒開，還可能推 A 的狀態。前端每次讀 Sheet 都換新批次
- **同一份 Sheet 同一列，任何批次還在 creating／unknown → 擋**（v4.263.1，CodeX [P1]）：batchId 只活在前端記憶體，重整後換新，
  只看 (batchId, 列號) 擋不住「重整後再按一次送出」。讀 Sheet 時把這些列接回**原批次**顯示在送出結果，按「查詢結果」用的是舊 batchId
- **查回收成 created 後要補推狀態**（v4.263.1，CodeX [P2]）：`needsStatePush()`——已開單、有目標狀態、還沒推成功就補推
- **重整後也要接回「已開單但狀態未推完」的列**（v4.263.2，CodeX review `df9b538` [P2]）：只接回待確認的話，推狀態前中斷／推失敗的列只剩「已開過」、沒有重推入口。
  判斷用 `shared/meegle-batch-rules.ts` 的 `isRestorablePrevious()`，伺服器的 `needsStatePush()` 也呼叫它。**重推一律用該列送出時的目標狀態與批次**，不用畫面上目前選的
- **送出撞到「已開過」一律不推狀態**（v4.265.0，CodeX review `0c30dde` [P2]×2）：那筆可能是別人開的（用我的 token 推別人的單），或原本刻意不推；補推只走「重推狀態」
- **目標狀態只有一個來源：伺服器紀錄**（v4.263.3，CodeX review `4bc4fa9` [P2]）：`adoptTarget()`——紀錄有目標就用紀錄的，請求帶的只在紀錄沒有時採用並寫回。
  雙分頁情境：A 目標「可本機測試」、B 選「完成」送同一列 → B 接回 A 的紀錄，重推仍推「可本機測試」。`publicRow()` 回傳 `targetStateKey`，前端不自己記
- **跨批次同列同名已開成功 → 也擋**（v4.263.3）：B 分頁在 A 送出前就讀了 Sheet，預覽看不到「已開過」，只擋 pending 的話 B 會開第二張。名稱改過視為新的一筆

### ⚠️ 踩坑（2026-10-01 用 CLI 1.0.23 實測）
1. **`workitem create --fields` 的值一律要字串**，數字會被擋（`MCPGatewayRequestMismatch`）；`role_owners` 要先 `JSON.stringify`
2. **5 個角色可以在建單時一次設好；任一人員無效整張單不會建立**（`ErrnoCannotFindUserInfo`）——沒有「單開了角色沒補上」的半成品，所以不需要「只補角色」的流程
3. **CLI 外層的 `error.retryable` 不可信**：同一個錯誤 server 寫 `retriable=false`，外層卻是 `true`。分類看 server 訊息；看不出來一律當 `unknown`（寧可擋重送）
4. **狀態流的 transition id 隨目前狀態改變**（待辦→可本機測試是 3238341，從可本機測試出發是另一組）
5. **MQL 一頁 50 筆，第 2 頁之後 `session_id`／`list` 是 null**——要記第一頁的，每頁重讀會停在第 2 頁
6. **`user search` 不是完整名錄**：Tim 掛在既有單子的角色上，但用名字、email、user_key 都查不到
7. **MQL 的人名比對大小寫有別**（`'Tim'` 查得到、`'tim'` 回 3011）
8. 「任務項」是狀態流、10 個狀態全連通；目前每個狀態都沒有必填欄位（`list-state-required` 回 `{}`）

### 驗證
- `npx tsx server/meegle-workitem.test.ts`（48）、`npx tsx server/meegle-batch-store.test.ts`（40）、`npx tsx shared/meegle-batch-rules.test.ts`（38）
- 突變都紅在對應那幾條：相信外層 retryable、翻頁每頁重讀 session、沒單號當失敗、逾時列可重新認領、晚到結果蓋掉 created

### 回填 Sheet 與操作紀錄（v4.267.0，使用者要求追溯、CodeX 設計 review）
開單成功後**伺服器端**馬上回填四欄：「**Meegle 單號**」（超連結）、「**處理階段**」（已開單（Meegle）／已開單（Meegle）・已推到 X／…推到 X 未完成）、「**處理時間**」、「**單子標題貼這↓**」（v4.267.3，**跟 Jira 回填同格式**：單號超連結＋換行＋任務名稱；欄名比對忽略空白與 ↓，沿用表上既有那欄）。⚠️ 副作用：Jira 開單頁會跳過這欄有值的列，所以 Meegle 開過的列在 Jira 頁也被當成已開單——這是預期的。**這一欄已經有別張單（例如 Jira 的 CGFB-50，或別的 Meegle 單號）就不覆蓋、保留原值**，其他三欄照寫，④／歷史顯示附註（v4.267.4，CodeX review `15ba814`）。只有空白、或第一個字完全等於同一張 Meegle 單號（補寫回）才寫——用 startsWith 會把 #151914590 當成 #15191459。讀表頭找欄位（摘要／標題／單子標題貼這）跟寫入 helper 共用同一支 `normalizeColName`（忽略空白、換行、↓↑→←、大小寫；v4.267.5，CodeX review `0e11d3a`）——原本讀只忽略空白和 ↓，「單子標題貼這→」讀的時候找不到（以為沒有舊值）、寫的時候卻找到原欄，照樣蓋掉 Jira 單。欄位不存在就自動加在最右邊（使用者選 A）。實作：`server/meegle-sheet-writeback.ts`

| 規則 | 為什麼 |
|---|---|
| 回填 pending 跟「開單成功／查回成功／推狀態結果」**同一筆 UPDATE** 落地 | 程序在中間掛掉也知道要補寫（CodeX） |
| **寫入前讀那一列的摘要／標題，跟開單時的名稱不同就不寫**（標「列已變動」） | 列號是讀 Sheet 當下的，之後插列／刪列就會寫到別列。⚠️ 只是防呆：同名列被刪、另一筆補到同位置照樣會過；讀完到寫入之間插列也擋不住（CodeX）。可靠的做法是「來源列 UUID」欄，下一版選項 |
| 讀那一列要用 `valueRenderOption=FormattedValue` | **「摘要」常是公式**（實測 `"["&F2&"]["&E2&"]"&I2`），預設回公式原文，每列都會被當成列已變動 |
| 超連結用 richtext segments | `{type:'url',text,link}` 會被 Lark 拒絕（實測 code 90204 invalid cell type） |
| **任何一欄會落在 ZZ 之後就整筆拒寫**：關卡在 `multiWritebackLarkBatch` 的 `maxColIdx` 選項——**它自己最後一次讀表頭之後、任何寫入之前**檢查（v4.267.2，CodeX review `bca81a7` [P2]）。`planColumns()` 預檢只負責給好懂的訊息 | helper 本身原本不擋：表頭滿到 ZZ 時會寫到 AAA～AAC、回傳成功。v4.267.1 只做呼叫端預檢不夠——helper 會再讀一次表頭，兩次之間被塞滿照樣寫過去。`maxColIdx` 不給＝舊行為，批次開單／對帳等既有呼叫端不受影響 |
| 寫入沿用 `multiWritebackLarkBatch` | 已處理表頭 A1:ZZ2、AA 以後欄位字母、缺欄位自動建、檢查 Lark 回應 code（Lark 失敗常回 HTTP 200）。舊 Jira 回填只看 A1:Z1、用 fromCharCode，超過 Z 會寫錯欄 |
| 同一份 Sheet 用行程內的鎖排隊；**拿到鎖才從 DB 讀最新狀態**組內容；寫完**回填版本 `writeback_rev`** 沒變才標 done／failed（v4.267.1 起；原本比 updated_at，同一毫秒的兩次更新會一樣而誤標 done——CodeX review `d7d2d20` [P2]） | 舊回填不會蓋掉新狀態（例如重推成功）。meegle-batch 只跑在主程序，所以行程內鎖就夠 |
| 只有 state_phase=done 才寫「已推到 X」 | 推失敗時寫成已推到，Sheet 上看起來完成了、Meegle 上沒有 |
| 回填失敗不影響開單；④ 顯示「已寫回／待寫回／回填失敗」，可按「補寫回」（只用已存單號，不重開） | |
| `/row`、`/confirm`、`/retry-state`、`/row/writeback` 都接回填 | CodeX |

**操作歷史紀錄**：篩選多「Meegle 開單」；明細改成表格——來源 Sheet 連結 → 每列：列號、任務名稱、Meegle 單號（可點）、關聯需求、處理階段、回填結果。舊紀錄缺的欄位顯示「—」。

**驗證**：`npx tsx server/meegle-sheet-writeback.test.ts`（30，含同毫秒更新、ZZ 邊界；改回 updated_at／拿掉 ZZ 檢查各紅 2 條）＋ `server/meegle-sheet-writeback.adapter.test.ts`（8，含箭頭變體欄名已有 Jira 值時標題欄零寫入；假 fetch 走真 adapter：兩次讀表頭之間被塞滿 → **零寫入**；拿掉 maxColIdx 紅 2 條）：不寫到別列、讀不到不寫、Lark 失敗留原因、寫途中狀態變了維持 pending、同 Sheet 排隊、只有推成功寫已推到；突變三個（拿掉名稱核對／版本檢查／鎖）都紅。**真 Sheet 實測**：使用者那份表第 2 列（真單 #15191459）回填成功——新欄「Meegle 單號」建一次、第 2 列寫入超連結＋處理階段＋時間、第 3 列沒動；第一版用 url 型別被 Lark 拒（90204）、公式摘要讀成原文對不上，兩個都是實測才抓到。瀏覽器看過歷史表格。

### 還沒做
- 來源列 UUID（可靠對應插列／排序後的列；要在 Sheet 多一欄、防重複鍵一起換）
- 附件（Sheet 的圖、測試附件）沒有帶進 Meegle
- Google Sheets 來源


### 單子網址要自己組（v4.269.1）

CLI `workitem create` 回傳的 `url` 是 `https://project.larksuite.com/{project_key}/{type_key}/detail/{id}`，**點開不會跳到那張單**（使用者 2026-10-02 實測）。Meegle 網頁認的是 `/{空間 simple_name}/{類型 api_name}/detail/{id}`（測試空間＝`/3kvkm7/task_normal/`）。`simple_name` 從 `project search --project-key` 取、`api_name` 從 `workitem meta-types` 取（`resolveDetailUrlBase`，成功才快取）。查不到時網址存空字串——畫面與 Sheet 顯示「#單號」純文字，**不退回 CLI 的壞網址**（壞連結看起來正常、點了才發現）。v4.263～4.269.0 開的 3 張單已用 `scripts/meegle-fix-detail-urls.ts` 修正（DB、操作紀錄、Sheet force 重寫）。
