# AI Agent 後台監控

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 16. AI Agent 後台監控（全域）

**路由**：`GET /api/ai-agent/monitor`

### 功能說明
偵測目前在線的 AI Agent（AutoSpin / Machine Test 分散式 Agent），顯示連線狀態與最後活動時間。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看在線 Agent | 顯示所有已連線 Agent 的 ID、類型、最後心跳時間 |
| 查看 Agent 歷史 | 每個 Agent 的操作歷史紀錄 |

---
