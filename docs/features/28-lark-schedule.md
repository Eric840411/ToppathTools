# 排程提醒（時辰法旨）

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 28. 排程提醒（LarkSchedulePage）

**路由**：`/api/lark-schedule/*`
**page key**：`lark-schedule`
**主要檔案**：`server/routes/lark-schedule.ts`、`server/lib/lark-schedule.ts`、`server/lib/lark-schedule-runner.ts`、`src/pages/LarkSchedulePage.tsx`

### 功能說明

拿 Lark 多維表格當行程表（用日曆視圖排程）：到點把提醒卡片推進指定的 Lark 群，
群裡的人點卡片上的「✅ 完成」就直接回寫狀態／完成者／完成時間。
週期性行程寫在另一張「週期規則」表，每天自動展開未來 N 天。

tick 跑在 **server**（不是 worker）——回調端點本來就必須在 server，
放同一個 process 可以省掉跨 process 寫同一張表的併發問題。

### 使用者操作

| 操作 | 說明 |
|------|------|
| 設定 Lark 群 chat_id | 點名發送的目標群 |
| 設定白名單 | 不在白名單內的 chat_id 一律拒發（這隻 app 與其他群共用） |
| 測試發送 | 往設定的群送一張測試卡片，確認權限與 chat_id 正確 |
| 設定 Base token／行程表 table_id | 行程資料來源 |
| 設定週期規則表 table_id | 留空則不做週期展開，只跑一次性行程 |
| 設定日曆視圖 view_id | 卡片上「開啟記錄」按鈕會跳到這個視圖 |
| 設定時區 | 週期規則的「開始時刻」以這個時區解讀 |
| 設定展開天數 | 每天自動展開未來幾天的週期行程 |
| 設定逾期門檻（小時） | 開始時間過了這麼久就不推，只標記逾期 |
| 手動跑一輪（tick） | 立刻執行一次推播／回報／逾期標記 |
| 展開週期規則 | 立刻依規則表補出未來 N 天的行程 |
| 查看近期記錄 | 列出行程表最近的幾筆與目前狀態 |

---

### ⚠️ 這個功能踩過的坑（都在 v4.256.0 的 CHANGELOG 有完整敘述）

1. **數字欄位型別是數字，不代表 API 回數字。** 帶 formatter 的數字欄位實測回的是字串 `"5"`，
   不強制轉型的話「提前提醒分鐘」會靜悄悄變成 0——**提前提醒整個失效而且不報錯**。
2. **同一個 process 不等於沒有併發。** 三處會撞：tick 重入、「標記逾期」寫狀態 ↔ 完成回調寫狀態、
   兩人同時點按鈕的先讀後寫空窗。全部走 `withRecordLock` 且**鎖內重讀再判斷**。
3. **`message_id + record_id` 當冪等 key 不夠**——分不出動作（完成 vs 取消），
   也擋不住「不同卡片操作同一筆行程」。改用 `lark_schedule_claims` 的唯一鍵**原子認領**。
4. **卡片回調是同步的，沒有補推機制**——寫回失敗就是失敗，一律回可讀的 toast 叫使用者重按。
5. **回調端點不靠路徑保密**：對**原始 body bytes** 驗簽（parse 完再 stringify 鍵序會變、簽章必定對不上）、
   解密驗 verification token、300 秒時間窗、每 IP 每分鐘 60 次限流、群白名單。
6. **這隻 Lark app 是公司共用的**（同一隻也在發線上故障通知）。所以推播一律點名發送（帶 chat_id）、
   **完全不碰 app 的「事件配置」**——長連線是叢集模式隨機單播，會把別人的訊息吃掉。
7. **app id／secret 走環境變數**（`LARK_APP_ID`／`LARK_APP_SECRET`），不進配置頁也不進 DB。
   回調另需 `LARK_CALLBACK_ENCRYPT_KEY`／`LARK_CALLBACK_VERIFICATION_TOKEN`。

---

### ⚠️ 兩個容易重犯的實作細節（v4.256.1 補）

**① `tsconfig.server.json` 是 `strict: false`——可辨識聯合不會收窄。**

```ts
// ❌ server 端這樣寫會壞：沒有 strictNullChecks，字面量 boolean 不當判別式
type ClaimResult = { ok: true; claimed: true } | { ok: false; existing: {...} }
if (!r.claimed) r.existing   // TS2339: Property 'existing' does not exist
```

改成**單一形狀 + optional 欄位**（`{ claimed: boolean; existing?: ... }`），兩種設定下都成立。
⚠️ 前端 `tsconfig.json` 是 strict，所以同一個寫法在前端可行、搬到 server 就爆——
**兩邊的 tsconfig 不一樣，別把前端的習慣直接帶過來**。

**② 後端路由還沒上線時，`fetch().then(r => r.json())` 會壞得很難查。**

路由不存在時伺服器回的是 SPA 的 `index.html`，`json()` 丟 SyntaxError → unhandled rejection →
**畫面永遠停在「載入中…」，只有 console 有一行看不懂的 JSON.parse 錯誤**。
所以這一頁的請求全走 `api<T>()`：先讀 text，開頭是 `<` 就回
「後端沒有這個路由——server 可能還沒重啟到有排程提醒的版本」。
