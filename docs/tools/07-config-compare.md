# Config 比對

**路由**：`/api/osm/config-compare`、`/api/osm/config-templates/*`｜**歷史紀錄 feature key**：`osm-config-compare`

---

## 功能說明

貼入渠道 serverCfg.js URL，與 DB 中儲存的 Template 比對差異，可選擇 AI（Gemini）分析差異原因。

---

## 操作流程

```
貼上渠道 serverCfg.js URL
  └▶ 選擇比對 Template
       └▶ 即時顯示差異欄位
            └▶ （可選）AI 分析差異說明
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 貼上 URL 進行比對 | 即時顯示差異欄位 |
| 管理 Config Template | 新增/編輯/刪除模板，儲存在 DB |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/osm/config-compare` | 執行比對（AI 分析） |
| GET | `/api/osm/config-templates` | 取得所有 Template |
| POST | `/api/osm/config-templates` | 新增 Template |
| PUT | `/api/osm/config-templates/:id` | 更新 Template |
| DELETE | `/api/osm/config-templates/:id` | 刪除 Template |
