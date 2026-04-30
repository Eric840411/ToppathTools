# OSM 版號同步

**路由**：`/api/osm/*`, `/api/luckylink/*`, `/api/toppath/*`｜**歷史紀錄 feature key**：`osm-components`、`osm-sync`、`osm-alert`

---

## 功能說明

追蹤 OSM / LuckyLink / Toppath 各元件版本，同步渠道機器設定，偵測版本落差後推送 Lark 告警。

---

## 操作流程

```
拉取版本歷史（OSM / LuckyLink / Toppath）
  └▶ 比對各渠道目標版本（從 Lark Sheet 同步）
       └▶ 發送版本告警到 Lark（手動 or 定時 Cron）
            └▶ 同步全渠道機器設定（machine push/pull）
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 查看版本歷史 | 列出 OSM / LuckyLink / Toppath 各元件的版本紀錄 |
| 同步元件版本 | 拉取最新版本資料，儲存到 DB |
| 同步全渠道 | 對所有渠道執行 machine push/pull，更新設定 |
| 手動觸發版本告警 | 比對各渠道版本，發現未達標項目推送 Lark 告警 |
| 設定排程告警 | 設定 cron 時間，定時自動版本告警 |
| 從 Lark 同步目標 | 從 Lark Sheet 讀取目標版本清單 |
| Config 比對 | 貼上渠道 URL，與 Template 比對設定差異 |
| Frontend 機台管理 | 查看 / 自動更新前端機台清單 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/osm/version-history` | 拉取 OSM 版本歷史 |
| GET | `/api/luckylink/version-history` | LuckyLink 版本 |
| GET | `/api/toppath/version-history` | Toppath 版本 |
| POST | `/api/osm/alert` | 手動觸發版本告警 |
| POST | `/api/osm/alert/config` | 設定排程告警（cron） |
| POST | `/api/osm/sync` | 同步全渠道 |
| POST | `/api/osm/sync-targets-from-lark` | 從 Lark 同步目標版本 |
| POST | `/api/osm/config-compare` | Config 比對（AI 分析） |

---

## 渠道清單（`.env` 設定）

目前支援渠道：`CP`, `WF`, `TBR`, `TBP`, `MDR`, `DHS`, `NP`, `NCH`

每個渠道需設定：`OSM_CHANNEL_{NAME}_ID`、`USERNAME`、`PASSWORD`、`ORIGIN`
