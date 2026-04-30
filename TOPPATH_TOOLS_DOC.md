# Toppath Tools — 完整工具文檔

> 版本：v3.11.6 | 最後更新：2026-04-30

---

## 目錄

1. [系統架構與端口](#系統架構與端口)
2. [啟動方式](#啟動方式)
3. [工具一覽](#工具一覽)
4. [各工具詳細說明](#各工具詳細說明)
   - [Jira 批量開單](#1-jira-批量開單)
   - [TestCase 生成](#2-testcase-生成)
   - [OSM 版號同步](#3-osm-版號同步)
   - [機台自動化測試](#4-機台自動化測試)
   - [圖片刪除驗證](#5-圖片刪除驗證)
   - [Config 比對](#6-config-比對)
   - [AutoSpin](#7-autospin)
   - [URL 帳號池](#8-url-帳號池)
   - [Jackpot 監控](#9-jackpot-監控)
   - [Game Show 工具](#10-game-show-工具)
   - [操作歷史紀錄](#11-操作歷史紀錄)
   - [AI 模型設定](#12-ai-模型設定)
5. [API 端點總覽](#api-端點總覽)
6. [OSMWatcher 串接](#osmwatcher-串接)
7. [環境變數說明](#環境變數說明)
8. [工具腳本](#工具腳本)

---

## 系統架構與端口

```
┌─────────────────────────────────────────────────────────┐
│                     使用者瀏覽器                          │
│  http://192.168.x.x:5173  (Dev)                          │
│  http://192.168.x.x:3000  (Production Build)             │
│  https://xxxx.trycloudflare.com  (外網 Tunnel)            │
└──────────────────────────┬──────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          │                                 │
   ┌──────▼──────┐                 ┌────────▼────────┐
   │  Vite Dev   │                 │  Express Server  │
   │  Port 5173  │────Proxy /api──▶│   Port 3000      │
   └─────────────┘                 └────────┬─────────┘
                                            │
                    ┌───────────────────────┼────────────────────┐
                    │                       │                    │
             ┌──────▼──────┐        ┌───────▼──────┐    ┌───────▼──────┐
             │   SQLite DB │        │  Playwright  │    │  Discord Bot │
             │  (data.db)  │        │  (Browser)   │    │  (Bot Token) │
             └─────────────┘        └──────────────┘    └──────────────┘
```

### 端口說明

| 端口 | 服務 | 用途 |
|------|------|------|
| **3000** | Express API Server | 所有 `/api/*` 端點、靜態檔案（Production 模式） |
| **5173** | Vite Dev Server | 前端 HMR、開發模式，會 Proxy `/api` 到 port 3000 |
| **20241** | cloudflared | Cloudflare Tunnel 本機管理端口（自動分配） |

### WebSocket 端點

| 路徑 | 用途 |
|------|------|
| `/ws/machine-test/events` | 機台測試即時進度推送給前端 |
| `/ws/agent` | 分散式 Agent 心跳、領取工作（Work-Stealing） |

### SSE 端點（Server-Sent Events）

| 路徑 | 用途 |
|------|------|
| `/api/jira/batch-comment/stream` | Jira 批次評論進度串流 |
| `/api/integrations/lark/generate-testcases/stream` | TestCase 生成進度串流 |
| `/api/autospin/stream/:sessionId` | AutoSpin log 串流 |
| `/api/autospin/agent/stream/:id` | AutoSpin Agent log 串流 |
| `/api/osm-uat/stream` | OSM UAT 測試進度串流 |
| `/api/url-pool/stream` | URL 帳號池狀態變更串流 |

---

## 啟動方式

### 開發模式（內網使用，支援 HMR）

```bash
npm run dev:all
# 或雙擊 toggle.bat
```
- Express Server 跑在 `http://localhost:3000`
- Vite Dev Server 跑在 `http://localhost:5173`（`http://192.168.x.x:5173`）

### Production 模式 + 外網 Tunnel（推薦給 OSMWatcher 使用）

```bash
# 雙擊 build-and-tunnel.bat
```
流程：
1. 停掉殘留 port 3000/5173
2. `npm run build` 打包前端
3. 啟動 Express Server（port 3000）
4. 啟動 Cloudflare Tunnel
5. 顯示外網 webhook URL 並複製到剪貼簿

### 只取得外網 Tunnel URL（Server 已在跑）

```bash
# 雙擊 generate-osm-api-key.bat
```
啟動新 Tunnel，顯示 OSMWatcher webhook URL

---

## 工具一覽

| # | 工具名稱 | 路由前綴 | 主要功能 |
|---|---------|---------|---------|
| 1 | Jira 批量開單 | `/api/jira/*` | 從 Lark 讀規格，批量建 Jira Issue |
| 2 | TestCase 生成 | `/api/integrations/*` | 多份文件 → Gemini AI → TestCase → 寫回 Lark |
| 3 | OSM 版號同步 | `/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*` | 追蹤各渠道元件版本，推送告警 |
| 4 | 機台自動化測試 | `/api/machine-test/*` | Playwright 全自動測試（Spin/音頻/iDeck/CCTV） |
| 5 | 圖片刪除驗證 | `/api/image-check/*` | 驗證已刪圖片是否仍被載入 |
| 6 | Config 比對 | `/api/osm/config-compare` | serverCfg.js vs Template AI 差異分析 |
| 7 | AutoSpin | `/api/autospin/*` | 管理多台機器自動旋轉 Python Agent |
| 8 | URL 帳號池 | `/api/url-pool/*` | 管理多帳號 URL，避免帳號衝突 |
| 9 | Jackpot 監控 | `/api/osm/jackpot*` | 每 15 秒拉取獎池數值，異常推 Lark 告警 |
| 10 | Game Show 工具 | `/api/gs/*` | PDF TestCase、圖片比對、500x 統計、Log 攔截 |
| 11 | 操作歷史 | `/api/history` | 記錄所有重要操作 |
| 12 | AI 模型設定 | `/api/gemini/*`, `/api/openai/*` | 管理 API Keys、Prompt 模板 |

---

## 各工具詳細說明

---

### 1. Jira 批量開單

**路徑**：`/api/jira/*`

#### 功能
從 Lark Bitable 讀取規格，批量在 Jira 建立 Issue，支援批量評論、批量轉換狀態。

#### 操作流程

```
選擇帳號
  └▶ 讀取 Lark Bitable（規格表）
       └▶ 選擇 Jira 專案 / Issue Type
            └▶ 預覽清單
                 └▶ 確認執行
                      └▶ SSE 串流進度
                           └▶ 結果（成功 / 失敗 Issues）
```

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/jira/accounts` | 列出所有帳號 |
| POST | `/api/jira/batch-create` | 批量建立 Issues（限速 15/min） |
| POST | `/api/jira/batch-comment` | 批量評論（背景 job） |
| GET | `/api/jira/batch-comment/stream` | SSE 接收評論進度 |
| POST | `/api/jira/batch-transition` | 批量轉換狀態 |
| POST | `/api/jira/pm-batch-create` | PM 模式：自動建 Epic + Story |

#### 結果
- 每筆 Issue 回傳 Jira Key（如 `PROJ-123`）
- 失敗項目列出錯誤原因
- 可寫回 Lark Sheet 的 Jira Key 欄位

---

### 2. TestCase 生成

**路徑**：`/api/integrations/*`

#### 功能
讀取多份規格書（Lark Wiki / PDF / Google Docs，可混合），透過 Gemini 生成 TestCase，並寫回 Lark Bitable。

#### 操作流程

```
貼入規格書 URL（支援混合來源）
  └▶ 選擇 AI 模型（Gemini / Ollama / OpenAI）
       └▶ 執行生成（SSE 串流進度）
            └▶ 選擇：
                 ├▶ 寫入 Lark Bitable
                 └▶ 下載 JSON
```

#### 支援來源格式

| 來源 | 格式 |
|------|------|
| Lark Wiki | `https://xxx.larksuite.com/wiki/...` |
| Lark Docx | `https://xxx.larksuite.com/docx/...` |
| Google Docs | `https://docs.google.com/document/...` |
| PDF 上傳 | 最多 5 個檔案，multipart/form-data |

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/integrations/lark/generate-testcases` | 開始生成（返回 requestId） |
| GET | `/api/integrations/lark/generate-testcases/stream` | SSE 接收結果 |
| POST | `/api/integrations/generate-testcases-file` | 上傳檔案生成 |
| POST | `/api/google/sheets/records` | 讀取 Google Sheet |
| POST | `/api/lark/sheets/writeback` | 寫回 Lark Sheet |

---

### 3. OSM 版號同步

**路徑**：`/api/osm/*`、`/api/luckylink/*`、`/api/toppath/*`

#### 功能
追蹤 OSM / LuckyLink / Toppath 各元件版本，同步渠道機器設定，偵測版本落差後推送 Lark 告警。

#### 操作流程

```
拉取版本歷史（OSM / LuckyLink / Toppath）
  └▶ 比對各渠道目標版本（從 Lark Sheet 同步）
       └▶ 發送版本告警到 Lark（手動 or 定時 Cron）
            └▶ 同步全渠道機器設定（machine push/pull）
```

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/osm/version-history` | 拉取 OSM 版本歷史 |
| GET | `/api/luckylink/version-history` | LuckyLink 版本 |
| GET | `/api/toppath/version-history` | Toppath 版本 |
| POST | `/api/osm/alert` | 手動觸發版本告警 |
| POST | `/api/osm/alert/config` | 設定排程告警（cron） |
| POST | `/api/osm/sync-targets-from-lark` | 從 Lark 同步目標版本 |
| POST | `/api/osm/config-compare` | Config 比對（AI 分析） |

---

### 4. 機台自動化測試

**路徑**：`/api/machine-test/*`

#### 功能
使用 Playwright 對機台進行全自動化測試，包含進入/推流/Spin/音頻/iDeck/觸屏/CCTV/退出等步驟。支援分散式多 Agent 並行。

#### 操作流程

```
設定機台代碼清單
  └▶ 選擇大廳 URL（帳號池）
       └▶ 勾選測試步驟
            └▶ 執行測試
                 └▶ WebSocket 串流每台機器日誌
                      └▶ 結果表格（PASS/WARN/FAIL/SKIP）
                           └▶ 可寫回 Lark Sheet
```

#### 測試步驟流程

```
導航至大廳 URL
→ 進入機台（entryTouchPoints S1/S2 → enterGMNtc）
→ [checkOsm] 推流檢測（video/canvas）
→ [checkOsm] Spin 測試（3 次點擊，比對餘額變化）
→ [checkOsm] 音頻檢測（5s VB-Cable 錄音 + dB 分析）
→ [checkOsm] iDeck 測試（XPath 按鈕點擊 + daily-analysis API）
→ [checkOsm] 觸屏測試（span 文字點位 + daily-analysis API）
→ [checkOsm] CCTV 號碼比對（截圖 + Gemini Vision OCR）
→ [checkOsm] 退出測試（btn_cashout → leaveGMNtc）
```

#### 分散式架構

```
Server (JobQueue)
  ├▶ Agent A → claim_job → 測試機台 1 → job_done → claim_job → 機台 4...
  ├▶ Agent B → claim_job → 測試機台 2 → job_done → claim_job → 機台 5...
  └▶ Agent C → claim_job → 測試機台 3 → job_done → no_more_jobs
```

#### OSMWatcher 串接

```
OSMWatcher → POST /api/machine-test/osm-status
  Body: { "gmlist": [{ "id": "GMID", "status": 0 }] }
  Response: { "error": 0, "errordes": "success" }
```

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/machine-test/start` | 啟動測試 Session |
| POST | `/api/machine-test/stop/:id` | 停止 Session |
| GET | `/api/machine-test/status` | 查詢 Session 狀態 |
| POST | `/api/machine-test/osm-status` | OSMWatcher webhook |
| GET | `/api/machine-test/osm-status` | 查詢機台狀態 |
| POST | `/api/machine-test/lark-machines` | 從 Lark 匯入機台清單 |
| POST | `/api/machine-test/lark-writeback` | 結果寫回 Lark |
| WS | `/ws/machine-test/events` | 即時測試進度 |
| WS | `/ws/agent` | Agent 協調（Work-Stealing） |

---

### 5. 圖片刪除驗證

**路徑**：`/api/image-check/*`

#### 功能
在 Playwright 內嵌瀏覽器中開啟遊戲頁面，自動驗證已刪除的圖片是否仍被載入。

#### 操作流程

```
貼上已刪除圖片清單（blob URL 或路徑）
  └▶ 貼上前端 URL
       └▶ 啟動 Playwright 瀏覽器
            └▶ 截圖 / 點擊 / 捲動操作
                 └▶ 比對結果（哪些圖片仍存在）
```

---

### 6. Config 比對

**路徑**：`/api/osm/config-compare`

#### 功能
貼入渠道 serverCfg.js URL，與 DB 中儲存的 Template 比對差異，可選擇 AI（Gemini）分析差異原因。

#### 操作流程

```
貼上渠道 serverCfg.js URL
  └▶ 選擇比對 Template
       └▶ 即時顯示差異欄位
            └▶ （可選）AI 分析差異說明
```

---

### 7. AutoSpin

**路徑**：`/api/autospin/*`

#### 功能
管理多個 AutoSpin Python Agent，每個 Agent 對應一台機器執行自動旋轉，支援暫停/繼續/停止，可匯出對賬報告。

#### 操作流程

```
下載 Agent 安裝包（install.bat / agent.py）
  └▶ 在目標機器安裝並啟動 Agent
       └▶ Server 端管理面板：啟動/停止/暫停各 Agent
            └▶ SSE 串流 Agent 日誌
                 └▶ 查看截圖
                      └▶ 匯出對賬報告（CSV）
```

#### Agent 下載端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/autospin/agent/download/install.bat` | Windows 安裝腳本 |
| GET | `/api/autospin/agent/download/agent.py` | Python Agent 程式 |
| GET | `/api/autospin/agent/download/launcher.bat` | 啟動腳本（含 Server URL） |

---

### 8. URL 帳號池

**路徑**：`/api/url-pool/*`

#### 功能
管理多個帳號的大廳 URL，自動分配給測試任務使用，避免帳號衝突。

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/url-pool/status` | 查詢各帳號狀態 |
| POST | `/api/url-pool/:account/claim` | 佔用帳號 |
| POST | `/api/url-pool/:account/release` | 釋放帳號 |
| GET | `/api/url-pool/go/:account` | 自動佔用並跳轉 |
| GET | `/api/url-pool/stream` | SSE 即時狀態推送 |

---

### 9. Jackpot 監控

**路徑**：`/api/osm/jackpot*`

#### 功能
背景每 15 秒拉取各遊戲的獎池金額（Grand/Major/Minor/Mini/Fortunate），偵測異常時推送 Lark 告警。

#### 主要 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/osm/jackpot?channelid=4171` | 查詢獎池金額 |
| GET | `/api/osm/jackpot/state` | 查詢監控狀態 |
| POST | `/api/osm/jackpot/channel` | 切換監控渠道 |
| GET | `/api/osm/jackpot/settings` | 取得閾值設定 |
| POST | `/api/osm/jackpot/settings` | 更新閾值（需 ADMIN_PIN） |

---

### 10. Game Show 工具

**路徑**：`/api/gs/*`

#### 10.1 PDF TestCase 生成

```
上傳規格書 PDF
  └▶ Gemini 分析
       └▶ 下載 JSON / CSV
```

#### 10.2 圖片比對

```
上傳兩組截圖（before / after）
  └▶ AI 標注差異區域
       └▶ 並排顯示差異圖片
```

#### 10.3 500x 機率統計

支援兩種模式：

| 模式 | 說明 |
|------|------|
| 通用 WS | 攔截任意 WebSocket，統計骰型分布 |
| ColorGame V2 電子骰 | 解析 `prepareBonusResult` 事件，統計 `d.v[10][143]` 電子骰配置 |

```
輸入遊戲 URL → 選擇模式 → 開始攔截
  └▶ Playwright 開啟遊戲
       └▶ 即時統計（回合數 / 骰型分布）
            └▶ 匯出 CSV
```

ColorGame V2 統計項目：
- Single 2同：`d.v[10][143][1]`（color 801-806）
- Single 3同：`d.v[10][143][2]`（color 801-806）
- 任意 2同（k807）：`any_double`
- 任意 3同（k808）：`any_triple`

#### 10.4 Log 攔截工具

```
複製注入腳本 → 在遊戲 Console 貼上執行
  └▶ 浮動面板攔截所有 /api/log XHR 請求
       └▶ 解析三層 JSON（root / data / jsondata）
            └▶ 驗證欄位完整性（空值標紅）
                 └▶ 匯出 CSV
```

#### 10.5 Log 結構比對

```
上傳 JSON 檔案（單檔驗證 or 雙檔比對）
  └▶ 選擇匹配鍵（function_name + event）
       └▶ 自動掃描欄位出現率（推薦驗證欄位）
            └▶ 比對結果（缺失欄位標紅）
                 └▶ 匯出 CSV
```

---

### 11. 操作歷史紀錄

**路徑**：`GET /api/history`

記錄所有重要操作，可依功能模組和天數篩選。

| Feature Key | 觸發來源 |
|-------------|---------|
| `jira` | Jira PM 批次開單 |
| `jira-comment` | Jira 批次評論 |
| `testcase` | TestCase 生成 |
| `machine-test` | 機台自動化測試 |
| `autospin` | AutoSpin session |
| `gs-stats` | 500x 機率統計 |
| `gs-logchecker` | Log 攔截工具 |
| `gs-imgcompare` | 圖片比對 |
| `osm-alert` | 版本告警 |
| `osm-config-compare` | Config 比對 |

---

### 12. AI 模型設定

**路徑**：`/api/gemini/*`、`/api/openai/*`

#### 支援的 AI 模型

| 提供商 | 說明 |
|--------|------|
| Gemini | 多 Key 輪換，自動偵測 quota 耗盡後切換 |
| Ollama | 本機 / 區網部署，fallback 選項 |
| OpenAI | 填入 Key 後自動出現 GPT-4o 選項 |

#### Key 管理流程

```
新增 Gemini Key（label + API Key）
  └▶ Probe 測試所有 Key（ok / exhausted / invalid）
       └▶ 執行 AI 任務時自動輪換
            └▶ 查看各 Key 使用統計
```

---

## API 端點總覽

### 健康檢查

```
GET /api/health
→ { "ok": true, "startTime": "...", "bootId": "..." }
```

### Jira

```
GET  /api/jira/accounts
POST /api/jira/accounts
POST /api/jira/accounts/:email/verify-pin
POST /api/jira/batch-create
POST /api/jira/batch-comment
GET  /api/jira/batch-comment/stream  (SSE)
POST /api/jira/batch-transition
POST /api/jira/pm-batch-create
```

### TestCase / Integrations

```
POST /api/integrations/lark/generate-testcases
GET  /api/integrations/lark/generate-testcases/stream  (SSE)
POST /api/integrations/generate-testcases-file
POST /api/google/sheets/records
POST /api/lark/sheets/records
POST /api/lark/sheets/writeback
POST /api/sheets/writeback-multi
```

### OSM

```
GET  /api/osm/version-history
GET  /api/luckylink/version-history
GET  /api/toppath/version-history
POST /api/osm/alert
POST /api/osm/alert/config
POST /api/osm/sync
POST /api/osm/config-compare
POST /api/osm/sync-targets-from-lark
GET  /api/osm/jackpot
GET  /api/osm/jackpot/state
POST /api/osm/jackpot/channel
```

### 機台測試

```
POST /api/machine-test/start
POST /api/machine-test/stop/:id
GET  /api/machine-test/status
POST /api/machine-test/osm-status   ← OSMWatcher Webhook
GET  /api/machine-test/osm-status
POST /api/machine-test/lark-machines
POST /api/machine-test/lark-writeback
GET  /api/machine-test/profiles
PUT  /api/machine-test/profiles
WS   /ws/machine-test/events
WS   /ws/agent
```

### AutoSpin

```
POST /api/autospin/start
POST /api/autospin/stop
GET  /api/autospin/status
GET  /api/autospin/stream/:sessionId  (SSE)
GET  /api/autospin/history
POST /api/autospin/reconcile/run
GET  /api/autospin/agent/download/install.bat
GET  /api/autospin/agent/download/agent.py
```

### Game Show

```
POST /api/gs/pdf-testcase
GET  /api/gs/log-checker-script
GET  /api/gs/log-compare
POST /api/gs/img-compare/session
GET  /api/gs/img-compare/status/:id
POST /api/gs/stats/start
POST /api/gs/stats/stop/:id
GET  /api/gs/stats/status/:id
```

### AI 模型

```
GET    /api/gemini/keys
POST   /api/gemini/keys
DELETE /api/gemini/keys/:label
POST   /api/gemini/probe
GET    /api/models/available
GET    /api/history
```

---

## OSMWatcher 串接

### Webhook 端點

```
POST https://<server>/api/machine-test/osm-status
```

### Request Body

```json
{
  "timestamp": 1714469999,
  "channel": "CP",
  "gmlist": [
    { "id": "GMID001", "status": 0 },
    { "id": "GMID002", "status": 1 },
    { "id": "GMID003", "status": 2 }
  ]
}
```

### Status 代碼

| Status | 說明 |
|--------|------|
| 0 | 正常（idle） |
| 1 | Free Game 中 |
| 2 | Jackpot 中 |
| 3 | Handpay 中 |

### Response

```json
{ "error": 0, "errordes": "success" }
```

### 配置範例（OSMWatcher config）

```json
{
  "testUrl": "https://xxxx.trycloudflare.com/api/machine-test/osm-status"
}
```

> **注意**：使用外網時，Cloudflare Tunnel URL 每次重啟都會改變。
> 使用 `generate-osm-api-key.bat` 取得最新 URL。

---

## 環境變數說明

### 核心

| 變數 | 說明 |
|------|------|
| `PORT` | Server 監聽端口（預設 3000） |
| `ADMIN_PIN` | 管理員操作 PIN |

### AI 模型

| 變數 | 說明 |
|------|------|
| `GEMINI_MODEL` | 預設 Gemini 模型（如 `gemini-2.5-flash`） |
| `OLLAMA_BASE_URL` | Ollama 服務位址 |
| `OLLAMA_MODEL` | Ollama 模型名稱 |

### Jira

| 變數 | 說明 |
|------|------|
| `JIRA_BASE_URL` | Jira 伺服器位址 |
| `JIRA_PROJECT_ID` | 預設專案 ID |

### Lark

| 變數 | 說明 |
|------|------|
| `LARK_APP_ID` | Lark App ID |
| `LARK_APP_SECRET` | Lark App Secret |
| `LARK_WEBHOOK_URL` | 告警推送 Webhook |

### OSM

| 變數 | 說明 |
|------|------|
| `OSM_BASE_URL` | OSM Backend URL |
| `OSM_CHANNELS` | 渠道清單（逗號分隔，如 `CP,WF,TBR`） |
| `OSM_CHANNEL_CP_ID` | 各渠道 ID |
| `OSM_CHANNEL_CP_USERNAME` | 各渠道帳號 |
| `OSM_CHANNEL_CP_PASSWORD` | 各渠道密碼 |

### AutoSpin

| 變數 | 說明 |
|------|------|
| `AUTOSPIN_PYTHON` | Python 執行檔路徑 |

---

## 工具腳本

### build-and-tunnel.bat

**用途**：Production 模式啟動 + 取得 OSMWatcher Webhook URL

```
雙擊執行
  └▶ 停掉舊的 port 3000/5173
       └▶ npm run build（打包前端）
            └▶ 啟動 Express Server（port 3000）
                 └▶ 啟動 Cloudflare Tunnel
                      └▶ 顯示並複製 OSMWatcher Webhook URL
```

### generate-osm-api-key.bat

**用途**：Server 已在跑時，快速取得新的 OSMWatcher Webhook URL

```
雙擊執行
  └▶ 啟動 Cloudflare Tunnel
       └▶ 等待 URL 生成（最多 60 秒）
            └▶ 顯示並複製 Webhook URL
```

### toggle.bat

**用途**：開發模式啟動/停止切換

- 已在跑 → 停止所有服務
- 未在跑 → 啟動 Dev 模式（port 3000 + 5173）

### restart.bat

**用途**：重啟服務（不重新 build）

---

*文件由 Claude Code 自動生成，如有更新請同步維護。*
