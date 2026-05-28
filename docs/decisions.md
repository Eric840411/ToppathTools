# ToppathTools — 架構決策記錄

> 每條決策附上日期、理由、適用範圍、重看條件。

---

## [2026-05] 登入系統：Jira email + PIN，不拆 User/JiraConnection

**決策**：身份驗證與 Jira 帳號綁在一起，email 同時作為使用者 ID 和 Jira 帳號 key。

**理由**：
- 團隊小（< 10 人），所有人都有 Jira 帳號
- 拆分需要重新定義權限矩陣，成本高於收益

**適用範圍**：小型內部工具，團隊成員全部使用 Jira

**重看條件**：
- 有不使用 Jira 的角色需要登入（例如純觀察者）
- Jira token 過期問題頻繁影響使用
- 帳號超過 20 個

---

## [2026-05] Playwright 腳本執行透過 Local Agent

**決策**：UAT 腳本執行不在公網伺服器跑，全部透過連線的 Local Agent 執行。

**理由**：
- 公網伺服器無法安裝 Playwright
- Agent 機器本地執行更接近真實環境

**適用範圍**：UAT 整合測試功能

**重看條件**：有辦法在伺服器安裝 Playwright 且環境一致時

---

## [2026-05] PIN 安全設定

**決策**：
- PIN 用 SHA-256 hash 儲存（非明文）
- 登入 rate limit：`loginLimiter` 每分鐘最多 10 次
- 新帳號可自助新增；覆蓋已存在帳號需 admin 身份

**理由**：
- 內部工具，bcrypt 成本暫不必要
- 10次/分鐘足以防暴力破解
- 自助新增方便新成員加入，但覆蓋限 admin 防止帳號被篡改

**重看條件**：工具對外開放或有外部使用者時

---

## [2026-05] 登出時清除 localStorage 上次登入記錄（已撤銷）

**狀態：superseded（2026-05-28）**

**原決策**：`logoutAuthAccount()` 在 logout fetch 前清除 `toppath_last_login_email`。

**撤銷原因**：清除 localStorage 導致登出後「上次登入」badge 消失，使用者每次登出後都要重新找自己的帳號。Race condition 實際上無害（短暫顯示 PIN 畫面，logout 完成後自然解除），且 React 狀態更新批次化後此問題幾乎不會發生。

**現行做法**：登出時不清除 `toppath_last_login_email`，「上次」badge 在 logout 後仍保留。

---

## 驗證標準（每次 review 後）

每次重要改動後，最低驗證：
1. `npx tsc --noEmit` — 無型別錯誤
2. `npm run build` — build 成功，無新的錯誤
3. 手動確認主要功能路徑正常
