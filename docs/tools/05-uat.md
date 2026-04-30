# UAT 整合測試

**路由**：`/api/osm-uat/*`｜**Server 檔案**：`server/routes/osm-uat.ts`

---

## 功能說明

從 Lark Bitable 讀取 TestCase 清單，呼叫外部 OSM QA Agent 腳本（`run-lark-tc-backend.js`）執行後端整合自動化測試，透過 SSE 即時串流測試進度與日誌。

支援三種測試類型（目前僅「後端」可用，H5 / PC 即將推出）：
- **後端**：呼叫後端 API 執行 TC
- **H5**（即將推出）
- **PC**（即將推出）

---

## 操作流程

```
填入 Lark Bitable TC URL
  └▶ 點擊「🔍 掃描」預覽 TC 數量與分類
       └▶ （可選）填入篩選條件（只跑指定任務子類型）
            └▶ （可選）填入 Dashboard Game Type / Client Version
                 └▶ 點擊「▶ 執行測試」
                      └▶ SSE 串流即時 Log
                           └▶ 測試結束，顯示統計摘要
                                └▶ （可選）點擊「■ 停止」中止測試
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 填入 Lark TC URL | 格式：`https://xxx.larksuite.com/base/{appToken}?table={tableId}` |
| 掃描 TC 清單 | 預覽 Bitable 中的 TC 數量，依「任務子類型」分組顯示 |
| 設定 TC 篩選 | 留空 = 全部跑；填入子類型名稱（逗號分隔）僅跑指定分類 |
| 設定 Dashboard Game Type | 預設 BWJL，可覆蓋（影響 daily-analysis 查詢） |
| 設定 Dashboard Client Version | 預設 H5(1.5)，可覆蓋 |
| 執行測試 | 啟動外部 Node.js 腳本，SSE 串流日誌 |
| 停止測試 | 發送 SIGTERM 停止測試進程 |
| 自動捲動 | 勾選後 Log 面板自動跟隨最新輸出 |
| 清除 Log | 清空當前 Log 顯示 |

---

## 測試統計摘要

測試結束後，Log 面板上方顯示統計欄：

| 指標 | 說明 |
|------|------|
| ✅ 通過 | 自動化驗證通過的 TC 數量 |
| 🔧 需人工 | 需要人工確認的 TC 數量 |
| ⏭ 跳過 | 不適用或被篩選跳過的 TC 數量 |
| ❌ 失敗 | 自動化驗證失敗的 TC 數量 |

---

## Log 顏色說明

| 圖示 | 顏色 | 代表 |
|------|------|------|
| ✅ | 綠色 | TC 通過 |
| ❌ | 紅色 | TC 失敗 / 錯誤 |
| ⚠️ | 橙色 | 警告 |
| 🔧 | 紫色 | 需人工確認 |
| ⏳ / ⏰ | 藍色 | 等待中 |
| 📋 | 灰色 | 資料讀取 |
| `[...]` | 深藍色 | 測試步驟執行 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/osm-uat/stream` | SSE 訂閱測試進度 + Log |
| GET | `/api/osm-uat/status` | 查詢當前測試狀態 |
| GET | `/api/osm-uat/scan?larkUrl=...` | 掃描 Bitable TC 數量分組摘要 |
| POST | `/api/osm-uat/run` | 啟動測試 |
| POST | `/api/osm-uat/stop` | 停止測試（SIGTERM） |

---

## POST /api/osm-uat/run 請求格式

```json
{
  "larkUrl": "https://xxx.larksuite.com/base/AppToken123?table=tblXxx",
  "filter": "Daily Ranking,Daily Dashboard",
  "dashGameType": "BWJL",
  "dashClientVersion": "H5(1.5)"
}
```

- `filter`：留空 = 全跑；填入任務子類型名稱（逗號分隔）
- `dashGameType`、`dashClientVersion`：可選，留空使用預設值

---

## GET /api/osm-uat/scan 回應格式

```json
{
  "ok": true,
  "total": 47,
  "groups": [
    { "name": "Daily Ranking", "count": 12 },
    { "name": "Daily Dashboard", "count": 8 },
    { "name": "Game Lobby", "count": 27 }
  ]
}
```

---

## SSE 事件格式

| 事件名 | 資料格式 | 說明 |
|--------|---------|------|
| `log` | `{ "line": "..." }` | 單行測試 Log |
| `status` | `{ "status": "running" \| "done" \| "error", "exitCode": 0 }` | 測試狀態變更 |

---

## 底層執行腳本

```
C:\Users\user\Desktop\osm-qa-agent\run-lark-tc-backend.js
```

由 Node.js 子進程執行，環境變數傳入：

| 變數 | 說明 |
|------|------|
| `LARK_APP_TOKEN` | 從 Bitable URL 解析 |
| `LARK_TABLE_ID` | 從 Bitable URL 解析 |
| `DASH_GAME_TYPE` | 可選覆蓋 |
| `DASH_CLIENT_VERSION` | 可選覆蓋 |

---

## Session 狀態

| 狀態 | 說明 |
|------|------|
| `idle` | 待機，可啟動新測試 |
| `running` | 測試執行中 |
| `done` | 測試完成（exit code 0） |
| `error` | 測試失敗（exit code != 0 或啟動錯誤） |
