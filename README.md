# Workflow Integrator Frontend

這是整合以下三條流程的前端入口：

- Jira 自動寫入與流程狀態切換
- Lark 規格書 -> AI testcase -> Bitable 寫入
- Gmail 週報抓取 -> 版本抽取 -> 通知/回寫

## 快速啟動

```bash
npm install
cp .env.example .env
npm run dev
npm run dev:server
```

## 目前已完成

- `src/App.tsx`：整合控制台介面
  - 端點總覽（Jira/Lark/Gmail/OSM）
  - 基本設定表單（可對應 `.env`）
  - 欄位映射與 sample payload
  - 上線前缺漏資料清單
- `.env.example`：環境變數樣板

## 建議後端 API（下一步）

前端不應直接持有第三方密鑰，建議建立：

- `POST /api/integrations/jira/create-issue`
- `POST /api/integrations/jira/add-comment`
- `POST /api/integrations/jira/transition`
- `POST /api/integrations/lark/generate-testcases`
- `POST /api/integrations/lark/push-bitable`
- `POST /api/integrations/gmail/latest-report`
- `POST /api/integrations/osm/version-sync`

目前已建立第一版 `server/index.ts`，其中：

- 已可直接打外部 API：Jira 建單 / 留言 / 轉狀態、Gmail latest query
- 先提供可測 stub：Lark generate-testcases、OSM version-sync（先收資料，下一版接真實寫入）

## 上線前必備資料

- Jira OAuth/Token 與 Project/IssueType/CustomField 對照
- Lark app 資訊（`app_id`, `app_secret`, `tenant_access_token` 流程）
- Lark Bitable `app_token`, `table_id`, 欄位 schema
- Gmail OAuth Client 與授權 scope
- OSM backend token 取得與過期處理
- 外部使用者登入策略（建議 SSO + RBAC）
