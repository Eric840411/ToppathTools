# Toppath Tools — 文檔總覽

> 版本：v3.11.6 | 最後更新：2026-04-30

---

## 快速導覽

| 文檔 | 說明 |
|------|------|
| [架構與啟動](./architecture.md) | 系統架構、端口說明、啟動方式 |
| [API 端點總覽](./api-endpoints.md) | 所有後端 API 路徑一覽 |
| [OSMWatcher 串接](./osmwatcher.md) | Webhook 規格、配置說明 |
| [環境變數說明](./env-vars.md) | `.env` 各變數用途 |

---

## 工具清單

| # | 工具 | 說明 | 文檔 |
|---|------|------|------|
| 1 | Jira 批量開單 | 從 Lark 讀規格，批量建 Jira Issue | [→](./tools/01-jira.md) |
| 2 | TestCase 生成 | 多份文件 → Gemini AI → TestCase → 寫回 Lark | [→](./tools/02-testcase.md) |
| 3 | OSM 版號同步 | 追蹤各渠道元件版本，推送告警 | [→](./tools/03-osm-version.md) |
| 4 | 機台自動化測試 | Playwright 全自動測試（Spin/音頻/iDeck/CCTV） | [→](./tools/04-machine-test.md) |
| 5 | UAT 整合測試 | 從 Lark Bitable 讀取 TC，自動執行後端整合測試 | [→](./tools/05-uat.md) |
| 6 | 圖片刪除驗證 | 驗證已刪圖片是否仍被載入 | [→](./tools/06-image-check.md) |
| 7 | Config 比對 | serverCfg.js vs Template AI 差異分析 | [→](./tools/07-config-compare.md) |
| 8 | AutoSpin | 管理多台機器自動旋轉 Python Agent | [→](./tools/08-autospin.md) |
| 9 | URL 帳號池 | 管理多帳號 URL，避免帳號衝突 | [→](./tools/09-url-pool.md) |
| 10 | Jackpot 監控 | 每 15 秒拉取獎池數值，異常推 Lark 告警 | [→](./tools/10-jackpot.md) |
| 11 | Game Show 工具 | PDF TestCase、圖片比對、500x 統計、Log 攔截 | [→](./tools/11-gameshow.md) |
| 12 | 操作歷史紀錄 | 記錄所有重要操作 | [→](./tools/12-history.md) |
| 13 | AI 模型設定 | 管理 API Keys、Prompt 模板 | [→](./tools/13-ai-settings.md) |
