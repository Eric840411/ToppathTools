# API 端點總覽

> Express Server 跑在 port **3000**。所有端點前綴 `/api/`。

---

## 健康檢查

```
GET /api/health
→ { "ok": true, "startTime": "...", "bootId": "..." }
```

---

## Jira

```
GET  /api/jira/accounts
POST /api/jira/accounts
POST /api/jira/accounts/:email/verify-pin
POST /api/jira/batch-create
POST /api/jira/batch-comment
GET  /api/jira/batch-comment/stream          (SSE)
POST /api/jira/batch-transition
POST /api/jira/pm-batch-create
```

---

## TestCase / Integrations

```
POST /api/integrations/lark/generate-testcases
GET  /api/integrations/lark/generate-testcases/stream  (SSE)
POST /api/integrations/generate-testcases-file
POST /api/google/sheets/records
POST /api/lark/sheets/records
POST /api/lark/sheets/writeback
POST /api/sheets/writeback-multi
```

---

## OSM 版號同步

```
GET  /api/osm/version-history
GET  /api/luckylink/version-history
GET  /api/toppath/version-history
POST /api/osm/alert
POST /api/osm/alert/config
POST /api/osm/sync
POST /api/osm/config-compare
POST /api/osm/sync-targets-from-lark
GET  /api/osm/jackpot?channelid=...
GET  /api/osm/jackpot/state
POST /api/osm/jackpot/channel
GET  /api/osm/jackpot/settings
POST /api/osm/jackpot/settings
```

---

## 機台自動化測試

```
POST /api/machine-test/start
POST /api/machine-test/stop/:id
GET  /api/machine-test/status
POST /api/machine-test/osm-status          ← OSMWatcher Webhook（無需認證）
GET  /api/machine-test/osm-status
POST /api/machine-test/lark-machines
POST /api/machine-test/lark-writeback
GET  /api/machine-test/profiles
PUT  /api/machine-test/profiles
WS   /ws/machine-test/events
WS   /ws/agent
```

---

## UAT 整合測試

```
GET  /api/osm-uat/stream                   (SSE)
GET  /api/osm-uat/status
GET  /api/osm-uat/scan?larkUrl=...
POST /api/osm-uat/run
POST /api/osm-uat/stop
```

---

## AutoSpin

```
POST /api/autospin/start
POST /api/autospin/stop
GET  /api/autospin/status
GET  /api/autospin/stream/:sessionId       (SSE)
GET  /api/autospin/history
POST /api/autospin/reconcile/run
GET  /api/autospin/agent/download/install.bat
GET  /api/autospin/agent/download/agent.py
GET  /api/autospin/agent/download/launcher.bat
```

---

## URL 帳號池

```
GET  /api/url-pool/status
POST /api/url-pool/:account/claim
POST /api/url-pool/:account/release
GET  /api/url-pool/go/:account
GET  /api/url-pool/stream                  (SSE)
```

---

## Game Show

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

---

## AI 模型

```
GET    /api/gemini/keys
POST   /api/gemini/keys
DELETE /api/gemini/keys/:label
POST   /api/gemini/probe
GET    /api/models/available
POST   /api/openai/key
GET    /api/history
```
