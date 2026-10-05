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
| 讀取 Sheet | 貼 Lark Sheet 網址。**在任一個分頁讀成功過的網址，切到其他分頁（開單／評論／狀態／修改）會自動帶入**，重整頁面也記得（存 localStorage `meegle-tools-last-sheet`）。v5.0.0 搬出 Jira 時這個行為弄丟過，v5.7.1 補回（`node scripts/ui-checks/meegle-tabs-share-sheet.mjs`）。只支援 Lark |
| 關聯需求預設 | Meegle「任務項」的關聯需求是**必填**。整批選一個；Sheet 有「關聯需求」欄（填名稱或需求 ID）就以那欄為準 |
| 受托人／Code Review | Sheet 沒有這兩欄，整批選一個（下拉只列已對照過的人），可逐列改 |
| 開單後推到 | 整批選一個狀態；不選就停在初始狀態。**「進度」欄不使用**（使用者：進度不等於 Meegle 狀態） |
| 編輯（逐列） | 改這列的關聯需求、五個角色（填 Sheet 上的人名） |
| 批量設定（v4.264.0） | 勾幾列 →「批量設定已勾選的 N 列」→ 一次設關聯需求／五個角色；留空不改，人名取代 Sheet 值；「清除這些列的手動設定」回到 Sheet／整批預設。被擋下的列也能勾（才補得了設定），送出仍只取通過檢查的。**人員欄可以選多個人**（v5.6.0，使用者要 QA 驗證複選；五個角色都一樣）：從名單選完變標籤、× 移除、重複的不會多一個；資料層本來就收逗號分隔的多人，原本是單選輸入框選第二個會蓋掉第一個。驗證 `node scripts/ui-checks/meegle-bulk-multi-people.mjs` |
| 進度列（v4.264.0；v4.268.2 調整） | 送出時固定在畫面下方：進度、已開單／推狀態失敗／待確認／失敗；在 ①～③ 顯示，「看結果」跳到 ④。**到了 ④ 固定列就不顯示**，只看 ④ 頁面內那條進度（v4.268.2 使用者決定；v4.268.1 曾刪成相反方向）。⚠️ 取捨：結果列很多時 ④ 那條在列表下方，要捲動才看得到——這是 CodeX 34e4e1e P2 當初要保留固定列的原因 |
| 人員對照 | 列出 Sheet 出現過的人名，填 email →「驗證」→ 記住，下次自動帶入；已對照的可「修改」 |
| 選人／自動猜人（v5.2.0） | 進 ② 自動讀「空間角色人員」名單（約 20 秒，伺服器快取 10 分鐘），email 格可直接打名字或 email 從名單選；未對照的名字會自動猜人並預填 email（**只預填、不寫入**），綠色＝可「全部確認」、黃色＝要逐列按「驗證」。「重新整理名單」強制重掃。找不到的人照舊手打 email |
| 全部確認（v5.2.0） | 一次確認所有綠色建議（名字完全相同＋名單裡唯一＋Meegle 名錄也唯一，而且格子裡還是建議的 email）；逐筆走原本的「驗證」 |
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
- **選人與猜人（v5.2.0，使用者要求、CodeX 兩輪確認）**：
  - **名單＝這個空間所有任務項 5 個角色上出現過的人**（`listSpaceRoster`）。不是 Meegle 名錄：`user search` 實測只查得到空間 65 個角色人員中的 29 個（Tim 等查不到），`team list` 回空；掃全部任務項（1452 張、約 16 秒）拿得到全部 65 人。限制：沒在這個空間掛過角色的人不在名單裡（手打 email）。畫面寫「空間角色人員」，不要寫成完整名錄。快取依「空間＋操作者」，只有整份讀完才更新，同一人同時兩個請求共用一次掃描
  - **猜人**（`shared/meegle-people-match.ts` 的 `matchRoster`，一層命中就停）：exact＝完整名字等於 Meegle 顯示名稱；partial＝第一個詞等於顯示名稱（「Tim Chen」→ Tim）或等於 email 前綴（「yenting」）。沒 email 的同名者也算人數（先丟掉會把兩人算成唯一）
  - **全部確認只收 exact＋名單唯一＋租戶名錄唯一**（`bulkVerdict`）。名錄檢查用 MQL `all_participate_persons('名字')`：Meegle 會拿**整個租戶名錄**解析名字——同名回 **3012** 並列出所有 user_key（實測 Eric 有兩個帳號，另一個沒掛過角色、user search 也查不到），沒這個名字回 3011。只有查詢成功才算唯一；3011、3012、逾時都降級逐列確認
  - **verify 收 userKey，但伺服器重新核對**：從名單選人時前端帶 userKey，伺服器用自己掃的名單（或 user search）確認 userKey 與 email 對得上才寫入；**不走名字 MQL**（同名的人會卡 3012）。沒帶 userKey 時 user search 查不到 → 先查名單裡有沒有恰好一個人是這個 email → 再退回舊的名字 MQL。verify 仍然**不能證明他就是 Sheet 指的人**，那是使用者按確認時的責任
  - **晚回保護**：每次讀 Sheet／重新整理名單換一個序號，舊回應丟掉；建議只填「還沒手動填過」的格子；使用者改過 email 的列不算進全部確認
  - ⚠️ `user search --user-keys a b` 實測**只查第一個**，要每個值重複一次旗標（v5.2.0 順手修了 `resolveUsersByEmail`；之前呼叫端都只傳一個，沒出事）
  - 驗證：`npx tsx shared/meegle-people-match.test.ts`（16）、`npx tsx server/meegle-workitem.test.ts`（73；名單掃一半失敗、3011／3012／逾時、沒 email 計數、重複旗標各有突變驗過會紅）、`node scripts/ui-checks/meegle-people-suggest.mjs`（真名單＋假 Sheet／verify、兩種主題；晚回與換 Sheet 拿掉序號檢查會紅）
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

