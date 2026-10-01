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

### 使用者操作
| 操作 | 說明 |
|------|------|
| 讀取 Sheet | 貼 Lark Sheet 網址（會帶入其他 Jira 分頁最後用的網址）。只支援 Lark |
| 關聯需求預設 | Meegle「任務項」的關聯需求是**必填**。整批選一個；Sheet 有「關聯需求」欄（填名稱或需求 ID）就以那欄為準 |
| 受托人／Code Review | Sheet 沒有這兩欄，整批選一個（下拉只列已對照過的人），可逐列改 |
| 開單後推到 | 整批選一個狀態；不選就停在初始狀態。**「進度」欄不使用**（使用者：進度不等於 Meegle 狀態） |
| 編輯（逐列） | 改這列的關聯需求、五個角色（填 Sheet 上的人名） |
| 人員對照 | 列出 Sheet 出現過的人名，填 email →「驗證」→ 記住，下次自動帶入；已對照的可「修改」 |
| 送出 | 逐列開單；被擋下的列不送 |
| 重推狀態 | 已開單但推狀態失敗的列，只重推狀態，不重開 |
| 查詢結果 | 結果待確認的列，去 Meegle 查到底有沒有開出來 |
| 修正後重送 | 開單失敗（伺服器明確拒絕、沒開出任何東西）的列 |
| 匯出結果 | 前端產 CSV |

### 規則（跟使用者、CodeX 討論定案）
- **列規則只有一份**：`shared/meegle-batch-rules.ts` 的 `planRow()`，前端預覽與伺服器都用它（CLAUDE.md 跨功能踩坑 #3）
- **任務名稱**：「摘要」→「標題」；都空就擋
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
- **跨批次**：記下來源 Sheet 網址，下次讀同一份 Sheet，同列號＋同名稱開過的標「已在 Meegle 開過」、預設不勾；Sheet 已有「Jira issue key」的也預設不勾

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
- `npx tsx server/meegle-workitem.test.ts`（47）、`npx tsx server/meegle-batch-store.test.ts`（20）、`npx tsx shared/meegle-batch-rules.test.ts`（24）
- 突變都紅在對應那幾條：相信外層 retryable、翻頁每頁重讀 session、沒單號當失敗、逾時列可重新認領、晚到結果蓋掉 created

### 還沒做
- 開單後回寫 Lark Sheet（Meegle 單號、處理階段）——要先跟使用者確認欄位
- 附件（Sheet 的圖、測試附件）沒有帶進 Meegle
- Google Sheets 來源
