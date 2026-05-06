# AutoSpin

**路由**：`/api/autospin/*`｜**歷史紀錄 feature key**：`autospin`

---

## 功能說明

管理多個 AutoSpin Python Agent，每個 Agent 對應一台機器執行自動旋轉，支援暫停/繼續/停止，可匯出對賬報告。

---

## 操作流程

```
下載 Agent 安裝包（install.bat / agent.py）
  └▶ 在目標機器安裝並啟動 Agent
       └▶ Server 端管理面板：啟動/停止/暫停各 Agent
            └▶ SSE 串流 Agent 日誌
                 └▶ 查看截圖
                      └▶ 匯出對賬報告（CSV）
```

---

## 操作項目

| 操作 | 說明 |
|------|------|
| 啟動 Agent | 指定機台代碼與設定，啟動 AutoSpin session |
| 停止 / 停止所有 Agent | 手動停止單一或全部 Agent |
| 暫停 / 繼續 Agent | 暫停自動旋轉，保持連線 |
| 查看即時日誌 | SSE 串流 Agent 執行日誌 |
| 查看截圖 | 查看 Agent 捕捉的遊戲截圖 |
| 查看歷史紀錄 | AutoSpin 各 session 的執行紀錄 |
| 設定 Spin 間隔 | 調整每次 Spin 的等待時間 |
| 管理 Bet Config | 設定各機種的下注隨機配置 |
| 管理模板圖片 | 上傳/刪除用於比對的遊戲狀態模板圖 |
| 下載 Agent 安裝包 | 下載 `install.bat` / `launcher.bat` / `agent.py` |
| 對賬功能 | 比對遊戲紀錄與帳戶餘額，生成對賬報告 |

---

## Agent 下載端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/autospin/agent/download/install.bat` | Windows 安裝腳本 |
| GET | `/api/autospin/agent/download/agent.py` | Python Agent 程式 |
| GET | `/api/autospin/agent/download/launcher.bat` | 啟動腳本（含 Server URL） |

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/autospin/start` | 啟動 AutoSpin session |
| POST | `/api/autospin/stop` | 停止 session |
| GET | `/api/autospin/status` | 查詢狀態 |
| GET | `/api/autospin/stream/:sessionId` | SSE log 串流 |
| GET | `/api/autospin/history` | 歷史紀錄 |
| POST | `/api/autospin/reconcile/run` | 執行對賬 |

---

## 環境變數

| 變數 | 說明 |
|------|------|
| `AUTOSPIN_PYTHON` | Python 執行檔路徑（如 `C:\...\python.exe`） |
