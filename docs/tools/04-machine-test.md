# 機台自動化測試

**路由**：`/api/machine-test/*`｜**歷史紀錄 feature key**：`machine-test`

---

## 功能說明

使用 Playwright 對機台進行全自動化測試，包含進入/推流/Spin/音頻/iDeck/觸屏/CCTV/退出等步驟。支援分散式多 Agent 並行（Work-Stealing 架構）。

---

## 操作流程

```
設定機台代碼清單
  └▶ 選擇大廳 URL（帳號池）
       └▶ 勾選測試步驟
            └▶ 執行測試
                 └▶ WebSocket 串流每台機器日誌
                      └▶ 結果表格（PASS/WARN/FAIL/SKIP）
                           └▶ 可寫回 Lark Sheet
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 設定機台代碼清單 | 輸入待測機台代碼（支援多台並行） |
| 選擇大廳 URL | 每個 Worker 使用一個大廳 URL（支援多 Worker 並行） |
| 勾選測試步驟 | 進入/推流/Spin/音頻/iDeck/觸屏/CCTV/退出，可組合選擇 |
| 選擇日誌 API 環境 | QAT / PROD，影響 daily-analysis URL |
| Headed 模式 | 勾選後瀏覽器視窗顯示在螢幕上（預設隱藏） |
| AI 音頻分析 | 勾選後 VB-Cable 錄音上傳 Gemini，AI 判斷音頻問題 |
| 操作流程面板 | 展開查看目前設定的步驟順序與各機種設定檔資訊 |
| 執行測試 | 啟動 Playwright，SSE 即時串流每台機器的測試日誌 |
| 停止測試 | 中止當前進行中的測試 session |
| 查看測試結果 | 表格顯示每台機器各步驟的 PASS/WARN/FAIL/SKIP 狀態 |
| Lark 回寫 | 將測試結果寫回 Lark Sheet 的 QA 問題回報欄位 |
| 從 Lark 匯入機台 | 讀取 Lark Sheet 中尚未驗證通過的機台代碼 |
| 管理機種設定檔 | 新增/編輯/刪除各機種的 bonusAction / touchPoints / iDeck XPath / 進入觸屏等設定 |
| OSMWatcher 狀態 | 查看目前 OSMWatcher 回報的機台狀態（透過 webhook 更新） |

---

## 測試步驟流程

```
導航至大廳 URL
→ 進入機台（entryTouchPoints S1/S2 → enterGMNtc）
→ [checkOsm] 推流檢測（video/canvas）
→ [checkOsm] Spin 測試（3 次點擊，比對餘額變化）
→ [checkOsm] 音頻檢測（5s VB-Cable 錄音 + dB 分析 + 可選 AI）
→ [checkOsm] iDeck 測試（XPath 按鈕點擊 + daily-analysis API 確認）
→ [checkOsm] 觸屏測試（span 文字點位 + daily-analysis API 確認）
→ [checkOsm] CCTV 號碼比對（截圖 + Gemini Vision OCR）
→ [checkOsm] 退出測試（btn_cashout → leaveGMNtc，errcode=10002 時自動重試最多 3 次）
```

> `[checkOsm]`：每步驟前檢查 OSMWatcher 狀態，若偵測到特殊遊戲（FG/JP/Handpay），執行指定 bonusAction 一次後持續 Spin 直到 status=0。

---

## 分散式 Work-Stealing 架構

```
Server (JobQueue)
  ├▶ Agent A → claim_job → 測試機台 1 → job_done → claim_job → 機台 4...
  ├▶ Agent B → claim_job → 測試機台 2 → job_done → claim_job → 機台 5...
  └▶ Agent C → claim_job → 測試機台 3 → job_done → no_more_jobs
```

- Server 建立 JobQueue（含所有待測機台），不預先分配
- 各 Agent 透過 `claim_job` → `job_assigned`/`no_more_jobs` 動態領取
- 最快跑完的 Agent 自動接手更多機台

---

## 機種設定檔欄位

| 欄位 | 說明 |
|------|------|
| `machineType` | 機種識別碼，從機台代碼中段提取（如 JJBX） |
| `bonusAction` | 遇特殊遊戲時的動作：`auto_wait` / `spin` / `takewin` / `touchscreen` |
| `touchPoints` | 觸屏測試點位（span 文字內容清單） |
| `clickTake` | 觸屏完成後是否額外點擊 .btn_take |
| `spinSelector` | 自訂 Spin 按鈕 CSS selector |
| `balanceSelector` | 自訂餘額元素 CSS selector |
| `exitSelector` | 自訂退出按鈕 CSS selector |
| `ideckRowClass` | iDeck 按鈕所在 row 的 class（如 row4） |
| `ideckXpaths` | iDeck 按鈕 XPath 列表 |
| `entryTouchPoints` | 進入機台第一階段觸屏（選擇面額等） |
| `entryTouchPoints2` | 進入機台第二階段觸屏（YES/NO 確認） |
| `gmid` | gameid URL 參數，用於設定檔 fallback 比對 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/machine-test/start` | 啟動測試 Session |
| POST | `/api/machine-test/stop/:id` | 停止 Session |
| GET | `/api/machine-test/status` | 查詢 Session 狀態 |
| POST | `/api/machine-test/osm-status` | OSMWatcher Webhook（無需認證） |
| GET | `/api/machine-test/osm-status` | 查詢機台狀態 |
| POST | `/api/machine-test/lark-machines` | 從 Lark 匯入機台清單 |
| POST | `/api/machine-test/lark-writeback` | 結果寫回 Lark |
| GET | `/api/machine-test/profiles` | 取得機種設定檔 |
| PUT | `/api/machine-test/profiles` | 儲存機種設定檔 |
| WS | `/ws/machine-test/events` | 即時測試進度 |
| WS | `/ws/agent` | Agent 協調（Work-Stealing） |

---

## OSMWatcher 串接

詳見 [OSMWatcher 串接說明](../osmwatcher.md)
