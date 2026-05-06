# URL 帳號池

**路由**：`/api/url-pool/*`

---

## 功能說明

管理多個帳號的大廳 URL，自動分配給測試任務使用，避免帳號衝突。

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 查看帳號池狀態 | 顯示各帳號目前使用狀態（空閒/佔用） |
| Claim / Release URL | 手動佔用或釋放帳號 |
| 設定覆蓋值 | 暫時覆蓋某帳號的 URL |
| 直接跳轉 | 以指定帳號跳轉到對應大廳 URL |
| 監聽狀態變更 | SSE 即時通知帳號池狀態變更 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/url-pool/status` | 查詢各帳號狀態 |
| POST | `/api/url-pool/:account/claim` | 佔用帳號 |
| POST | `/api/url-pool/:account/release` | 釋放帳號 |
| GET | `/api/url-pool/go/:account` | 自動佔用並跳轉 |
| GET | `/api/url-pool/stream` | SSE 即時狀態推送 |
