# 操作歷史紀錄

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 10. 操作歷史紀錄（HistoryPage）

**路由**：`GET /api/history`

### 功能說明
記錄所有使用者在工具中執行的重要操作，可依功能模組和時間篩選查詢。

### 記錄的操作（feature key → 觸發來源）
| Feature Key | 觸發來源 |
|-------------|---------|
| `jira` | Jira 批次開單 |
| `jira-comment` | Jira 批次評論 |
| `jira-edit` | Jira 批量修改欄位 |
| `testcase` | TestCase 生成（Lark / PDF / Google Docs）|
| `imagerecon` | ImageRecon 週報解析 |
| `osm-components` | OSM 元件版本同步 |
| `luckylink-components` | LuckyLink 元件版本同步 |
| `luckylink-protocol-versions` | LuckyLink SAS/MML/G2S 版本統計 |
| `toppath-components` | Toppath 元件版本同步 |
| `osm-sync` | OSM 全渠道同步 |
| `osm-alert` | 版本告警（手動 / 排程）|
| `osm-config-compare` | Config 比對 |
| `meter-reconcile` | Performance Meter 對帳查詢 |
| `egm-daycount` | Egm DayCount 對帳查詢 |
| `meegle-account` | Meegle 個人綁定／解除綁定、管理員設定／刪除身分對照 |
| `meegle-batch-create` | Meegle 批次開單（一批送完寫一筆：開單／待確認／失敗筆數；明細有來源 Sheet 連結與每列的名稱、單號連結、關聯需求、處理階段、回填結果，歷史頁顯示成表格） |
| `meegle-batch-comment` | Meegle 批量評論（一批送完寫一筆：完成／待確認張數；明細有來源 Sheet、每列的單號、列號、代理身分、各步驟結果） |
| `meegle-batch-status` | Meegle 批量更新狀態（一批送完寫一筆：完成／日期待確認張數；明細有來源 Sheet、每列的單號、列號、目標狀態、日期模式、各步驟結果與日期原值→預計值） |
| `meegle-batch-edit` | Meegle 批量修改（一批送完寫一筆：完成張數；明細有來源 Sheet、每列的單號、列號、改了哪些欄位（含清空）、各步驟結果） |
| `machine-test` | 機台自動化測試結果 / 設定檔儲存 |
| `autospin` | AutoSpin session 結束 |
| `gs-stats` | Game Show 500x 機率統計 |
| `gs-imgcompare` | Game Show 圖片比對 |
| `gs-logchecker` | Game Show Log 攔截 |
| `weekly-report` | 週報彙整送出 |

### 使用者操作
| 操作 | 說明 |
|------|------|
| 依功能篩選 | 選擇特定 feature key 的紀錄 |
| 依天數篩選 | 7 / 14 / 30 / 90 天 |
| 展開詳情 | 查看完整的 detail JSON |
| 下載 JSON | 下載單筆紀錄的 detail 資料 |

---