## 28c. Meegle 批量評論（Jira 頁「Meegle 評論」分頁，v4.270.3 後端／v4.271.0 分頁上線）

取代 Jira 批量評論，**Sheet 不用改**（使用者：無痛轉移）。Jira 評論要求的五區塊【功能目的】【前置條件】【測試步驟】【說明與備註】【驗證結果】
正好是 Meegle 任務項「測試頁 → 測試說明」（field_89ff93）的範本，所以「評論內容欄」整格寫進測試說明（使用者選：整格換掉）。

**每列送出做的事**（`server/meegle-comment-run.ts`，順序固定，前一步沒成功就停在那一列）：
1. 覆寫測試說明：送出前讀現況 → 跟預覽看到的 hash 不同就停；被人改過（有基準且不同）而沒在預覽確認就停 → 圖片傳成富文本圖片（resource-type 16）嵌在最後 → 寫入 → **讀回比對**（只做 Meegle 已知改寫的正規化：空行、圖片 uuid 註解）一致才更新基準
2. 評論（使用者要 Comments 也留一則）
3. 每支影片各一則評論附件（resource-type 13）——實測評論帶附件會拆成兩則、兩個 file-token 只生效一個
4. AI 完整性分析（有開才做，沒開記 skipped）
5. 全部成功才回填 Sheet「處理階段＝添加評論」＋處理時間；寫之前讀那一列的「Meegle 單號」，第一個字不是這張單就不寫

**防重送**（`server/meegle-comment-store.ts`）：每步 none → creating → done／failed／unknown。creating／unknown 一律擋（含跨批次，認領在 IMMEDIATE 交易）。
評論不回 comment_id、HTML 註解會被剝掉（藏不了標記）→ 結果不明時只列「候選評論」（同建立者＋時間之後＋內文相同）**讓人確認**，絕不自動判成功或重送。
跨批次已 comment=done 視為已評論，要再送一輪必須明確勾選。列鍵＝Meegle 單號＋Sheet 來源鍵（不靠列號）；同 Sheet 兩列指同單在預覽就擋。

