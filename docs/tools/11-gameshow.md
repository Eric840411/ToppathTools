# Game Show 工具

**路由**：`/api/gs/*`

---

## 11.1 PDF TestCase 生成

**歷史紀錄 feature key**：`gs-stats`

### 操作流程

```
上傳規格書 PDF
  └▶ Gemini 分析
       └▶ 下載 JSON / CSV
```

| 操作 | 說明 |
|------|------|
| 上傳 PDF | 選擇規格書 PDF 檔案 |
| 生成 TestCase | 送 Gemini 分析，輸出結構化 TestCase |
| 下載結果 | 下載 JSON / CSV 格式 |

**API**：`POST /api/gs/pdf-testcase`

---

## 11.2 圖片比對

**歷史紀錄 feature key**：`gs-imgcompare`

### 操作流程

```
上傳兩組截圖（before / after）
  └▶ AI 標注差異區域
       └▶ 並排顯示差異圖片
```

| 操作 | 說明 |
|------|------|
| 建立比對 session | 上傳兩組截圖（before/after） |
| 執行比對 | AI 分析差異，標注不同區域 |
| 查看結果 | 並排顯示差異圖片 |

**API**：
```
POST /api/gs/img-compare/session
GET  /api/gs/img-compare/status/:id
```

---

## 11.3 500x 機率統計

**歷史紀錄 feature key**：`gs-stats`

### 支援模式

| 模式 | 說明 |
|------|------|
| 通用 WS | 攔截任意 WebSocket，統計骰型分布 |
| ColorGame V2 電子骰 | 解析 `prepareBonusResult` 事件，統計 `d.v[10][143]` 電子骰配置 |

### 操作流程

```
輸入遊戲 URL → 選擇模式 → 開始攔截
  └▶ Playwright 開啟遊戲
       └▶ 即時統計（回合數 / 骰型分布）
            └▶ 匯出 CSV
```

### ColorGame V2 統計項目

- Single 2同：`d.v[10][143][1]`（color 801-806）
- Single 3同：`d.v[10][143][2]`（color 801-806）
- 任意 2同（k807）：`any_double`
- 任意 3同（k808）：`any_triple`

**API**：
```
POST /api/gs/stats/start
POST /api/gs/stats/stop/:id
GET  /api/gs/stats/status/:id
```

---

## 11.4 Log 攔截工具

**歷史紀錄 feature key**：`gs-logchecker`

### 操作流程

```
複製注入腳本 → 在遊戲 Console 貼上執行
  └▶ 浮動面板攔截所有 /api/log XHR 請求
       └▶ 解析三層 JSON（root / data / jsondata）
            └▶ 驗證欄位完整性（空值標紅）
                 └▶ 匯出 CSV
```

**API**：`GET /api/gs/log-checker-script`

---

## 11.5 Log 結構比對

### 操作流程

```
上傳 JSON 檔案（單檔驗證 or 雙檔比對）
  └▶ 選擇匹配鍵（function_name + event）
       └▶ 自動掃描欄位出現率（推薦驗證欄位）
            └▶ 比對結果（缺失欄位標紅）
                 └▶ 匯出 CSV
```

**API**：`GET /api/gs/log-compare`
