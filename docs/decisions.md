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

## [2026-08-10] AutoSpin比對工具統一視覺風格（普通版+仙俠版雙版本）

**決策**：AutoSpin比對工具（三路對帳）同時維護普通版與仙俠版兩套視覺，硬規則寫進 `AGENTS.md`，本條記錄背景。

**理由**：
- 之前CodeX設計mockup/生圖時沒有自動套用統一風格，每次要重新在對話裡講一次配色/術語，等於每次都在燒token重講同樣的事
- 主版（普通版）定位是監控/除錯/對帳工具，維持清楚、密度高、狀態燈明確的操作型UI，不因為視覺實驗改變資訊結構
- 仙俠版定位是「主題皮膚」，欄位群組/多線程機台/即時比對/不符明細等資訊結構不變，只換視覺語言（玉簡/陣法/靈石狀態燈/符籙分組）

**Palette 來源**：2026-08-10 CodeX在Toppath頻道提案，青玉+墨黑+金符為主視覺方向：
- 底色：深墨黑`#101716`、黛青`#18312F`
- 主色：青玉綠`#62C6A5`
- 輔色：符金`#D8B45A`
- 警示：朱砂紅`#D94A3A`
- 異常：幽紫`#8E6BE8`
- 成功：靈玉亮綠`#7FF0B8`

**適用範圍**：AutoSpin比對工具與其後續延伸功能；其他既有工具頁面不強制套用仙俠版，除非後續另有決策

**重看條件**：
- 仙俠版配色跟語意色（警示橘/錯誤紅/成功綠/disabled/hover等）打架時，優先只調整衝突的語意token，不動整套底色（CodeX建議）
- 如果仙俠版配色/裝飾語言證實好看，可以抽色彩/裝飾語言回主版，但不整個工具遊戲化

---

## [2026-08-21] UAT 積木編輯器採「巢狀 DSL、執行前編譯」

**決策**：H5／PC 測試腳本在資料庫中保存帶有穩定 `id` 與 `children` 的巢狀積木結構；實際送往既有 Playwright runner 或 Local Agent 前，將群組展開、重複區塊依次數展開為既有扁平 action 清單。

**理由**：
- 使用者需要隨時拖曳、分組與調整步驟，扁平 JSON 不足以表達編輯狀態。
- runner、SQLite schema 與 Agent 通訊協定已在使用中，直接改成新的執行模型會讓舊腳本及舊 Agent 失效。
- 編輯格式與執行格式分離後，可漸進新增積木，不必一次重寫整個執行器。

**相容策略**：舊腳本載入時補上積木 `id`，錄製器輸出的 `fill` 正規化為 `type`；儲存仍使用現有 `steps` 欄位，Local 與 Agent runner 均支援每步驟 continue／stop／retry 設定。

**限制**：目前跨腳本共用模組尚未抽成獨立資料表；群組與重複區塊是腳本內模組。若要支援組織級模組版本鎖定，另建 module／revision schema，不在既有 scripts 表上硬加引用。

---

## 驗證標準（每次 review 後）

每次重要改動後，最低驗證：
1. `npx tsc --noEmit` — 無型別錯誤
2. `npm run build` — build 成功，無新的錯誤
3. 手動確認主要功能路徑正常
# 2026-08-21 — Backend UAT 採模組計畫驅動 runner

- Backend 工作台依 `run-lark-tc-backend.js` 現有 verifier 分成 Dashboard、EGM、報表、設定、Meter、Ranking、Jackpot、預約、Log、VIP／版本與其他模組。
- 前端拖曳順序會以 `UAT_MODULE_PLAN` 傳給每次新 spawn 的 Node.js process；runner 在 Lark TC 篩選後依模組計畫排序，不改為常駐服務。
- UAT 主內容使用滿版工作台；大螢幕三欄、中螢幕將設定區移至下方、窄螢幕改單欄，避免右側留白。

# 2026-08-21 — Backend UAT 模組採可編輯實例契約

- 流程不再只保存固定模組 ID，而是保存具穩定 instanceId、雙主題名稱、說明、識別色與字串匹配規則的模組實例。
- 使用者可從模板重複建立實例、複製既有實例或新增自訂模組；各實例可獨立編輯且持續支援拖曳排序。
- 路由僅接受經 Zod 限制長度與數量的安全字串規則，再透過 UAT_MODULE_PLAN 傳給新 spawn process；runner 不執行使用者提供的 RegExp 或程式碼。
- runner 先按流程順序比對一般關鍵字，最後才使用 `*` 模組接收未分類 TC，避免 catch-all 提前攔截。

# 2026-08-21 — Backend UAT 改走 Agent 派工（A2）

- Playwright 從 server 本機 spawn 改成派工給有 `backend-uat` capability 的 Local Agent；server 只負責建 session、挑 agent、把 log 轉進既有的 SSE。伺服器端 spawn 保留當 fallback，公網（Spug）上不必裝瀏覽器。
- **單一 agent 派工，不做 work-stealing**：UAT 是一次一輪循序跑完，不是併發搶工場景，硬做 work-stealing 只會讓 session／log／stop 的邊界變複雜（跟 CodeX 討論定案）。做法照 `scripted-bet` 那套，不另創第三種模式。
- WS 訊息四支：`backend_uat_start`（server→agent，帶 Lark token／模組計畫／帳密）、`backend_uat_log`（agent→server，逐行）、`backend_uat_done`（agent→server，帶 exit code）、`backend_uat_stop`（server→agent）。
- `osm-uat.ts` 掛在 worker process，跟 `/ws/agent` 同一個 process，所以直接拿 `agentConnections` 發訊息，不用再跨 process 轉一手。
- **停止要分支**：agent 模式送 `backend_uat_stop` 並等 agent 回 `backend_uat_done` 才算真的停（才拿得到真實 exit code）；fallback 模式才 kill 本機 child。兩邊不共用同一套 kill 假設。
- **指名 agent 挑不到一律 409，不默默 fallback 成伺服器端**：否則使用者以為跑在自己機器上，實際在公網主機偷偷開了一顆 Chromium。
- **agent 斷線要優先攔截**：Backend UAT 的 sessionId 是 UUID、沒有 `sb_` 前綴，不先攔下來會掉進 worker 既有的機測分支，誤呼叫 `cancelDistSession` 並廣播機測錯誤。

## ⚠️ 未完成項：agent hub 仍是 ws://（明文）

後台測試帳密原本是注入本機子程序的環境變數（v4.22.0 才剛從 repo 裡的 config 檔搬進 DB），改派工之後必須跟著 `backend_uat_start` 走 `/ws/agent` 離開本機。而 `CENTRAL_URL` 預設是 `ws://`。

**這版是「延續既有明文通道」，不是安全完成態**——`autospin_start` 的 LuckyLink `loginPass` 早就走同一條線，所以不是新開的洞，但 v4.22.0 的保護在這條路徑上等於少了一半。

已做的緩解：
- 帳密只在記憶體，不寫進 session record／`session.logs`／SSE／歷史紀錄
- log 兩層 redaction（agent 送出前遮一次、server 收到後再遮一次）——Playwright 例外堆疊或腳本 print env 都可能把密碼帶出來，漏一次就永久寫進 `session.logs` 並推給所有 SSE 訂閱者
- agent 上不放 `config/backend-test-params.json`，帳密逐次隨派工帶，不落地

**重看條件**：agent hub 換成 `wss://`（列為後續必修），或 agent 需要跨越不受信任的網路時。