**覆寫判斷**（使用者選 B）：empty（空白／純範本）、same（跟上次工具寫入讀回值相同）→ 直接覆寫；changed（有基準且不同）→ 預覽顯示原文／新版、要確認；
has-content（沒有基準、有內容）→ 只標「已有內容」，不宣稱被改過、不強制確認。確認綁定當下的遠端 hash，送出前後端再比。

**身分**：可用「填寫人」身分送出：對方綁了 Meegle（綁定有效）＋操作者有 `meegle.comment.batch` 代理授權（獨立權限，不繼承 Jira）。每列送出前後端重驗。

**AI**：③預覽時跑（決策紀錄見 docs/decisions.md），prompt 與 Jira 版共用 `server/comment-ai.ts`。

**API**：`/api/meegle/comment/` identities、remote、ai、previous、row、row/candidates、row/resolve、row/writeback、finish（操作紀錄 feature＝`meegle-batch-comment`）。

**已知限制**：Meegle 沒有條件式更新，送出前最後一次讀到寫入之間被改的內容會被蓋掉（docs/decisions.md）。

| 操作 | 說明 |
|---|---|
| 測試 | `npx tsx server/meegle-comment-ops.test.ts`（37）、`meegle-comment-store.test.ts`（30）、`meegle-comment-run.test.ts`（30），安全規則逐條拿掉都會紅 |

**分頁（v4.271.0，CodeX 設計圖 1:1）**：`src/pages/MeegleBatchCommentTab.tsx`（樣式沿用 MeegleBatchCreateTab.css＋MeegleBatchCommentTab.css）。③ 進入時預載附件（沿用 Jira 的 attachment-prefetch）、**同時最多 3 張**讀 Meegle 現況、再逐列跑 AI。手改正文會讓 AI 結果版本失效（rev），晚回的 AI 不蓋新稿、舊分析標「需重新分析」。單子網址前綴由 `/api/meegle/comment/meta` 給（不在前端寫死，v4.269.1 的坑）。Sheet 文字規則（AI 原文、環境推導、五區塊檢查）跟 Jira 批量評論共用 `src/features/batch-comment/comment-text.ts`。

| 操作 | 說明 |
|---|---|
| 讀取 Sheet | 用「Meegle 單號」欄認單；只有 Jira 單號的列標「缺 Meegle 單號」、兩列同單號標「重複單號」都不能勾 |
| 預設勾選 | 處理階段空白或「已開單…」、沒評論過的列；評論過的列勾了＝再送一輪 |
| 欄位與身分 | 評論內容欄必選；填寫人欄選了會逐一檢查綁定與「Meegle 批量評論」授權，不能用的列擋下 |
| 逐列預覽 | 測試說明、評論可直接改；圖片可移除、影片可新增／移除；每列常駐「重新載入附件」（v4.275.0：從 Sheet 重抓，手動移除的會回來、手動新增的保留；同列同時只跑一個請求；頂部「重新載入失敗的附件」只在有失敗時出現、略過載入中的列）；遠端被改過要勾「確認覆寫」；格式不完整只警告（同 Jira）。格式檢查接受行首編號／清單符號（1. 1、 1) 1） (1) （1） - * • 都剝掉，「1. 目的：」＝「目的：」，v4.274.7；測試 `src/features/batch-comment/comment-text.test.ts`） |
| 送出結果 | 每步驟狀態；待確認→「查詢候選」→「就是這則」／「確定沒有送出」；只剩回填失敗→「補寫回」；失敗→「修正後重送」 |
| 驗證 | `node scripts/ui-checks/meegle-comment-walkthrough.mjs`（真 Sheet 走①～③，不送出）、`meegle-comment-step4.mjs`（④ 假送出） |

### v4.272.0 修正（使用者真送踩到＋CodeX review 64f53aa 五點）

