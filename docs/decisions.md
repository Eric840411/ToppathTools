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

## [2026-09-07] Backend UAT 錄製改用 Lark 編號與監控型 artifact

**決策**：錄製後的新自訂 TC 以 Lark 主欄位「編號」精確查候選；正式保存步驟時使用 `tableId:recordId` 作為 key。錄製中的 console/network/API/網速只作為 session 監控；要後續上傳 Lark 的證據必須保存成正式 `screenshot` 積木。

**理由**：任務文字會改寫，拿關鍵字做歸戶會讓腳本受文案影響；複製出的 Lark table 可能保留相同 `record_id`，單用 record_id 會互相覆蓋。監控資料通常只用來輔助錄製與除錯，不應每筆都變成 TC 定義；截圖指令則是可重跑、可上傳的測試 artifact，應進入積木契約。

**適用範圍**：Backend UAT 錄製、未歸戶自訂 TC、單筆 TC 積木保存與執行。

**重看條件**：Lark TC 表改掉「編號」欄位名稱、同一編號需要自動挑唯一列，或 Lark 回寫欄位要從附件改成專用 evidence 欄位時。

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


## LuckyLink 池變動抓取：時區與分頁（2026-09-08，v4.126.0 / v4.126.1）

### 🚨 `dateTime` 是本地時間（UTC+8），不是 UTC

**跟 OSM／GCP 後台相反。**那邊的 `dateTime[]` 確實是 ISO UTC（見 CLAUDE.md
「Performance Meter 對帳」），LuckyLink 這支不是。兩個後台同名參數用不同時區。

實測（同一時段，資料表裡有 1314 筆）：

```
送 UTC 字串  [2026-09-06 06:00 → 07:00]  →   0 筆
送本地字串   [2026-09-06 14:00 → 15:00]  → 500 筆
```

送錯的後果是**整條 L4／L5 管線穩定落後 8 小時**，而且看起來一切正常——
資料一直在進來，只是永遠是 8 小時前的。決定性佐證：修正前資料表最新
9/7 17:27、當下 9/8 01:27，差距**正好 8.0 小時**。

⚠️ **修完時區之後，游標也必須校回真實資料點。**舊游標是在偏移的語意下寫的，
會宣稱「完整到 9/8 01:23」而實際只有到 9/7 17:27——那 8 小時會被當成已完成
永遠跳過。校回後第一輪就補進 1,174 筆。

### 🚨 分頁截斷會靜默掉資料

舊做法用「游標 → now」單一視窗、上限 `500 × 10 = 5000`。這支 API 是**新到舊**
排序——撞上限時拿到最新的 5000 筆，游標接著跳到最新那筆，**中間沒抓到的整段
永遠跳過**。跟 Jira 對帳 v4.99.0 同一種壞法：截斷完全沒有徵兆。

現在分兩條路：

| 路徑 | 做法 |
|---|---|
| 即時視窗 | 固定 `now-90s ~ now-10s`，結構上不可能撞上限 |
| 補進度 | 30 分鐘切片往前走，一輪最多 4 片 |

**游標語意也換了**：從「我看過最新的一筆」改成「**到這裡為止是完整的**」，
只由補完整的切片推進。沒有這個改動，即時視窗抓到的新資料還是會把游標推過缺口。

切片撞上限 → 對半切重試，最小 **1 秒**（資料時間精度到秒，再切已無法區分）。
1 秒還打滿 → **不推進游標**、明確報出哪一段／打滿幾筆／要改用什麼條件，停止自動補。
**刻意讓它卡住而不是跳過去**——跳過去等於靜默掉資料，卡住至少看得見，
而且即時視窗照常運作、當下資料不會斷。

### 已知缺口（暫不回補）

以下時段在修正前就已經沒抓到，新機制只保證從此不再產生新缺口：

```
2026/9/5 21:28 → 2026/9/6 11:10   （13.7 小時）
2026/9/6 11:12 → 2026/9/6 12:01   （0.8 小時）
2026/9/6 16:51 → 2026/9/7 09:44   （16.9 小時）
```

