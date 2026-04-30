# AI 模型設定

**路由**：`/api/gemini/*`、`/api/openai/*`、`/api/models/available`

---

## 功能說明

管理 Gemini / OpenAI API Keys 及 Prompt 模板，供所有功能模組共用。支援多 Key 輪換、quota 耗盡自動切換。

---

## 支援的 AI 模型

| 提供商 | 說明 |
|--------|------|
| Gemini | 多 Key 輪換，自動偵測 quota 耗盡後切換 |
| Ollama | 本機 / 區網部署，fallback 選項 |
| OpenAI | 填入 Key 後自動出現 GPT-4o 選項 |

---

## Key 管理流程

```
新增 Gemini Key（label + API Key）
  └▶ Probe 測試所有 Key（ok / exhausted / invalid）
       └▶ 執行 AI 任務時自動輪換
            └▶ 查看各 Key 使用統計
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 新增 Gemini Key | 輸入 label + API Key，儲存至 DB |
| 刪除 Gemini Key | 從 DB 移除指定 Key |
| 查看 Key 狀態 | 顯示各 Key 最後使用時間與狀態 |
| 設定 OpenAI Key | 設定 OpenAI API Key（儲存至 DB） |
| 管理 Prompt 模板 | 新增/編輯/刪除各功能用的 Prompt 文字 |
| 探測 Key 可用性 | 即時測試指定 Key 是否可正常呼叫 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/gemini/keys` | 取得所有 Gemini Keys |
| POST | `/api/gemini/keys` | 新增 Key |
| DELETE | `/api/gemini/keys/:label` | 刪除 Key |
| POST | `/api/gemini/probe` | 測試 Key 可用性 |
| GET | `/api/models/available` | 取得可用模型清單 |
| POST | `/api/openai/key` | 設定 OpenAI Key |

---

## 環境變數預設值

| 變數 | 說明 |
|------|------|
| `GEMINI_API_KEY` | 預設 Gemini Key（DB 無 Key 時 fallback） |
| `GEMINI_MODEL` | 預設模型（如 `gemini-2.5-flash`） |
| `OLLAMA_BASE_URL` | Ollama 服務位址 |
| `OLLAMA_MODEL` | Ollama 模型名稱 |