- **讀回比對只比文字**（`textFingerprint`）：Meegle 存檔會把 Markdown 解析再重新輸出——清單重新編號、`*`→`-`、子清單縮排改 4 格、`1)`→`1.`、`__粗__`→`**粗**`、部分換行合併、`<tag>` 拿掉、圖片替代文字拿掉。原本「只處理已知改寫」的 normalizeDesc 追不完，使用者真送兩張全被誤判待確認。改成拿掉清單／標題／引用標記、強調符號、反引號、HTML 標籤、所有空白後比：格式差異不算，字有任何增刪改仍算不一致。真實送出／讀回存成 `server/__fixtures__/meegle-md-sent.txt`／`meegle-md-back.txt`，測試直接用。
- **繼續送出**（`/api/meegle/comment/row/continue`）：送出時把整包內容存進 `meegle_comment_rows.payload`；測試說明已完成、還有沒做完的步驟時，用存的內容接著做（重整頁面後草稿沒了也行）。測試說明還沒成功的列不能用（要重新預覽拿最新遠端版本）。人工確認「測試說明已寫入」時順便記基準。
- **影片步驟用內容 hash**（`video:<sha256 前 16 碼>`）：重新下載 cacheId 會變、排序會變，內容不會。這次沒帶、還沒貼的影片標 skipped，不卡回填；又帶回來就回到 none。
- **附件沒載到要明確略過**：有附件失敗（或整批預載失敗）的列，勾「不帶這些附件送出」才能送。
- **AI 排隊中不能送**：開了 AI、還沒輪到的列是 queued，跟 running 一樣擋。
- **查候選用後端存的正文**：beginStep 時把要送出的內容存進步驟 data。
- **回填中斷 → failed**（不是 unknown）：回填寫的是固定值，重寫不會重複，可直接「補寫回」。
- **③ 不重跑 AI**：② 的設定沒變，「產生預覽」直接回到 ③（手改內容保留）；設定變了要重建時，AI 結果按「列＋原文＋設定」快取，原文沒變就沿用。只有「重試」「重新分析」強制重跑。

### v4.272.4 附件載入：逐列＋可重新載入

使用者回報③有時附件載入失敗、沒有備案。查 log 找到兩個原因：① Sheet「插入 → 附件」的檔案 records 只留檔名（v4.272.1 已修，改走 medias 下載）；② 伺服器重啟的時候，整批預載請求被中斷——原本**所有列一個請求**，所以一斷就全部失敗。
改成**一列一個請求、同時 2 列**：壞一列不影響別列；每列有「重新載入附件」、頂部有「重新載入失敗的附件」；錯誤訊息逐個列出檔名與原因；載入中的列不能送；使用者手動加的附件（manual）重新載入時保留。驗證：`node scripts/ui-checks/meegle-comment-attachments.mjs`（假的預載第一次失敗、第二次成功）。

## 28d. Meegle 批量更新狀態（Jira 頁「Meegle 狀態」分頁，後端 v4.276.0／分頁 v4.277.0）

取代 Jira 批量更新狀態，**Sheet 不用改**，用「Meegle 單號」欄認單。身分只用登入者本人的綁定（跟 Jira 版一樣沒有代理）。
後端：`server/routes/meegle-status.ts`（路由）、`server/meegle-status-run.ts`（流程）、`server/meegle-status-store.ts`（分步紀錄）、
`server/meegle-status-ops.ts`（CLI）；前後端共用規則 `shared/meegle-status-rules.ts`。測試 `npx tsx server/meegle-status.test.ts`。

### 規則（使用者 10/02 拍板、CodeX 同意）
| 項目 | 規則 |
|---|---|
| 目標狀態 | 優先序固定：**預覽手改 ＞ Sheet「目標狀態」欄 ＞ 整批預設**。Sheet 填的名稱找不到、同名多個 → 擋列，不退回預設、不猜 |
| 日期（只影響 C服／完成） | 整批三選一：**保留原值（預設）**／用自動帶入／指定日期（Sheet 欄，空白退回保留原值） |
| 回填 | 成功後「處理階段＝已切換狀態」＋處理時間（跟 Jira 版同字）；回填前確認那一列還是這張單 |
| 分步紀錄 | state → date → writeback 分開記；狀態成功、日期失敗**分開**；重試只補失敗那步，日期沿用**第一次讀到的原值** |

