# 32. 資安防護（v5.66.0）

> 2026-10-19 使用者要求「審查工具任何會有洩漏資安問題，然後修復它，可以用加密的方式」。
> 四個面向平行審查（機密存放／權限／外洩／注入），A／B／C 三批修復。CodeX 事後補審。

## 改了什麼

### A 批：會被直接利用的洞
| 問題 | 修法 | 位置 |
|---|---|---|
| 路徑穿越：`..%2F..%2Fdata.db` 下載整個 DB／`.env`、刪任意檔 | 檔名一律走 `safeChildPath`（只收單純檔名、解析後必須在目錄內、副檔名白名單） | `server/lib/safe-path.ts`；autospin 範本／截圖、機台測試 cctv／audio 參考檔 |
| 遠端執行：Config 比對把抓回來的 `serverCfg.js` 丟進 `vm.runInContext` | 改用 acorn **只解析不執行**，只認字面值；前端貼模板的 `new Function` 同步換掉 | `shared/server-cfg-parse.ts` |
| Lark App Secret 寫死在 `run-lark-tc-backend.js`（repo 公開） | 伺服器派工時帶短效 `LARK_TENANT_TOKEN`；單獨跑用環境變數 | `osm-uat.ts` `/api/osm-uat/run` |
| `gemini-keys.json.migrated`（真 key）被 commit | 移出版控、`.gitignore` 加萬用字元 | |
| 版號告警 webhook 寫死在程式 | 改讀 `LARK_VERSION_ALERT_WEBHOOK_URL`（只在 DB 沒有時當種子） | `osm.ts` |
| SSRF：Config 比對、PDF 匯入、圖片刪除驗證可打 127.0.0.1／metadata／file:// | `safeFetch`／`assertSafeUrl`：只收 http(s)、每一跳都檢查、私有網段只放行 OSM 網域；Playwright 加 `page.route` | `server/lib/safe-fetch.ts` |
| 上傳圖片保留原副檔名（可傳 .html／.svg） | 副檔名白名單＋`nosniff` | frontend-auto、autospin |
| reconcile token／告警 webhook／JP Group 密碼原樣回前端 | 只回 `hasToken`／遮罩；編輯時留空＝沿用 | |

### B 批：加密
- **`server/secret-crypto.ts`**：AES-256-GCM，格式 `v1:iv:tag:ct`（跟 Meegle token 同一套）。
  金鑰 `SECRETS_KEY`，**沒設就用 `MEEGLE_TOKEN_KEY`**（Spug 上本來就有，部署不用補環境變數）。
- 加密的欄位（`server/secret-migration.ts` 的 `SECRET_TARGETS`）：
  settings 的 `openai_api_key`／`tunnel_webhook_url`／`sls_accessKey*`／`internal_identity_secret`、
  `gemini_keys.key`、`user_ai_keys.api_key`、`jira_accounts.token`、`jp_groups.login_pass`、
  `uat_backend_credentials.password`、`url_pool_accounts.password`、`autospin_configs.larkWebhook`、
  `alert_config.webhook_url`、`reconcile_config`／`meter_reconcile_config` 中 token／password 結尾的 key。
- **啟動時原地遷移**（冪等，只有 main 跑）。log 看 `[security] 機密欄位加密 OK（金鑰：…）`。
- 讀取對明文／密文都相容；**沒金鑰時拒絕寫入機密**（v5.66.2 起，原本是寫明文＋警告）。
- **PIN**：`scrypt(sha256(pin), salt)`，舊雜湊啟動時原地包、使用者不用重設；比對 `timingSafeEqual`；
  同一帳號連錯 5 次鎖 5 分鐘（`server/pin-hash.ts`）。
- **session**：`auth_sessions.sid` 只存 sha256（舊資料原地換、不會被登出）；https 下 cookie 加 `Secure`。

### C 批：權限
- **全站預設要登入**：main 與 worker 共用 `server/public-routes.ts` 白名單，其餘 `/api/*` 沒登入一律 401。
- `/internal/*` 只收**本機直連且沒經過 nginx**（有 `X-Forwarded-For`／`X-Real-IP` 就 404）。
- **worker 只聽 `127.0.0.1`**（`WORKER_HOST` 可改，但要自己用防火牆限來源）。
- `/ws/machine-test/events` 要登入；`/ws/agent` 照舊靠 agentToken。
- 共用設定（全站 AI key、prompt、Ollama、版號告警）寫入限管理員。
- 沒設 PIN 的帳號**不能只用 email 登入**（回 `PIN_NOT_SET`）；`set-pin` 限本人或管理員、不能清空。
- ocr-proxy 先驗 agent token 才查個人 Gemini key。

