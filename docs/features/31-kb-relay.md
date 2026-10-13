# 31. 記憶共享 relay（/kb-mcp/*）

> v5.49.0。規格：`osm-qa-agent/docs/memory-sharing-spug-relay.md` §A（v1.2，CodeX 審過）。
> 本機 connector 在 `osm-qa-agent/kb-mcp/relay-connector.cjs`（§B，osm-qa-agent 那邊維護）。

## 是什麼

同事的 AI 要讀 osm-qa-agent 本機的 KB／記憶，但記憶**不上 Spug**。Spug 上的 toppath-server 只當轉接：

```
同事的 AI ──HTTPS──▶ eric.osmslot.org/kb-mcp/mcp（這支，server/kb-relay.ts）
                          ▲ 反向 WSS（本機 connector 主動連出來）
                    本機 relay-connector ──▶ 127.0.0.1:3791 kb-mcp（驗 token／ACL／撤權）
```

relay **不判斷 token**、不存、不快取；token 的有效性與權限全由本機 kb-mcp 決定。

## 端點

| 端點 | 行為 |
|---|---|
| `POST /kb-mcp/mcp` | 只收 POST（其他 405）、`Content-Type: application/json`（其他 415）、body ≤ 64KB UTF-8 bytes（413，含 chunked）。帶 query → 400；`/kb-mcp/mcp/<x>` 等其他路徑 → 404。只把 `Authorization` 轉給 connector。connector 不在線 → 503 `-32010 memory service offline`；在途已 16 筆 → 503 busy；20 秒沒回 → 504。回應的 status／Content-Type／body 原樣回，一律 `Cache-Control: no-store`。每 IP 60 req/min（429） |
| `GET /kb-mcp/connect` | WebSocket upgrade，`Authorization: Bearer <KB_RELAY_SECRET>`（雜湊後 `timingSafeEqual`）。錯 → 401 不 upgrade；帶 query → 400；不是 upgrade → 426。同時只一條，新連線驗過就踢掉舊的（舊的在途 → 503）。每 25 秒 ping、60 秒沒 pong 就斷。connector 送來的 frame 上限 8MB（ws `maxPayload`，接收層含分片），超過 → 所有在途 502 並斷線；任何斷線 → 在途立刻 503 |

訊息格式見規格 §A3。不認得的 id 直接丟；status 不是 200～599 的整數 → 502；Content-Type 格式不對 → 換成 application/json。

## 不記錄的東西（整條路徑）

**body、Authorization、原始 URL（含 query）一律不記。** relay 的 log 只有 `[kb-relay] {"t","route","ip","status","bytes","ms"}` 與連線事件（`ev`、`code`、ws 錯誤碼）。

- `kbRelayHttp` 掛在 `index.ts` 的 **app 最前面**（cors、json parser、存取 log、dashboard metrics 之前），所以 `/kb-mcp/*` 不會進 `log()`／dashboard。錯誤也不走 `next(err)`（全站 error handler 會記 path）
- 回應用 `res.setHeader` 不用 `res.set`：express 的 `set` 會在 Content-Type 後面自己加 `; charset=utf-8`，就不是原樣回了
- 本專案沒有 Sentry 之類的錯誤追蹤
- **反向代理那層要另外設**（不在這個 repo）——見下面「部署」

## 部署（Spug）

1. **環境變數** `KB_RELAY_SECRET`：≥32 bytes 隨機（`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`）。沒設或太短 → `/kb-mcp/*` 全部 503（等於關閉）。開機 log 會印一次「relay 關閉」。connector 那邊要設同一個值
   - 秘密只在第一次用到時讀（ESM import 比 `dotenv.config()` 早，載入當下讀會讀不到 `.env`）
2. **前面有 nginx 的話**，`/kb-mcp/` 這段要：
   ```nginx
   location /kb-mcp/ {
     access_log off;                       # 規格：不記 URL／header
     error_log /dev/null crit;             # nginx 的 error log 會印 request line（含 query）
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_read_timeout 90s;               # > 60 秒心跳逾時，不然 nginx 會先斷 WS
     proxy_send_timeout 90s;
     client_max_body_size 128k;
     proxy_buffering off;
     proxy_cache off;
   }
   ```
   - IP 取 `X-Forwarded-For` 最右邊（`trust proxy 1`）。前面若還有一層 CDN／負載平衡，限流看到的會是那一層的 IP
3. 只在 **toppath-server** 跑（不 proxy 到 worker）。限流與「同時一條連線」都存在 process 記憶體裡，toppath-server 不能開多個實例

## 操作清單

- 開：Spug 設 `KB_RELAY_SECRET` → 重新部署 → osm-qa-agent 啟動 connector
- 關（Spug 端）：拿掉 `KB_RELAY_SECRET` 重新部署；或本機放 `kb-mcp/relay.disabled`（connector 斷線開關）
- 看連線狀態：toppath-server log 搜 `[kb-relay]`（`ev:connected`／`closed`／`replaced`／`pong-timeout`）
- 換 secret：Spug 與 connector 兩邊一起換；Spug 換完舊 connector 會一直 401

## 測試

`npm run build:server && node scripts/kb-relay/relay.test.mjs`（52 條；心跳那條要等 60 秒，`SKIP_SLOW=1` 跳過）

- 接線照 `index.ts`；後半段跑 osm-qa-agent **真的** `relay-connector.cjs`（假的本機 kb-mcp，不碰正式記憶與 tokens.json）。需要 `../osm-qa-agent`（或 `OSM_QA_AGENT_DIR`）
- 突變驗過（2026-10-13）：close 不清 pending、secret 不驗、query 不擋、log 記 URL、拿掉 maxPayload、轉送所有 header——各自紅在對應那條
- 真 `dist-server/server/index.js` 起在旁邊的 port 也驗過：503 offline、query 400、錯 secret 401、轉送、`/ws/agent` 照舊走原本的 wss（`index.ts` 的 wss 改成 `noServer`，upgrade 自己分流）
