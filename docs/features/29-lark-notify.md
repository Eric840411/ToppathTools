## 29. Lark 通知（v5.1.0）

> Discord → Lark 遷移（使用者 2026-10-03）。版面：CodeX 設計稿（普通版／修仙版）。page key：`lark-notify`（只限管理員，後端每支 API 都檢查）。
> CodeX bridge 仍留在 Discord，不在這次範圍。

### 這是什麼

工具原本的三種通知——**AutoSpin**（執行進度卡＋定時彙總報告）、**Live Ledger 對帳告警**、**週報備稿提醒**——都只能發 Discord。
現在每個功能可以各自選：

| 出口 | 行為 |
|---|---|
| Discord（預設） | 跟原本一模一樣。沒切過的功能完全不受影響 |
| Lark | 只發 Lark |
| 雙發 | 兩邊都發（過渡期用）。**一邊失敗只補送失敗那一邊**，成功那邊不重發 |

### 使用者可以做的事

1. **機器人憑證**：填 App ID／App Secret（目前用 OSM QA 機器人），按「驗證憑證」確認（不用先存）。Secret 只顯示尾碼；要換才按「更換 Secret」，留空＝保留原值
2. **目標群組**：「選擇群組」列出機器人已加入的群（翻完所有分頁），或「手填 chat ID」。按「試發」送一張測試卡片——**試發用的是欄位上的群，還沒存也能試**；正式通知要按「儲存設定」後才會改發過去
3. **各功能通知出口**：三個功能各選 Discord／Lark／雙發。週報提醒切到 Lark 時會多一欄「工具網址」（卡片上連結的目的地）
4. **@人對照狀態**：列出每個帳號的 email 能不能對到 Lark 使用者。按「重新配對」重查
5. 底部「取消」回到已存的值、「儲存設定」一次存全部

### 設計重點／為什麼這樣做

- **只發不收**：OSM QA 應用的長連線被 Claude 的 Lark 外掛佔著。工具若也連長連線，Lark 會把每個事件**隨機**送給其中一邊——兩邊都會漏訊息，而且看不出來。所以工具只用 HTTP API 發訊息／改卡片／列群／查人，**不接任何事件或卡片按鈕回呼**
- **週報提醒改成連結**：Discord 版卡片上的「確認送出」按鈕需要接回呼，Lark 版做不到（上一條），改成「開啟週報頁確認送出」連結 → `工具網址/?page=weekly-report`。開頁面會重新走登入與權限檢查，比卡片按鈕更安全
- **Secret**：存在 `settings.lark_notify_secret_enc`，用 `MEEGLE_TOKEN_KEY` 加密（跟 Meegle token 同一把）。**沒設金鑰就拒存，不退回明文**。API 回應、log、歷史紀錄都不含 Secret（上線驗證腳本會檢查這三處）
- **卡片內容不另寫一份**：各功能照舊組 Discord embed，`notify-outlet.ts` 的 `embedToLarkCard()` 轉成 Lark 卡片（標題色、inline 欄位兩兩一列、頁尾變 note）。Discord 專用的 `<@id>`、`<t:…>` 會被轉掉
- **@人**：帳號 email → `contact/v3/users/batch_get_id` 查 open_id，需要應用有 `contact:user.id:readonly`。**2026-10-03 實測 OSM QA 沒有這個權限**（code 99991672）→ 設定頁顯示「缺少權限」，通知只寫「@名字」、不會真的 @ 到人。使用者之後會去開權限，開完按「重新配對」
- **AutoSpin 進度卡**：同一台機台的狀態更新會改同一則訊息。兩邊各記各的 message id（`discordNotifyState` 的 `messageId`／`larkMessageId`），某一邊改不動（訊息被刪）只在那一邊重發新的一則
- **補送佇列**：`settings.notify_retry_queue`（server 與 worker 兩個 process 都會發通知，記憶體佇列重啟就沒了）。
  **領取用持久化租約**（v5.1.1，CodeX review）：在 transaction 裡標 `leaseUntil`（5 分鐘），**成功才刪、失敗放回**（次數 +1、解除租約）；process 送到一半死掉，租約過期後任一個 process 會重新領取。v5.1.0 是「讀出＋清空再送」，中途 crash 整批遺失。代價是極少數情況重送一次（至少一次，不會漏）。
  **期限在領取時檢查**（10 次或排了 24 小時）：過期的直接移除、不送、寫 warn log。v5.1.0 是先送才檢查，25 小時的項目仍會送出。
  補送**不看目前出口設定**（排進去時要送的那邊就是要送）。
  只有**最終狀態**（AutoSpin 完成／失敗／停止、Live Ledger 告警）才排補送；AutoSpin 中途狀態與定時彙總報告不排（下一次更新／下一期本來就會來）。沒設定（沒憑證、沒選群）標 skipped 不排——排了也不會好
- **Live Ledger**：兩邊都失敗＝這批不標「已通知」、下一輪整批重送（原本的行為）；只有一邊失敗＝標已通知、失敗那邊排補送

### 檔案

| 檔案 | 內容 |
|---|---|
| `server/lark-notify.ts` | Lark API：tenant token、列群（分頁）、發卡片、改卡片、email→open_id、機器人名稱；設定讀寫（Secret 加密） |
| `server/notify-outlet.ts` | 出口設定、embed→卡片、Lark @人、`deliverNotice()`、補送佇列；`__notifyTestSeam` 測試縫 |
| `server/routes/lark-notify.ts` | `/api/lark-notify/config`（GET／PUT）、`verify`、`chats`、`test`、`mentions`；每 2 分鐘 flush 補送 |
| `src/pages/LarkNotifySettingsPage.tsx/.css` | 設定頁 |
| 接入點 | `routes/autospin.ts` 的 `notifyDiscord`／定時彙總報告／彙總報告試發；`live-ledger-notify.ts` 的 `runNotifyCycle`／`sendNotifyTest`；`routes/weekly-report.ts` 的 `sendWeeklyReminder` |

### 測試

- `npx tsx server/notify-outlet.test.ts`：24 條，走測試縫、不寫正式設定。突變驗過：補送時拿掉「只送失敗那邊」、拿掉「沒設定不排補送」、改回「先清空再送」、拿掉「送前檢查期限」、不接例外，都會紅在斷言上
- `node scripts/ui-checks/lark-notify-live-check.mjs`：打真的伺服器 26 項——沒登入 6 支 API 全 403、錯 Secret 被拒、存進去是密文、試發真的進群、不存在的群回失敗、三個功能切 Lark 真的發出（結束還原出口）、API 回應／pm2 log／歷史紀錄都沒有 Secret
- `node scripts/ui-checks/lark-notify-walkthrough.mjs`：頁面兩種主題走查（試發攔下來不真的送）。包含「儲存鈕出現在畫面上時都沒被右下角 AI Agent 浮窗蓋住」——第一版的儲存列是 sticky，正好被浮窗蓋住；只量捲到底量不出來（sticky 在底部會歸位），要每個捲動位置都量

### 踩坑

- `GET /open-apis/bot/v3/info` 的回應把 `bot` 放在**最外層**、不在 `data` 底下，不能走共用的 `api()`
- server 的 tsconfig 不是 strict，`if (!r.ok) return r` 不會收窄判別聯集 → 失敗結果要轉型時用 `asFail()`
- 設定頁載入時群組與 @人兩個請求同時跑，共用一個 busy 旗標會互相蓋掉，讀取中卻顯示成「先儲存憑證才讀得到群組」→ 各自一個旗標
