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
- **併發**：每次換 token `token_version` +1；重新驗證的結果只在版本沒變時才寫回——驗證途中換了 token，舊結果寫不進新 token
- **資料表**：`meegle_accounts`（email 為鍵，存密文、Meegle 身分、狀態、最後成功驗證／最後嘗試時間與錯誤）、`meegle_identity_overrides`

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
- 打本機真 server：未登入 401、假 token 400、未綁定驗證 404、非管理員打對照 403、表單式 POST 被擋、綁定失敗舊綁定不動（`token_version` 不變）、已存 token 失效後重新驗證變 invalid 且最後成功時間保留、解不開標 `DECRYPT_FAILED`、DB 只有密文、log 裡搜不到 token
- ⚠️ **還沒驗的**：**真的 `X-Mcp-Token` 綁定成功**這條（需要使用者本人的 token），以及 CodeX 要求的首輪四情境（本人／他人／重置後／斷網）要用真 token 跑

### 還沒做
- 用綁定的 token 真的去開單／評論／流轉（批量工具改接 Meegle），這次只做身分綁定
- 代理授權（用別人的 Meegle 身分操作）
- Jira 退場：登入帳號、PIN、角色目前都存在 `jira_accounts`，停用 Jira 時登入系統要一起搬（CodeX 提醒，另案）
