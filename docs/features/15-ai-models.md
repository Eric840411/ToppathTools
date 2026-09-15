# AI 模型和 Prompt 設定

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 15. AI 模型和 Prompt 設定（全域）

**路由**：`/api/gemini/*`、`/api/openai/key`、`/api/models/available`

### 功能說明
管理 Gemini / OpenAI API Keys 及 Prompt 模板，供所有功能模組共用。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 新增 Gemini Key | 輸入 label + API Key，儲存至 DB |
| 刪除 Gemini Key | 從 DB 移除指定 Key |
| 查看 Key 狀態 | 顯示各 Key 最後使用時間與狀態 |
| 設定 OpenAI Key | 設定 OpenAI API Key（儲存至 DB）|
| 管理 Prompt 模板 | 新增/編輯/刪除各功能用的 Prompt 文字 |
| 探測 Key 可用性 | 即時測試指定 Key 是否可正常呼叫 |

---

## ⚠️ Gemini fallback 模型已下架（2026-09-14，v4.144.2）

`process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'` 這個 fallback 在 9 個地方出現，
而 **`gemini-2.0-flash` 已經被 Google 下架**：

```
GET  models/gemini-2.0-flash                 → 200，還查得到（outputTokenLimit 8192）
POST models/gemini-2.0-flash:generateContent → 404 "This model is no longer available"
```

⚠️ **metadata 查得到不代表能用。**用 `models` 清單或 GET metadata 確認模型是否可用是不夠的，
要真的打一次 `generateContent`。這次就是差點被 metadata 的 200 騙過去。

後果：**任何沒有設 `GEMINI_MODEL` 的環境，每一次 Gemini 呼叫都會 404**。
目前本機與 Spug 的 `.env` 都有設 `gemini-2.5-flash` 所以沒事，但那是運氣——
`.env` 是各環境各自維護的，新環境或有人清掉那行就會全掛。

已把 9 處 fallback 改成 `gemini-2.5-flash`。

⚠️ **換模型前一定要實際打一次。**我第一版把 Discord bot 的候選清單改成
`['gemini-2.5-flash', 'gemini-2.5-flash-lite']`，實測才發現 **`gemini-2.5-flash-lite` 也是 404**，
差點放進去另一個死模型。最後用實測可用的 `gemini-flash-latest`（別名，不會隨版本號過時）。

⚠️ **`maxOutputTokens` 刻意沒有設。**`gemini-2.5-flash` 不指定時預設就是它的上限 65536（實測），
設一樣的數字不會有任何改變；而設一個固定數字之後，換到上限較低的模型時可能反而出錯
（這點我沒測到——手上能用的低上限模型都配額不足，所以只當成疑慮不當結論）。

---
