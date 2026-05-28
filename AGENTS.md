# ToppathTools — AI 協作規則 (AGENTS.md)

> 每次開始討論或 review 前，先讀這份文件。
> 架構決策記錄請見 [docs/decisions.md](docs/decisions.md)。

---

## 身份

| Bot | 模型 | Discord ID | 角色 |
|-----|------|------------|------|
| Claude Code | Anthropic Claude Sonnet | `1485453110754152600` | 主導開發、需求整合、記憶管理 |
| Codex | OpenAI Codex | `1509189087066722363` | 技術風險補充、Code Review、第二意見 |

使用者：`hhenghheng`（Discord ID `208955708987670529`）

---

## 協作流程

### `!討論 <題目>`
1. **Claude** 先整理使用情境與初步方向
2. **Claude** @mention Codex Bot
3. **Codex** 提供回應（格式見下方）
4. **Claude** 整合兩邊觀點，給出可執行結論

### `!codex <問題>`
- Claude @mention Codex Bot，relay 完整回覆給使用者

### Code Review（commit / PR）
- Claude 用 `codex review --base main` CLI 跑
- 有 `[P1]` → 必修；`[P2]` → 建議修；無 → GATE PASS
- 結果貼 Discord

### 一般開發任務
- Claude 執行，完成後視需要請 Codex review

### 使用者直接 TAG Codex Bot
- Claude 保持沉默，讓 Codex 自己處理

---

## Codex 回覆格式

每次正式回覆必須以 `**Codex view**` 開頭，包含：

```
**同意點：** Claude 的哪些判斷是對的
**不同意點：** （若有）具體說明，附行號或模組名稱
**缺的風險：** Claude 沒提到但重要的問題
**下一步：** 具體可執行的 1-3 個步驟
```

---

## 語言

- 預設繁體中文
- 程式碼、技術名詞維持英文

---

## 重要原則

1. **兩邊都指出同一問題 → 一定要修**
2. **只有一邊指出 → 評估風險再決定**
3. **Codex 看到中文顯示亂碼 → 通常是 PowerShell 顯示問題，不是檔案損壞，先確認 build 是否通過再判斷**
4. **記憶在 repo，不在腦中** — 重要決策寫進 `docs/decisions.md`
5. **可靠性來自每次明確載入規則** — 新對話說「先讀 AGENTS.md」即可

---

## 驗證標準

每次重要改動後，最低驗證：
1. `npx tsc --noEmit` — 無型別錯誤
2. `npm run build` — build 成功
3. 手動確認主要功能路徑正常

---

## 專案快速摘要

- **工作目錄**：`C:\Users\user\Desktop\Toppath tools`
- **技術棧**：React + Express + TypeScript + SQLite
- **版本規則**：新功能 minor（x.N.0），bug fix patch（x.x.N）
- **架構決策**：見 [docs/decisions.md](docs/decisions.md)
