# TestCase 生成

**路由**：`/api/integrations/*`、`/api/integrations/generate-testcases-file`｜**歷史紀錄 feature key**：`testcase`

---

## 功能說明

讀取多份規格書（Lark Wiki / PDF / Google Docs，可混合），透過 Gemini 生成 TestCase，並寫回 Lark Bitable。

---

## 操作流程

```
貼入規格書 URL（支援混合來源）
  └▶ 選擇 AI 模型（Gemini / Ollama / OpenAI）
       └▶ 執行生成（SSE 串流進度）
            └▶ 選擇：
                 ├▶ 寫入 Lark Bitable
                 └▶ 下載 JSON
```

---

## 支援來源格式

| 來源 | URL 格式 |
|------|---------|
| Lark Wiki | `https://xxx.larksuite.com/wiki/...` |
| Lark Docx | `https://xxx.larksuite.com/docx/...` |
| Google Docs | `https://docs.google.com/document/...` |
| PDF 上傳 | 最多 5 個檔案，multipart/form-data |

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 新增來源 | 貼上 Lark Wiki / PDF URL / Google Doc URL，可混合多份 |
| 選擇 AI 模型 | Gemini / Ollama / OpenAI，從 AI 模型設定頁管理 |
| 執行生成 | SSE 即時串流進度，後台逐份讀取合併後送 Gemini 生成 |
| 寫入 Bitable | 生成完成後自動寫入指定 Lark Bitable URL |
| 下載 JSON | 不寫 Bitable，直接下載生成的 TestCase JSON 檔案 |
| 查看 ImageRecon 週報 | 解析 Gmail 最新 ImageRecon 週報，比對目標版本 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/integrations/lark/generate-testcases` | 開始生成（返回 requestId） |
| GET | `/api/integrations/lark/generate-testcases/stream` | SSE 接收結果 |
| POST | `/api/integrations/generate-testcases-file` | 上傳 PDF 生成 |
| POST | `/api/google/sheets/records` | 讀取 Google Sheet |
| POST | `/api/lark/sheets/records` | 讀取 Lark Sheet |
| POST | `/api/lark/sheets/writeback` | 寫回 Lark Sheet |
| POST | `/api/sheets/writeback-multi` | 批量寫回多欄位 |