### ⚠️ 日期自動化（2026-10-02 在 #15190441 實測，這是整個工具最容易做錯的地方）
- 轉到 **C服** → 自動化把「上C服時間」(field_cbc597) 改成今天；轉到 **完成** → 「上線時間」(field_ce2cfc) 改成今天。「本機測試完成」**沒有**自動化
- **手填的日期會被蓋掉**；自動化是轉換回 success 之後 **1～5 秒**才跑 → 轉完**立刻**寫回會被再蓋一次，**等它跑完**再寫才留得住
- 所以流程是：轉之前讀原值 → 轉 → **輪詢到看見值變了**才寫 → 延遲 3 秒讀回比對
- **20 秒看不到變動不能當成跑完**（原值本來就是今天時根本看不出來——CodeX）→ 標「**日期待確認**」，不覆寫，之後按「只補日期」
- 判斷「變了沒」的基準是**這次轉換前**重讀的值，不是第一次存的原值——重試時中間有人改過，拿舊原值比會誤判成「已經變了」而太早寫（測試抓到的）
- 日期欄存「台北當天 00:00」毫秒；**MQL 的 string_value 是 UTC 會差一天**，讀日期要用 `workitem get` 的 timestamp；`update` 的 field_value 必須是**字串**
- 突變驗證：轉完立刻寫／逾時當成跑完／重試重讀原值／baseline 用第一次原值，四個都會紅

### 批量修改前置實測（2026-10-02，#15190441，CLI 1.0.23）——還沒開始做，先記錄
- **清空**：text／multi-text／select（含優先順序）／date 都是 `field_value: ""`。⚠️ 日期給 `"0"` 不會報錯，但讀回變成 `{}`（壞值），不要用
- select 寫 **option_id**（優先順序 `option_1/2/3`＝P0/P1/P2；退件、嚴重性(QA) 的 id 是亂碼），選項清單用 `workitem meta-fields --field-keys <key>`（不帶 `--field-keys` 時不回 option）
- **角色不能用 `role_owners` 改**（建單可以、update 回 `role_owners field is not allowed in update`）→ 用 `--role-operate '{"op":"add|remove","role_key":"role_xxx","user_keys":[...]}'`
- 角色**只有 add／remove**，沒有 update／replace → 「換人」＝先 remove 舊的再 add 新的，**不是原子操作**，中間失敗會留下半套，一定要讀回驗證

### 分頁（v4.277.0，CodeX 設計圖 1:1）與使用者操作
`src/pages/MeegleBatchStatusTab.tsx`（＋`.css`，外框／步驟列沿用開單、評論的樣式）。
| 步驟 | 使用者可以做 |
|---|---|
| ① 讀取與選列 | 貼 Lark Sheet 網址讀清單；缺單號、重複單號擋列；處理階段已是「已切換狀態」的預設不勾；上次日期待確認的列會標出來並接回 ④ |
| ② 狀態與日期 | 整批目標狀態、Sheet 覆寫欄（預設找「目標狀態」欄）；日期三選一。**指定日期**：上C服／上線各自可選 Sheet 欄＋整批同一天，優先序 **該列 Sheet 有填 ＞ 整批同一天 ＞ 保留原值**；Sheet 或整批日期格式錯都**擋列**，不默默退回（使用者要兩種都給、CodeX 補擋列） |
| ③ 逐列預覽 | 每列「目前 → 目標」可直接改（預覽手改＝最高優先）；來源標「預覽／Sheet／預設」；點列看單列詳情：只顯示這次會被動到的那個日期的原值→預計值（轉 C服 只動上C服、轉完成只動上線）；原值空白＋保留＝「今天（原本空白，用自動帶入）」 |
| ④ 送出結果 | 同時最多 3 列；每列 轉狀態／日期／Sheet 回填；日期待確認黃標＋「只補日期」、回填失敗「補寫回」、其他失敗「重試」 |
- 驗證：`node scripts/ui-checks/meegle-status-walkthrough.mjs`（真 Sheet、真讀 Meegle 現況，送出用假的，兩種主題各 11 條）

