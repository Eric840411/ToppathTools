# 系統架構與啟動方式

## 架構圖

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

---

## 端口說明

| 端口 | 服務 | 用途 |
|------|------|------|
| **3000** | Express API Server | 所有 `/api/*` 端點、靜態檔案（Production 模式） |
| **5173** | Vite Dev Server | 前端 HMR、開發模式，會 Proxy `/api` 到 port 3000 |
| **20241** | cloudflared | Cloudflare Tunnel 本機管理端口（自動分配） |

---

## 即時通訊端點

### WebSocket

| 路徑 | 用途 |
|------|------|
| `/ws/machine-test/events` | 機台測試即時進度推送給前端 |
| `/ws/agent` | 分散式 Agent 心跳、領取工作（Work-Stealing） |

### SSE（Server-Sent Events）

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

- Express Server：`http://localhost:3000`
- Vite Dev Server：`http://localhost:5173`（區網 `http://192.168.x.x:5173`）

### Production 模式 + 外網 Tunnel（推薦給 OSMWatcher 使用）

```
雙擊 build-and-tunnel.bat
```

流程：
1. 停掉殘留 port 3000/5173 進程
2. `npm run build` 打包前端
3. 啟動 Express Server（port 3000）
4. 啟動 Cloudflare Tunnel
5. 顯示外網 Webhook URL 並自動複製到剪貼簿

### 只取得新的外網 Tunnel URL（Server 已在跑）

```
雙擊 generate-osm-api-key.bat
```

啟動新 Cloudflare Tunnel，等待 URL 生成後顯示並複製。

### 手動啟動（開發除錯）

```bash
# 後端
npx tsx server/index.ts

# 前端（另開終端）
npm run dev
```

---

## 後端路由模組

| 檔案 | 掛載路徑 | 說明 |
|------|---------|------|
| `server/routes/jira.ts` | `/api/jira/*`, `/api/lark/sheets/*` | Jira 批量開單、Lark Sheet 回寫 |
| `server/routes/gemini.ts` | `/api/gemini/*`, `/api/history` | Gemini AI、操作歷史 |
| `server/routes/osm.ts` | `/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*` | OSM 版本同步、Jackpot |
| `server/routes/integrations.ts` | `/api/integrations/*`, `/api/google/sheets/*` | TestCase 生成、Google Sheets |
| `server/routes/machine-test.ts` | `/api/machine-test/*` | 機台自動化測試、OSMWatcher |
| `server/routes/autospin.ts` | `/api/autospin/*` | AutoSpin Agent 管理 |
| `server/routes/osm-uat.ts` | `/api/osm-uat/*` | UAT 整合測試 |
| `server/routes/gameshow.ts` | `/api/gs/*` | Game Show 工具 |
