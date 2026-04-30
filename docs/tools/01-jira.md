# Jira 批量開單

**路由**：`/api/jira/*`｜**歷史紀錄 feature key**：`jira`、`jira-comment`

---

## 功能說明

從 Lark Bitable 讀取規格，批量在 Jira 建立 Issue，支援批量評論、批量轉換狀態。

---

## 操作流程

```
選擇帳號
  └▶ 讀取 Lark Bitable（規格表）
       └▶ 選擇 Jira 專案 / Issue Type
            └▶ 預覽清單
                 └▶ 確認執行
                      └▶ SSE 串流進度
                           └▶ 結果（成功 / 失敗 Issues）
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 選擇帳號 | 從全域帳號選單選擇 Jira 操作者身份 |
| 批次開單（Step 1–5） | 讀取 Lark Bitable → 選專案/Issue Type → 預覽清單 → 確認執行 → 進度追蹤（SSE） |
| PM 批次開單 | 從 Lark 讀取 PM 規格，自動建立 Epic + Story |
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition |
| 查看成員 / 專案 | 列出帳號可存取的 Jira 成員和專案清單 |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/jira/accounts` | 列出所有帳號 |
| POST | `/api/jira/accounts` | 新增帳號 |
| POST | `/api/jira/accounts/:email/verify-pin` | 驗證 PIN |
| POST | `/api/jira/batch-create` | 批量建立 Issues（限速 15/min） |
| POST | `/api/jira/batch-comment` | 批量評論（背景 job） |
| GET | `/api/jira/batch-comment/stream` | SSE 接收評論進度 |
| POST | `/api/jira/batch-transition` | 批量轉換狀態 |
| POST | `/api/jira/pm-batch-create` | PM 模式：自動建 Epic + Story |

---

## 執行結果

- 每筆 Issue 回傳 Jira Key（如 `PROJ-123`）
- 失敗項目列出錯誤原因
- 可寫回 Lark Sheet 的 Jira Key 欄位