## 28e. Meegle 批量修改（Jira 頁「Meegle 修改」分頁，後端 v4.278.0／分頁 v4.279.0）

取代 Jira 批量修改，Sheet 不變，用「Meegle 單號」認單，只用登入者本人的綁定。
後端：`server/routes/meegle-edit.ts`、`server/meegle-edit-run.ts`（流程）、`server/meegle-edit-store.ts`（分步紀錄）、`server/meegle-edit-ops.ts`（CLI）；
共用規則 `shared/meegle-edit-rules.ts`。測試：`npx tsx shared/meegle-edit-rules.test.ts`（26）、`npx tsx server/meegle-edit.test.ts`（22）。

### 欄位（使用者：全部，跟 Jira 一樣；Meegle 沒有「標籤」所以拿掉）
任務名稱（不能清空）／描述＋圖片／優先順序／五個角色（受托人、RD 負責人、回報者、Code Review、QA 驗證）／
測試頁：嚴重性(QA)、QA測試難易度、退件、本機測試完成時間、上C服時間、上線時間／開發說明／Gitlab 連結。
每欄四選一：不修改／Sheet 欄（該列空白＝不改）／固定值／明確清空。

### 規則（CodeX 2026-10-02 同意＋四點必修）
- **後端 resolve**：前端只送 Sheet 原文；選項用名稱比對、人員走開單那份對照表、日期同狀態工具。任何一欄換不出來 → **整列擋**（人員對不到也擋：修改照送等於把人拿掉）
- **預覽也由後端算**，回 planHash；送出重算，人員對照／選項在預覽後變了 → 擋、要求重新預覽
- **覆寫保護**：目前值必須是「預覽原值」或「要寫的新值」；角色另外允許「原值∩新值」（先 remove 再 add 做到一半）。其他樣子 → 不硬改。⚠️ 讀到寫的空窗擋不住（docs/decisions.md）
- **步驟**：fields（一次 update，含描述圖片）→ roles（逐角色 remove→add）→ verify（讀回比對，含圖片網址）→ writeback「已修改欄位」
- **圖片**：上傳成功的網址存起來，重試沿用不重傳。只加圖、沒改描述文字 → 圖接在現有描述後面（描述也要沒被別人改過）；有改描述 → 新文字＋新圖（原本的圖不保留）——使用者選項 A 待確認
- **重試**：verify 不符 → 從 fields 重做；角色做到一半 → 先讀現況核對再續做；回填失敗 →「修改完成、回填失敗」只補回填
- 突變驗證：角色不允許「做到一半」／不檢查 planHash／重試重傳圖片／讀回不驗圖片／只加圖不檢查描述被改，五個都會紅
- 真 API 在 #15190441 跑過：改名、優先順序、Gitlab、清空回報者、描述＋圖片 → 讀回全對；再用同一支 API 改回原狀（加回回報者、清空 Gitlab）

