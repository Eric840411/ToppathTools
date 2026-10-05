# 機台測試整批工具（machine-test batch）

搭配中控「機台自動化測試」使用的本機腳本：讀 Lark 測試表 → 叫本機 agent 逐台跑 → 回寫 Lark → 產 HTML 報告。

| 檔案 | 用途 |
|---|---|
| `machine-test-batch.mjs` | 主程式（整批執行、換帳號續跑、回寫 Lark、產報告） |
| `machine-test-report.mjs` | summary.json → report.html（右上角可切換中／EN） |
| `machine-test-report-i18n.mjs` | 報告英文翻譯對照表；直接執行會列出歷史報告裡還沒翻到的中文片段 |

## 執行

```bash
node scripts/machine-test/machine-test-batch.mjs --sheet "<Lark 網址>" --machines 1559-1572 --steps all [--dry-run]
node scripts/machine-test/machine-test-report-i18n.mjs 40   # 翻譯覆蓋率檢查
```

## 資料與密碼（都不進 git）

- `MT_HOME`：資料根目錄，預設是 repo 旁邊的 `../osm-qa-agent`。底下要有 `config/`（大廳網址、密碼檔）、`knowledge/`（機種設定、退出手冊）、`reports/`（輸出）、`data/`（中控登入 cookie）。
- 密碼／金鑰：環境變數優先，否則讀 `<MT_HOME>/config/machine-test-secrets.json`：

| 環境變數 | secrets.json 欄位 |
|---|---|
| `MT_LOGIN_PIN` | `loginPin` |
| `MT_ADMIN_PIN` | `adminPin` |
| `MT_LARK_APP_ID` | `larkApp` |
| `MT_LARK_APP_SECRET` | `larkSecret` |
| `MT_QAT_BACKEND_PASSWORD` | `qatBackendPassword` |
| `MT_LUCKYLINK_BACKEND_PASSWORD` | `luckyLinkBackendPassword` |

中控登入會沿用 `<MT_HOME>/data/toppath-central-session.txt` 的 cookie，失效才重新登入（避免每跑一次就多一個 7 天的 session）。
