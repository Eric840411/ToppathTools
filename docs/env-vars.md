# 環境變數說明

> 設定檔：`.env`（專案根目錄，已加入 `.gitignore` 不會被提交）

---

## 核心

| 變數 | 說明 |
|------|------|
| `PORT` | Server 監聽端口（預設 3000） |
| `ADMIN_PIN` | 管理員操作 PIN（用於 Jackpot 閾值設定等需要確認的操作） |

---

## Discord

| 變數 | 說明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord Bot Token |
| `DISCORD_GUILD_ID` | Discord 伺服器 ID |
| `DISCORD_CURSOR_CHANNEL_ID` | Bot 監聽的頻道 ID |
| `DISCORD_ALLOWED_USER_IDS` | 允許遠端控制的 User ID（逗號分隔） |

---

## Jira

| 變數 | 說明 |
|------|------|
| `JIRA_BASE_URL` / `VITE_JIRA_BASE_URL` | Jira 伺服器位址 |
| `JIRA_PROJECT_ID` | 預設專案 ID |
| `JIRA_ISSUE_TYPE_ID` | 預設 Issue Type ID |
| `JIRA_TRANSITION_ID` | 預設 Transition ID |
| `JIRA_VERIFIER_FIELD_ID` | 驗收人自訂欄位 ID |
| `JIRA_DIFFICULTY_FIELD_ID` | 難度自訂欄位 ID |
| `TEAM_ACCOUNT_IDS` | 團隊成員 accountId（逗號分隔） |

---

## Lark

| 變數 | 說明 |
|------|------|
| `LARK_APP_ID` | Lark App ID |
| `LARK_APP_SECRET` | Lark App Secret |
| `LARK_BASE_URL` | Lark API Base URL |
| `LARK_WEBHOOK_URL` | 告警推送 Webhook URL |
| `LARK_TESTCASE_FOLDER_TOKEN` | TestCase Bitable 自動建立的資料夾 token |
| `LARK_OSM_APP_TOKEN` | OSM 版本記錄 Bitable App Token |
| `LARK_OSM_TABLE_ID` | OSM 版本記錄 Table ID |

---

## AI 模型

| 變數 | 說明 |
|------|------|
| `GEMINI_API_KEY` | Gemini API Key（DB 無 Key 時 fallback） |
| `GEMINI_MODEL` | 預設 Gemini 模型（如 `gemini-2.5-flash`） |
| `OLLAMA_BASE_URL` | Ollama 服務位址（如 `http://192.168.x.x:11434`） |
| `OLLAMA_MODEL` | Ollama 模型名稱（如 `gemma4:26b`） |
| `OPENAI_API_KEY` | OpenAI API Key（填入後自動出現 GPT-4o 選項） |

---

## Google

| 變數 | 說明 |
|------|------|
| `GOOGLE_API_KEY` | Google Sheets API Key |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service Account 信箱（用於回寫 Google Sheet） |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Service Account 私鑰 |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 Client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 Client Secret |
| `GMAIL_REFRESH_TOKEN` | Gmail Refresh Token（不會過期） |
| `GMAIL_QUERY` | Gmail 搜尋條件（用於 ImageRecon 週報） |

---

## OSM

| 變數 | 說明 |
|------|------|
| `OSM_BASE_URL` | OSM Backend URL |
| `OSM_CHANNELS` | 渠道清單（逗號分隔，如 `CP,WF,TBR`） |
| `OSM_CHANNEL_{NAME}_ID` | 各渠道 ID |
| `OSM_CHANNEL_{NAME}_USERNAME` | 各渠道帳號 |
| `OSM_CHANNEL_{NAME}_PASSWORD` | 各渠道密碼 |
| `OSM_CHANNEL_{NAME}_ORIGIN` | 各渠道 Backend Origin |

目前渠道：`CP`, `WF`, `TBR`, `TBP`, `MDR`, `DHS`, `NP`, `NCH`

---

## LuckyLink

| 變數 | 說明 |
|------|------|
| `LUCKYLINK_BASE_URL` | LuckyLink Backend URL |
| `LUCKYLINK_USERNAME` | LuckyLink 帳號 |
| `LUCKYLINK_PASSWORD` | LuckyLink 密碼 |
| `LUCKYLINK_ORIGIN` | LuckyLink Origin |

---

## AutoSpin

| 變數 | 說明 |
|------|------|
| `AUTOSPIN_PYTHON` | Python 執行檔路徑（如 `C:\...\Python313\python.exe`） |