### 分頁（v4.279.0，CodeX 設計圖 1:1）與使用者操作
`src/pages/MeegleBatchEditTab.tsx`（＋`.css`）。
| 步驟 | 使用者可以做 |
|---|---|
| ① 讀取與選列 | 貼 Lark Sheet 讀清單；缺單號、重複單號擋列；處理階段已是「已修改欄位」的預設不勾 |
| ② 欄位與人員 | 7 組 15 欄，每欄 不修改／Sheet 欄／固定值（單選給下拉、日期給日期選擇器）／明確清空；圖片選 Sheet 欄。**人員對照**：選到的列裡角色欄沒對照的名字列成紅字，可從「已對照過的人」挑一個建立對照（全新的人仍要到開單分頁填 email） |
| ③ 預覽 | 左清單（可送出／受阻／未選取）；右「欄位｜原值→新值｜✎」，**後端算**；換不出來的欄位也列出來（紅字＋原因），✎ 可「只改這一列」或「這列不改這欄」；圖片縮圖與重新載入；圖片沒載到要勾「不帶這些圖片送出」 |
| ④ 送出結果 | 同時最多 2 列；每列 欄位（含圖片）／角色／讀回確認／Sheet 回填；「重試失敗步驟」（成功步驟不重跑）、回填失敗「補寫回」；受阻沒送的列列為「受阻未送出」 |
- 驗證：`node scripts/ui-checks/meegle-edit-walkthrough.mjs`（真 Sheet、真讀 Meegle、預覽真的由後端算；送出用假的，兩種主題各 11 條）
- ⚠️ walkthrough 抓到：換不出來的欄位原本不出現在預覽表 → 列被擋卻找不到要改哪裡。改成預覽回傳每一欄（含失敗原因）

## 28f. Meegle 補回填（Jira 頁「Meegle 補回填」分頁，v4.280.0）

只做「**待補記錄**」（使用者 10/02 選 B）；**不做標題對帳**——Meegle 工具的單號都存在後端，回填失敗用存下來的單號補就好，用標題猜會寫錯列。
對帳（C）只在：工具外手動開單、在另一台伺服器開的（本機與 Spug 的 DB 分開）、DB 遺失、Sheet 那格被改掉或插列——遇到再做。

- **清單**（`server/meegle-backfill.ts`）：開單／評論／狀態／修改 四張表裡，Meegle 那邊已完成、**Sheet 回填 failed**，或 pending／none **超過 2 分鐘沒動靜**（更新的可能還在寫）的列。
  其他步驟沒完成（評論待確認、日期待確認、讀回不符）不列——那不是回填的事；同一張單在更新的批次已回填成功，舊那筆不列；非 Lark Sheet 不列
- **補寫回**（`server/routes/meegle-backfill.ts`）：一律呼叫**各工具原本的 writeback**（同樣的處理階段字、同樣先核對那列、同一份 Sheet 排同一把鎖），不另寫一份；Meegle 那邊的呼叫全部擋掉
- **權限**：預設只看自己送的；admin 可切「全部人」。補寫時後端**重算一次清單**，不在清單裡（已補好、不是你的）就不寫（CodeX：執行時再確認仍符合待補條件）
- 列清單前先照各工具自己的時限把中斷的 creating 過期（時限從各 route 匯出，不另抄數字）
- **畫面**（CodeX 設計圖 1:1）：工具／Sheet 篩選、只看我的／全部人、勾選後「補寫回 N 筆」；逐列結果分「成功／列已變動不寫（略過）／Sheet 失敗」
- **依 Sheet 分組**（v5.7.0，使用者看樣稿 `mockup-meegle-backfill-grouped.html` 確認：失敗多的時候一大坨分不出來）：一份 Sheet 一塊，最近有動靜的排最上面、預設只展開第一份；標題列有失敗／待回填筆數、**最常見的失敗原因×次數**、最近時間、「這份全選」（部分勾＝半選；收合的那份也算進「補寫回 N 筆」）。原本的 Sheet 下拉拿掉；區塊內依列號排序、表格只留列號
- ⚠️ 待做（等 CodeX）：「列已變動」的列補幾次都會略過、永遠留在清單 → 使用者同意加「我自己處理了，移出清單」（只標記，不動 Sheet／Meegle），要多一個資料欄位
- 驗證：`npx tsx server/meegle-backfill.test.ts`（7，用四個工具真的資料表建資料；拿掉「等 2 分鐘」「新批次已成功不列」「其他步驟要完成」各紅一條）；`node scripts/ui-checks/meegle-backfill-walkthrough.mjs`（真的空清單＋假資料走補寫，兩種主題）
- ⚠️ 還沒用真的失敗列補寫過一次（本機目前沒有待補的列）；補寫本身走的是各工具已經真跑過的回填函式

