# 操作歷史紀錄

**路由**：`GET /api/history`

---

## 功能說明

記錄所有使用者在工具中執行的重要操作，可依功能模組和時間篩選查詢。

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 依功能篩選 | 選擇特定 feature key 的紀錄 |
| 依天數篩選 | 7 / 14 / 30 / 90 天 |
| 展開詳情 | 查看完整的 detail JSON |
| 下載 JSON | 下載單筆紀錄的 detail 資料 |

---

## Feature Key 對照

| Feature Key | 觸發來源 |
|-------------|---------|
| `jira` | Jira PM 批次開單 |
| `jira-comment` | Jira 批次評論 |
| `testcase` | TestCase 生成（Lark / PDF / Google Docs） |
| `imagerecon` | ImageRecon 週報解析 |
| `osm-components` | OSM 元件版本同步 |
| `luckylink-components` | LuckyLink 元件版本同步 |
| `toppath-components` | Toppath 元件版本同步 |
| `osm-sync` | OSM 全渠道同步 |
| `osm-alert` | 版本告警（手動 / 排程） |
| `osm-config-compare` | Config 比對 |
| `machine-test` | 機台自動化測試結果 / 設定檔儲存 |
| `autospin` | AutoSpin session 結束 |
| `gs-stats` | Game Show 500x 機率統計 |
| `gs-imgcompare` | Game Show 圖片比對 |
| `gs-logchecker` | Game Show Log 攔截 |
