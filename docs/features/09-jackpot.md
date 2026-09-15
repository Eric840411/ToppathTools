# Jackpot 監控

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 9. OSM Tools — Jackpot 監控（JackpotPage）

**路由**：`/api/osm/jackpot*`

### 功能說明
背景每 15 秒拉取各遊戲的獎池金額（Grand/Major/Minor/Mini/Fortunate），偵測異常時推送 Lark 告警。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看獎池金額 | 顯示所有遊戲的即時獎池數值 |
| 設定 Channel ID | 指定要監控的渠道 |
| 設定閾值 | 每遊戲每獎池等級設定 min/max 合理範圍 |
| 設定告警開關 | 各等級異常是否推 Lark 告警（可獨立關閉）|
| 手動觸發告警 | 立即對目前數值進行閾值檢查 |

---