**要回補的話**：先備份 DB、記下目前 cursor，再把 cursor 分段倒回去讓補進度重跑
（CodeX 建議）。⚠️ 這幾段有可能本來就沒有活動——**回補前先用小視窗直接打一次 API
確認那段真的有資料**，不要重蹈「拿『我們沒收到』證明『對方沒有』」的覆轍。

## 移除 AutoSpin 的 LuckyLink JP 比對與截圖監控（2026-09-08，v4.127.0）

使用者決定拿掉派工頁那兩個勾選框，之後在對帳工具一次做好。

**為什麼可以拿掉**：QAT 上對帳台的 L4／L5 是**嚴格超集**——每 60 秒固定跑（不用記得勾）、
逐筆驗證 `change ≈ 投入額差 × 增額%`、會落庫也會產生 finding。agent 那支 poller 只是
抓池值快照丟到執行監控面板，跑完就沒了。

⚠️ **代價**：agent poller 是唯一涵蓋 **UAT／PROD** 的路（對帳台目前只跑 QAT），
移除後那兩個環境暫時沒有獎池能見度。使用者接受，等對帳台擴過去。

⚠️ **保留的東西**（跟 CodeX 討論定案）：

| 保留 | 理由 |
|---|---|
| `jp_groups` 表與資料 | 對帳台擴到 UAT／PROD 還需要那些網址與憑證，重建成本比留著高 |
| 舊截圖檔案 | 短期排查素材，已有 48 小時清理機制 |
| `autospin_notify_prefs.screenshotEnabled` | 刪欄位要動 schema，收益不大 |

**⚠️ 但 legacy 欄位一定要從執行路徑拔乾淨**：端點、agent start 回傳、Python 參數
全部移除，只留欄位本身，並在程式碼標明「legacy, no runtime effect」。
留一個「還在被讀但沒有作用」的欄位，比刪掉更容易讓後來的人誤會。

### 🚨 `page.screenshot()` 不能跟著拿掉

那個觸發點同時是**模板比對（Bonus／Error 偵測）唯一的輸入**，而**戰績紀錄**與
**Pinus 對帳資料**也共用它。原本的開關只控制「要不要上傳到畫廊」那一行。
把整段拿掉會連帶弄壞三個沒人提到的功能。

### Discord 的「截圖」欄位一併移除

沒有上傳就永遠是空的。**留一個永遠空白的欄位，跟「顯示過期的值」「把不會發生的事
說成還在等」是同一類問題**——畫面在宣稱一件不成立的事。

### 待決：AutoSpin 的「JP Group」管理分頁

CodeX 指出那個分頁現在已經沒有任何功能在使用（派工不再讀它）。留著會讓人以為
設定了會生效。**但對帳台之後要擴到 UAT／PROD 時又需要維護那些憑證**，所以是
「先隱藏、之後接回對帳台」還是「直接移除、之後重做」尚未決定。

# 2026-09-08 — Backend UAT 移除模組計畫，改為 TC 直接執行

- Backend UAT 不再維護模組模板、模組實例、關鍵字匹配規則與執行排序；先前的模組計畫決策由本條取代。
- Lark 掃描直接回傳表格內的 TC 與子類型統計，主執行僅以環境／裝置條件及使用者明確選擇的 Subtype 篩選，不再透過模組漏斗排除新 TC。
- 左側改為單一 TC 清單，錄製、積木匯入匯出與單筆 TC 編輯都從清單進入。
- 自訂 TC 可用 `UAT_CUSTOM_TRIAL` 建立暫時 TC 獨立 dry-run，不需要先歸戶或提供 Lark 表格；試跑不讀取、不上傳也不回寫 Lark。確認後再以 Lark「編號」精確選擇歸戶對象。
- 單筆試跑同時以自訂 ID 設定 `UAT_TC_ONLY` 作為向下相容保險：舊 runner 不認得 `UAT_CUSTOM_TRIAL` 時只能篩出 0 筆，禁止退回全表執行；已知落後的 Local Agent 會在派工前直接拒絕並要求更新。