## 28g. 移除 Jira（使用者 2026-10-02：Jira 已確定沒人用；CodeX 看過規劃）

**規劃**：① 解綁（行為不變）→ ② 週報、TestCase 改讀 Meegle（使用者選 A＝改、B＝改）→ ③ 刪 Jira 程式（不藏一版；資料表保留）→ ④ 之後再改表名。

### ① 解綁（v4.281.0）
- **帳號**：沿用 `jira_accounts`（CodeX：另開新表上線後會跟舊表分歧，退版時停權帳號可能復活；最後才改名）。**建帳號不再要 Jira Token**（登入畫面的自助新增拿掉 Token 欄；後端 token 預設空字串）
- **修 PIN 被清掉**：`upsertAccount` 原本用 `INSERT OR REPLACE`（整列刪掉再插入），管理員改名／角色／狀態就把那個人的 PIN 洗掉（CodeX 抓到）→ `ON CONFLICT DO UPDATE` 只更新帶到的欄位；寫法在 `server/account-store.ts`，測試 `server/account-store.test.ts`（改回 INSERT OR REPLACE 會紅）
- **搬出 routes/jira.ts**：帳號 → `routes/accounts.ts`、讀 Sheet → `routes/sheets.ts`（路徑本來就中性）、附件 → `routes/attachments.ts`＋`attachment-downloads.ts`。**新舊路徑掛同一個 handler**（CodeX：比轉址穩）：`/api/accounts/*`＝`/api/jira/accounts/*`、`/api/attachments/{upload,prefetch,cache}`＝`/api/jira/attachment-*`；前端全部改用新路徑
- 代理授權：中性名稱 `hasDelegation`（表仍是 `jira_account_delegates`）
- 權限 key（`jira`、`jira-ai-*`）**不改**，只改顯示名（Meegle 在用這些 key，改了大家權限會跑掉）
- 型別檢查：搬家後 server 錯誤 59 → 58，逐條比對過：沒有新增，少的那條是搬過去的帳號路由 `req.params` 型別問題被順手修掉（不是檢查器提早中斷）

### ② 週報、TestCase 改讀 Meegle（v4.282.0 TestCase／v4.283.0 週報）
- TestCase：參考單改填 Meegle 單號（`shared/meegle-ref.ts` 解析、`server/meegle-ref-fetch.ts` 讀），用自己的綁定；看不懂或讀不到任何一張整批擋下；輸出欄名「JIRA對應單號」不改
- 週報：見 `docs/features/23-weekly-report.md`「依時間撈單改撈 Meegle」

### ③ 刪 Jira（v5.0.0）
- 前端：刪 JiraPage 與四個 Jira 批量分頁、JiraAccountModal、SheetSourceToggle／SheetUrlEntryStep／JiraStepWidgets；新頁 `src/pages/MeegleToolsPage.tsx` 只放 Meegle 五個分頁（記住上次的分頁）。側邊欄「Jira 批量開單」→「Meegle 批量工具」；權限頁顯示名改 Meegle，**key 不改**
- `AccountInfo`／`accountHasRole` 從 JiraAccountModal 搬到 `src/accountTypes.ts`；遊戲版（GameApp）的切帳號改成登出回登入畫面
- 後端：刪 `routes/jira.ts`；index／worker 的 Jira 批次轉送、操作紀錄標籤一起拿掉；週報的 jira-by-range 與 Jira 撈單 helper 刪除
- 型別檢查 58 → 53：逐條比對，少的 5 條全是 jira.ts 本身的，沒有新增
- **刻意保留**（之後第 ④ 步再收）：資料表 jira_accounts／jira_account_delegates／jira_pending_writebacks；shared.ts 裡沒人呼叫的 Jira helper；`jira-attachment-files.ts` 的 uploadFileToJira；代理授權頁上已無作用的兩個 Jira 用途