### v5.66.1～v5.66.2：CodeX 補審（c538e86／e621df1）修正
| CodeX 指出 | 修法 |
|---|---|
| [P1] 守門分大小寫、Express 不分 → `/API/history` 繞過登入（**正式環境實測成立**） | `normalizeGuardPath` 先轉小寫，main／worker 共用（v5.66.1） |
| [P1] SSRF 漏掉十六進位 IPv4-mapped（`[::ffff:127.0.0.1]` 被 URL 正規化成 `::ffff:7f00:1`） | IPv6 一律展開成 8 組；mapped／相容／SIIT／NAT64／6to4 內嵌的 IPv4 都轉回 IPv4 判斷 |
| [P1] `agent/start` 公開、靠自報 userLabel，會回解密後 webhook、改 session | `autospin-start-auth.ts`：一次性啟動票（hub-dispatch 發、經 Local Agent 傳給 Python）／舊 agent 相容「該帳號 10 分鐘內剛被派工」／重連必須帶對得上的 prevSessionId；session id 加隨機尾碼 |
| 沒金鑰時寫明文只警告，不接受 | 沒金鑰（或格式錯）**拒絕寫入機密**；讀取仍相容舊明文 |
| [P2] 代跑 session 也算有效登入 → 併行排程互相延長資格 | `auth_sessions.kind`（user／internal）；「7 天內登入過」與 Dashboard 只算 user |
| [P2] 管理員可能鎖死、救援腳本不存在 | `scripts/set-account-pin.mjs`（v5.66.0 後補）；正式環境 admin 已確認有 PIN |

## 使用者可執行的操作
- 還沒設 PIN 的人：請管理員到「權限管理」幫忙設 PIN；啟動 log 會列出這些帳號。
- **管理員自己也沒有 PIN／所有人都登不進來**：在主機上跑 `node scripts/set-account-pin.mjs --list-no-pin` 看清單，`node scripts/set-account-pin.mjs <email>` 直接設定。
- 管理員：修改全站 AI key／prompt、版號告警 webhook（非管理員會看到「只有管理員可以修改這個共用設定」）。
- 版號告警 webhook／JP Group 密碼：畫面只顯示遮罩，**留空儲存＝沿用**，要換才填。

## ⚠️ 退版注意
退到 v5.66.0 之前的程式，**舊程式會把 `v1:…` 密文當明文用**（例如拿密文去打 OpenAI），
`auth_sessions` 的雜湊 sid 也對不上（所有人要重新登入）、scrypt PIN 舊程式驗不過（全部登不進來）。
退版前要先用 `decryptSecret` 把欄位解回明文、PIN 由管理員重設——或乾脆不要退，往前修。

## 驗證
- 單元：`safe-path`、`safe-fetch`、`server-cfg-parse`、`secret-migration`（46）、`pin-hash`、`public-routes`（62，每條放行都配一條必須擋的鄰居）。
- 實機：用 DB 副本把 build 後的 main＋worker 起在 3999／3998，跑 46 條冒煙（未登入 401、白名單不擋、
  解密後照常可用、管理員限定、路徑穿越 400、SSRF 擋、/internal 經代理 404、直打 worker 沒簽章 401、
  偽造簽章 401、WS 未登入關閉、DB 裡都是密文／雜湊）。
  **注入**：把 main 的登入檢查改成全放行 → 紅 6 條，正好是 main 自己處理的路由；轉給 worker 的仍 401（worker 那層獨立生效）。

## 待辦（這次沒做完的）
1. **agent 回報路由還沒有憑證**（`agent/start` 已改成啟動票，其餘仍無）：Python AutoSpin agent 的 log／stop／should-stop 等、Local Agent 的 UI 截圖回報、
   cctv／audio 上傳、OSMWatcher 推送。要它們帶 token 得先更新每台 agent，否則部署當下斷線——先列在白名單，
   下一階段：agent 帶 `x-agent-token` → 伺服器先「有帶就驗」、全部 agent 更新後改成必帶。
2. **功能權限（角色可見頁面）只在前端擋**：後端只有 Meegle／週報／Sheet 有檢查。要做 `requirePage(key)`。
3. **自助註冊**（登入畫面「新增帳號」）仍開放：任何連得到的人都能建 qa 帳號。要不要改成「待管理員核准」待使用者決定。
4. `discord_retire_backup`（退版備份）裡有舊 Discord webhook，沒加密；Discord 已退場，建議撤銷該 webhook 後刪備份。
5. Gemini key 仍放在網址參數 `?key=`（上游代理可能記錄），可改 `x-goog-api-key` header。
6. CORS 仍是 `*`（沒帶 credentials，風險低）。
