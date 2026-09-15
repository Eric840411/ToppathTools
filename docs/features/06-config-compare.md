# Config 比對

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 6. OSM Tools — Config 比對（OsmConfigComparePage）

**路由**：`/api/osm/config-compare`、`/api/osm/config-templates/*`｜**歷史紀錄 feature key**：`osm-config-compare`

### 功能說明
貼入渠道 config URL，與儲存在 DB 的 Template 比對差異。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 貼上 URL 進行比對 | 即時顯示差異欄位 |
| 管理 Config Template | 新增/編輯/刪除模板，儲存在 DB |

---
