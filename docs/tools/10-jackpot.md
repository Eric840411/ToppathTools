# Jackpot 監控

**路由**：`/api/osm/jackpot*`

---

## 功能說明

背景每 15 秒拉取各遊戲的獎池金額（Grand/Major/Minor/Mini/Fortunate），偵測異常時推送 Lark 告警。

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 查看獎池金額 | 顯示所有遊戲的即時獎池數值 |
| 設定 Channel ID | 指定要監控的渠道 |
| 設定閾值 | 每遊戲每獎池等級設定 min/max 合理範圍 |
| 設定告警開關 | 各等級異常是否推 Lark 告警（可獨立關閉） |
| 手動觸發告警 | 立即對目前數值進行閾值檢查 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/osm/jackpot?channelid=4171` | 查詢獎池金額 |
| GET | `/api/osm/jackpot/state` | 查詢監控狀態 |
| POST | `/api/osm/jackpot/channel` | 切換監控渠道 |
| GET | `/api/osm/jackpot/settings` | 取得閾值設定 |
| POST | `/api/osm/jackpot/settings` | 更新閾值（需 ADMIN_PIN） |
