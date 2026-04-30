# OSMWatcher 串接說明

---

## Webhook 端點

```
POST https://<server>/api/machine-test/osm-status
```

> 無需 API Key 或認證，直接 POST 即可。

---

## Request Body

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

---

## Status 代碼

| Status | 說明 |
|--------|------|
| 0 | 正常（idle） |
| 1 | Free Game 中 |
| 2 | Jackpot 中 |
| 3 | Handpay 中 |

---

## Response

```json
{ "error": 0, "errordes": "success" }
```

---

## OSMWatcher 配置範例

```json
{
  "testUrl": "https://xxxx.trycloudflare.com/api/machine-test/osm-status"
}
```

---

## 取得外網 Webhook URL

由於使用 Cloudflare Quick Tunnel，URL 每次重啟都會改變。

### 方式一：Build + Tunnel 一體啟動

```
雙擊 build-and-tunnel.bat
```

會自動打包前端、啟動 Server、啟動 Tunnel，並顯示最新 Webhook URL。

### 方式二：只取得新 URL（Server 已在跑）

```
雙擊 generate-osm-api-key.bat
```

啟動新 Cloudflare Tunnel，等待 URL 生成後顯示並複製到剪貼簿。

---

## 機台測試整合

OSMWatcher 回報的狀態會即時更新到機台測試的 `osmStatus` 記憶體表。  
每個測試步驟執行前（`[checkOsm]`）會查詢此狀態：

- `status = 0`（idle）：正常繼續測試
- `status = 1/2/3`（FG/JP/Handpay）：執行該機種的 `bonusAction` 一次，然後持續 Spin 直到 `status = 0`
