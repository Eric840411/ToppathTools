# UI 解析度截圖

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 17. OSM Tools — UI 解析度截圖（UiScreenshotPage）

**路由**：`/api/ui-screenshot/*`

### 功能說明
從 Lark Wiki 讀取 gmid 清單，使用 Local Agent（Playwright）對 H5 遊戲進行多解析度批量截圖，結果可回寫至 Lark Wiki TABLE。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇客戶端（H5 / PC） | **決定掃大廳與截圖走哪條流程**：H5 讀 DOM 卡片、PC 讀 Cocos 場景樹。預設 H5 |
| 設定 Lark Wiki URL | 指定含 gmid 清單的 Wiki 文件 URL |
| 設定遊戲 URL Template | 填入含 `{gmid}` 佔位符的遊戲 URL |
| 選擇解析度 | 11 種 H5 解析度：Mobile Portrait / Landscape / Tablet，可分組全選 |
| 設定選項 | 自動關閉面額彈窗、等待推流就緒、Headed 模式、並發數 |
| 選擇 Agent | 從已連線的 Local Agent 中選擇執行裝置 |
| 開始截圖 | Agent 以 Playwright 批量執行，SSE 即時回報任務進度 |
| 停止 | 中止當前 Run，未執行任務標為 skipped |
| 查看截圖熱圖 | gmid × 解析度 Grid，截圖縮圖即時顯示，點擊放大預覽 |
| 查看清單模式 | 以表格呈現每個任務的狀態與錯誤訊息 |
| 回寫至 Lark Wiki | 將截圖結果回寫為 Wiki TABLE（每欄一種解析度）|

---

### ⚠️ 客戶端（H5 / PC）是使用者選的，不從網址猜

**2026-09-21 改。** 原本 agent 用 `/osm-pc|[?&]platform=pc/` 打整條網址來判平台。
問題是 **H5 的正式網址本身就帶 `&platform=pc&device=mobile`**：

```
https://osm-h5-prod.osmslot.org/?token=...&platform=pc&mode=live&...&device=mobile&...
                ↑ 主機是 H5                    ↑ 但 query 說 pc
```

於是每一次 H5 都命中 PC 分支，跑去讀根本不存在的 Cocos 場景樹，在 `pcWaitLobby` 空等 60 秒。
**畫面上只會看到 `page.waitForTimeout: Target page, context or browser has been closed`**——
完全看不出是走錯分支，看起來像網路或瀏覽器的問題。

時間線：H5 這個預設模板從 `b2bf337`（2026-05-29）就帶著 `platform=pc`；
PC 判定是 `0972ec7`（2026-09-19）才加的——加 PC 支援的當下就把既有的 H5 踩掉了。

**現在的規則：**

| | |
|---|---|
| 判定依據 | 使用者在「資料來源」卡片最上面選的 **客戶端** 欄位 |
| 傳遞路徑 | 前端 → `/scan-lobby`、`/start` 的 `clientType` → agent 的 `UiScreenshotScanMessage` / `UiScreenshotRunConfig` |
| 掃大廳與截圖 | **共用同一個值**。截圖那段整個 run 只判定一次（原本三處各判一次，其中一處還拿導頁後的 `page.url()`） |
| 選的跟主機不合 | 欄位下方黃字提醒，**不自動修正**——自動修正就是又回去猜 |
| 沒帶 `clientType`（舊版 server） | 退回看 **hostname**（`osm-pc-` 開頭 → PC），**不看 query**；而且 `console.warn` 印出來 |
| 退路遇到**未知主機** | 會當成 H5。⚠️ **這是相容限制，不是判斷結果** |

> **為什麼退路不看 query**：CodeX 的建議。`platform` / `device` 這些 query 參數在兩版之間是共用的
> （`src/data/prodSimUrl.ts` 記著「PC 不用改，只要帶域名就會自動轉換」），拿它判平台必錯。

> **不要把「沒給 clientType」默默當成 H5 或 PC** —— 那正是這個 bug 原本的形狀：安靜地跑錯分支。

> ⚠️ **不能說「已經完全沒有網址判定」**（CodeX 2026-09-21 指出）。正確的範圍是：
> **有帶 `clientType` 時才完全不看網址**。舊版 server 沒帶的那條退路仍然會看主機名，
> 未知主機還是會被當成 H5，只是多了一行 warn。可以接受作為相容限制，但不要講成沒有了。

### 驗到哪一層

這條路徑有三層，**每一層要分開驗，而且要講清楚哪一層沒驗到**：

| 層 | 驗的東西 | 怎麼驗 | 狀態 |
|---|---|---|---|
| ① 畫面 → request | 點的那個客戶端有沒有進到 request body | `scripts/ui-checks/ui-screenshot-clienttype-ui.mjs` | ✅ 8 條（`/scan-lobby` 與 `/start` 兩個入口） |
| ② request → agent | 中控有沒有原樣轉給 agent | `scripts/ui-checks/ui-screenshot-clienttype-dispatch.mjs` | ✅ 7 條 |
| ③ agent → 執行分支 | agent 收到之後有沒有真的走 DOM／Cocos | 要真大廳，只能實機跑 | ❌ **沒驗到** |

**① `ui-screenshot-clienttype-ui.mjs`**——真瀏覽器開真產品頁，點真的「客戶端」按鈕，
再分別點「掃描大廳」與「開始截圖」，攔截送出去的 `POST /scan-lobby` 與 `POST /start` 看 body。
含「再點回 H5」與「reload 後仍是 PC」（設定有存起來）。

> ⚠️ **兩個入口都要驗**（CodeX 2026-09-21 指出）。最早只攔了 `/scan-lobby`——但「開始截圖」
> 是**另一段自己組 body 的程式碼**，只驗掃描等於放掉一半。突變證實了這件事：
> 只把 `/start` 那段的 `clientType` 拿掉，**前 6 條全綠、只有 `/start` 那兩條紅**。

`/agents`、`/scan-lobby`、`/start` 的回應都是假的（`/start` 刻意回 `ok:false`，
免得前端進入「執行中」狀態、按鈕變成「停止」讓後面幾條點不到）——那些不是這支在驗的東西，當腳手架用。

**② `ui-screenshot-clienttype-dispatch.mjs`**——冒充一個 agent 接上真的 `ws://<host>/ws/agent`，
打真的 `/scan-lobby` 與 `/start`，斷言 **agent 收到的派工訊息裡的 `clientType` 就是送進去那個**。
含「H5 網址選 PC 中控不得擅自更正」「沒給不得補預設」。

**突變都驗過，而且紅的是對的那幾條：**

| 注入 | 結果 |
|---|---|
| 中控改回「網址有 `platform=pc` 就強制 pc」 | ② 的第 1、4、5 條紅（第 1 條正是這個 bug 原本的形狀），2、3、6、7 維持綠 |
| 前端 `/scan-lobby` 送出時拿掉 `clientType` | ① 的 4 條 request 斷言紅，**但兩條「畫面上選中的是 X」維持綠** |
| 前端**只有** `/start` 送出時拿掉 `clientType` | ① 的 **只有 `/start` 那兩條紅**，前 6 條全綠 |

> ⚠️ 第二個注入就是這件事的重點：**畫面渲染正確，跟送出去的值正確，是兩回事。**
> v4.251.0 當下我只截了兩張畫面圖就說驗過了——那個注入證明那樣驗根本抓不到。

---
