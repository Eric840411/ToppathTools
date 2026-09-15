# Jira 批量開單／評論／修改

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

# Jira 權限三合一（2026-08-31，v4.81.0）

權限頁原本列三筆 Jira 權限（「批量開單（QA 模式）」「批量開單（PM 模式）」「批次更新票」），但 `App.tsx` 的判斷是：

```ts
if (tabId === 'jira') return permissions.includes('jira-qa')
  || permissions.includes('jira-pm') || permissions.includes('jira-update')
```

**三個 key 是 OR、而且都指向同一個頁面。**管理員關掉其中一個，使用者照樣進得去——畫面看起來是三個獨立開關，實際上是一個。**這比顆粒度不夠細危險，因為它製造假的安全感。**（跟 CodeX 討論，他也認為這算 bug fix 不是功能調整。）

收成單一的 `jira`，`canAccess()` 的特例整條移除——canonical key 剛好等於 tabId，直接走通用判斷。

**⚠️ 合併規則一定要是 OR，不能挑其中一個當 canonical。**實際資料裡 `jira-update` 對 pm 是 0，單留它會**當場撤掉 PM 的存取權**，而且不會有人發現是這次改動造成的。OR 才能保證每個角色改動前後的實際存取結果完全一樣。

**⚠️ 原本有一段反方向的 migration**（把 `jira` 拆成 `jira-qa` + `jira-pm`，PM 模式還在的時代寫的）。那段留著會跟新的合併打架：插入的 `jira` 列會在下一次啟動被它拆回去，而且**不會有任何錯誤訊息**。所以是刪掉它，不是兩段並存。這是「退不了已經跑過的 DB migration」那一類問題的變形——方向相反的兩段 migration 並存，等於每次啟動互相推翻。

舊 key 的資料保留不硬刪（CodeX 建議，真有問題時還能對照），但已從 `ALL_PAGE_KEYS`／`PAGE_META`／`canAccess()` 移除，不再參與任何判斷。

**逐工具權限（頁內 4 個分頁各自 gate）是另一件事**，牽涉頁內 tab、API 權限、按鈕 disable、錯誤提示，範圍比「清掉誤導權限」大得多，要做該獨立一版。

> 已驗證 7 項（`scripts/ui-checks/jira-perm-merge-check.mjs`，跑完會完整還原 role_permissions）：合併結果等於三個舊 key 的 OR｜**PM 沒有被誤撤權限**｜重跑兩次不重複插入｜**手動調整過的 `jira` 列不被 migration 推翻**｜舊 key 資料仍保留。

# 批量評論預覽表的「填寫人」欄（2026-08-21，v4.17.0）

批量評論 Step 3 的預覽表每一列多一欄「填寫人（以誰的身分送出）」，顯示這一列實際會用哪個帳號張貼，並可用下拉**逐列調整**。三條規則：

1. **優先序與空白處理**（`identityEmailForRow()`，`JiraPage.tsx`）：
   - **沒選填寫人欄位** → 全部用登入者自己（這是明確的選擇，不是漏填）
   - **有選填寫人欄位**：逐列下拉覆寫 → 該格有值且對得到帳號就用那個帳號 → **有值但對不到、或該格空白，一律「未設定」並擋住送出**
   - 空白**不會**自動帶入自己（2026-08-21 使用者決定）——自動帶入等於幫使用者決定「這則留言用誰的名義發」，而那正是他要避免的用錯身分回覆
2. **對不到帳號／沒有代理授權時顯示「未設定」，不會把 Sheet 上的原始名字顯示出去**——顯示原始名字會讓人以為那個身分已經可用，實際送出才失敗
3. **下拉選項只列「我能用的帳號」**（自己＋已被授權代理的），名單由 `GET /api/jira/comment-as-candidates` 後端算好回傳。前端拿全帳號清單自己篩＝把整份帳號名單洩出去，這是資訊揭露邊界不是實作細節（v4.12.0 定的原則；v4.13.0 改成逐列代發時一度移除這支端點，v4.17.0 因為逐列下拉又需要而加回來）

**擋送出的依據換了**：從「名字清單上有紅字」（`personBlocking`）改成「**逐列真的解析不出身分**」（`rowIdentityMissing`）——使用者可以在預覽表直接補選一個授權帳號，補完就該放行，不用回頭改 Sheet。送出時一樣重新跑 `personEmailForRow()` 解析，不只相信 UI 下拉狀態（CodeX review 要求）；未設定的列**不會 fallback 成用自己送出**，否則使用者以為被擋住的列其實偷偷用自己的身分發出去了。

**逐列覆寫是暫時性的**：重新產生預覽就清空。`rowIndex` 不是穩定識別，重讀 Sheet 之後排序／篩選／內容都可能變，沿用舊的指定有機會把評論用錯人的身分送出去（跟 CodeX 討論定案）。

# 批量評論代理張貼（2026-08-20，v4.12.0）

「登入 Eric Wu，但想用 Siara 的身分回覆」。**兩個身分要分清楚**：

| 名稱 | 是什麼 | 從哪裡來 |
|------|--------|----------|
| actor（發起人）| 實際操作的人 | 登入 cookie → `auth_sessions`，**不是前端說了算** |
| commentAs（執行身分）| 實際拿誰的 token 打 Jira | `x-jira-email` header，但要通過授權驗證 |

兩者不同時，必須在 `jira_account_delegates` 查得到有效的 `jira.comment.batch` 授權（驗證在 `userJiraAuth()` 裡，見上一節），否則 403。沒有指定就是用自己，行為跟以前完全一樣。

**代發是「逐列」而不是「整批一個身分」（v4.13.0 改）**：Step 3 選一個「填寫人欄位」，系統把該欄的名字對應到後台帳號，每一列各自用對應帳號的身分張貼。v4.12.0 原本做的是「整批選一個身分」的下拉，使用者看到後說不符合實際用法（同一張表上不同列本來就是不同人填的），已移除避免兩套機制並存。沒選填寫人欄位＝全部用自己送出，行為跟以前一樣。

**名字 → 帳號的比對規則**（`matchAccountsByPersonName()`，`server/shared.ts`）：真實資料（使用者提供的驗證表單，116 列）的填寫人只有 `Siara`／`Eric`／`Lusa` 三種值，而後台帳號 label 是 `Eric Wu`／`lusa`，所以三層比對缺一不可——① 完全相等（比對 label 或 email 的 local-part）② 正規化（trim／小寫／壓縮空白）後相等 ③ **label 的第一個單字**相等（`Eric` → `Eric Wu`）。**刻意不用 substring 包含比對**，那會讓 `Jack` 誤中 `Jackson`（週報人名比對踩過同一個坑）。命中多筆一律標成 `ambiguous` 由人工確認，絕不自動挑一個。

**送出前檢查**（`POST /api/jira/comment-as-resolve`）：逐個不重複的填寫人回狀態，有任何一個不是 `ok` 就擋住送出——評論送出去收不回來，寧可先擋。

| 狀態 | 意思 | 畫面提示 |
|------|------|----------|
| `ok` | 對到帳號、有 token、有授權（或就是自己）| — |
| `no_account` | 後台查無此人 | 請先建立帳號 |
| `ambiguous` | 對到多個帳號 | 列出候選（只回 label，不回 email）請人工確認 |
| `no_token` | 有帳號但沒建 Jira API Token | 請該帳號去設定 |
| `not_authorized` | 有帳號有 token，但你沒有代理授權 | 請管理員到「Jira 代理張貼授權」開通 |

比對與授權判斷**全在後端**——前端拿全帳號清單自己比，等於把整份帳號名單洩出去，這是資訊揭露邊界不是實作細節。**後端在 `batch-comment` 還會再驗一次**（授權 + token），因為使用者可以跳過畫面檢查直接改 payload；整批任一筆過不了就全部擋下，不會跑到一半才發現第 37 列沒授權。

**驗證失敗的早退一律在搶重任務鎖之前**：原本驗證寫在拿鎖之後，403/400 直接 `return` 會把鎖留在原地沒人釋放，之後同一個使用者所有批次操作都被自己的殭屍鎖擋成 429（本機測試時實際踩到才發現）。

**job 歸屬記 actor，不是執行身分**：`ownerEmail` 與 SSE／status 的擁有者檢查都用 actor。否則以 Siara 身分送出時，Siara 會突然看到一個不是自己發起的 job，而 Eric 反而查不到自己的進度。已驗證：Eric 查得到、Dean（被代理者）查同一個 job 回 403。

**驗證只在送出當下做一次**（跟 CodeX 討論定案）：批次 job 視為快照——提交時合法就讓它跑完，中途撤銷影響的是下一個 job。同時**建立 job 當下就把解析後的執行身分固化進 job payload**，背景執行不再重新推導，避免長時間 job（100 筆 × 2 秒起跳）執行途中授權變動造成狀態漂移。

**稽核逐筆記身分**：`addHistory` 的 detail 存 job 層級的 `actorEmail`，以及**每一筆 result 上的 `commentAs`**（含失敗的列）——逐列代發時一個 job 可能有多個 Jira 身分，只記在 job 層級會追不到是哪一列用了誰。summary 會標「其中 N 筆由 X 代發」。使用者明確要求**不要**在 Jira 評論裡加代發標註（「就是走代發的路線」），所以 Jira 上只看得到被代理的帳號——這代表內部稽核是唯一能查出代發事實的地方，不能只記 actor。

管理介面在系統管理頁「帳號管理」分頁下方的「Jira 代理張貼授權」，只開給 admin（`requireAdmin`）——這是安全邊界設定，不走個人權限覆寫那套功能開關。撤銷用 `revoked_at` 標記不刪資料，畫面區分有效／已撤銷／已過期／停用；同一組 (代理人, 被代理人, 用途) 重複新增會復活既有那筆（表上有 UNIQUE），不會長出第二筆。

**開放範圍刻意只有批量評論**（使用者決定）：開單／修改／轉狀態一律只能用自己的身分。

> 已用本機真實 session + 真實帳號 curl 驗證 11 項：未授權時候選只有自己｜未授權代發 403｜admin 新增授權｜授權自己 400｜授權後候選出現對方｜授權後代發成功建立 job 並真的用對方 token 打到 Jira｜job 歸屬是 actor｜被代理者查同一 job 403｜歷史紀錄雙欄位正確｜撤銷後恢復 403｜重複撤銷 404。測試資料已清除。

# 個人權限覆寫與批量評論 AI 兩項拆分（2026-08-20，v4.11.0）

## 權限：角色預設 + 個人覆寫

原本權限完全是角色制（`role_permissions`：role × page_key，角色只有 qa／pm／other，admin 全開）。使用者要求 AI 功能開到「個人」——用角色開太粗（等於整個 QA 都有），所以**不動角色表**，另外疊一層 `account_permissions`（`email` × `perm_key` × `allowed`，email 一律小寫）：

- 沒有覆寫 → 沿用角色預設
- `allowed = 1` → 這個人額外有這個權限
- `allowed = 0` → 這個人被拿掉這個權限（即使角色有）
- **admin 一律全開且不套個人 deny**——否則「admin 永遠全開」這條規則會變模糊，也可能把管理員自己鎖在系統外

解析集中在 `getEffectivePermissions(email, role)`（`server/shared.ts`），`/api/admin/my-permissions` 回的就是合併後的結果，所以**前端的權限判斷邏輯完全不用改**。這張表對任何 key 都適用，之後其他功能要做個人例外不用再開新機制。

管理介面在系統管理頁的帳號列表，每列新增「功能權限」按鈕，每個 key 三態（繼承角色／強制開啟／強制關閉）直接對應「沒有這筆／`allowed=1`／`allowed=0`」。`PUT /api/admin/accounts/:email/permissions` 的防護（跟 CodeX 討論定案）：只接受 `ALL_PAGE_KEYS` 裡的 key（`sysadmin` 這種管理身分不可透過這支改，把安全邊界跟功能開關分開）、不認得的 key 回 400 **不靜默忽略**、禁止管理員改自己的覆寫（避免把必要入口關掉救不回來）、整批寫入包 transaction。

## 批量評論：AI 拆成兩個獨立項目

原本一個「AI 優化」勾選框同時做兩件事，而且兩者失敗語意本來就不同（排版失敗中斷整批、分析失敗只警告）。現在拆成兩個旗標，各自受權限控管（`jira-ai-format`／`jira-ai-review`，都在 `ALL_PAGE_KEYS` 裡，`PAGE_META` 歸在「功能開關」分組；`canAccess()` 只查 tabId，多出來的 key 不影響側邊欄）：

| 組合 | 行為 |
|------|------|
| 只開排版 | 貼一則 AI 改寫後的正文 |
| 只開分析 | 第一則貼**原文**，第二則分析**原文** |
| 兩個都開 | 第一則貼 AI 改寫正文，第二則分析**實際貼出去**的那份正文 |
| 舊 payload 只有 `useAi` | 等同兩個都開，但仍要通過後端權限 |

`useAi` 保留成 legacy fallback（`aiFormat ?? useAi`、`aiReview ?? useAi`），舊呼叫端行為完全不變。

**後端補上權限驗證**：先前後端對 `useAi` 完全沒有檢查，只有前端把選項藏起來——改 payload 就能繞過。現在 `/api/jira/batch-comment` 會驗，且權限一律以**登入 session 的帳號**為準（`getAuthAccount(req)`），不能吃 `x-jira-email`，否則權限本身也能被 header 偽造。沒權限直接回 403 並說明是哪一項，不靜默把旗標降成 false（靜默降級會讓使用者以為 AI 有跑）。

> 已用本機真實 session + 真實帳號 curl 驗證：讀／寫個人覆寫、不認得的 key 回 400、改自己回 400、覆寫確實能加上角色沒有的權限與拿掉角色有的權限、後端 403 擋下沒權限的那一項、有權限的那一項正常建立 job。測試資料已清除。

# Jira 身分邊界與代理授權（2026-08-20，v4.10.0）

**登入帳號就是 Jira 帳號**——同一張 `jira_accounts` 表，token 存後端，前端只送 `x-jira-email`。先前 `userJiraAuth()`（`server/shared.ts`）**完全信任這個 header**，而 `/api/jira/*` 沒有全域 auth gate，等於任何人只要知道別人的 email、改一個 header，就能用別人的 token 操作 Jira。這不是「還沒開放的功能」，是認證邊界本身錯了。

現在 `userJiraAuth(req, opts)` **預設只允許本人**：直接讀 cookie 對 `auth_sessions` 表判斷「這個請求真正登入的是誰」（不看前端說什麼），跟 header 不符就拒絕並印 `JIRA_IDENTITY_MISMATCH_DENY`。刻意不 import `auth-session.ts` 的 `getAuthAccount()`——那支檔案本身 import 了 `shared.ts`，反向 import 會形成循環相依，而 `shared.ts` 在模組載入當下就要開 DB／建表。

**代理授權**用 `jira_account_delegates` 表（`actor_email`／`target_email`／`scope` + `enabled`／`expires_at`／`revoked_at`，撤銷用狀態欄位不刪資料，才留得下稽核軌跡），判斷集中在 `hasJiraDelegation()` 一支 helper（啟用／未撤銷／未過期／scope 精準匹配），不散到各 route 各判一次。scope 目前兩種，**寫入與讀取刻意分開**：

| scope | 用途 | 目前誰在用 |
|-------|------|-----------|
| `jira.comment.batch` | 代理**寫入**：用別人的身分張貼批量評論 | 規劃中（Phase 2）|
| `jira.read.asOther` | 代理**讀取**：用別人的 token 查資料 | `POST /api/weekly-report/jira-by-range` |

**`weekly-report/jira-by-range` 是既有的跨帳號讀取功能，不是漏洞遺跡**：週報彙整的全自動載入本來就會用 Eric／Lusa／Siara 三個帳號的 email 平行呼叫，各自用各自的 token 撈自己的單（v4.5.0）。身分邊界加嚴時若不標註，這個每週在用的功能會當場壞掉。目前這支傳 `fallbackAllowUnauthorized: true`——查不到授權**仍然放行**，但印出可 grep 的 `JIRA_DELEGATION_FALLBACK_ALLOW`（含 actor／target／scope／route／時間）。**這是過渡狀態**：等從 log 確認實際用到哪些關係、補進授權表後，就要把這個 fallback 關掉。

> 已驗證：無 cookie＋他人 email → 401；本人 → 200；有 cookie 但用他人 email 打 `/api/jira/*` → 401；週報撈單跨帳號 → 放行並印 fallback 警告；補上授權列後警告消失；把該列 `enabled` 設 0 後警告恢復。

## 1. Jira 批量開單（JiraPage）

**路由**：`/api/jira/*`｜**歷史紀錄 feature key**：`jira`、`jira-comment`

### 功能說明
從 Lark Bitable 讀取規格，批量在 Jira 建立 Issue、批量添加評論、批量轉換狀態。

**PM 模式已移除**：原本的 QA/PM 雙模式切換（`mode` state）與 PM 模式專屬的「從 Lark PM 規格自動建立 Epic + Story」流程（`JiraPmModeTab.tsx`、後端 `/api/jira/pm-read-bitable`、`/api/jira/pm-batch-create`）已整個拿掉，現在只保留 4 大批量工具（開單/評論/更新狀態/修改）。帳號管理（`JiraAccountModal.tsx` 的 `role` 欄位/`accountHasRole()`）保留未動。

**權限位已於 2026-08-31（v4.81.0）收掉**——原本「刻意保留」的 `jira-pm` 連同 `jira-qa`／`jira-update` 一起合併成單一的 `jira`。原因不是為了整潔：那三個 key 在 `canAccess()` 裡是 **OR**、而且都指向同一個頁面，**關掉其中一個沒有任何效果**，等於在管理介面上給了三個假開關。詳見下方「Jira 權限三合一」。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 選擇帳號 | 從全域帳號選單選擇 Jira 操作者身份 |
| 批次開單（Step 1–5） | 讀取 Lark Bitable → 選專案/Issue Type → 預覽清單（含欄位篩選）→ 確認執行 → 進度追蹤（前端逐筆呼叫 `/api/jira/batch-create`，每筆回應後累加進度條；不是 SSE，跟批量評論不同）|
| Step 3 欄位篩選 | 自動偵測下拉式選單欄位（2–15 個唯一值），可按嚴重度/類別/進度等篩選後再勾選列 |
| Step 3 動態欄位開單 | 載入 Jira 專案實際欄位；摘要/描述/受託人/RD負責人/回報人 為強制必填並自動顯示，未填擋下送出；可從 Lark 自動帶入這些欄位值，其餘選填欄位可手動新增（「+新增欄位」加入後，若 Sheet 欄名跟 Jira 欄位名稱相符，帶入的值本來就會自動出現，不用重新點一次帶入）|
| 批次評論 | 對多筆 Issue 批量加入 AI 生成的評論內容 |
| 批次轉換狀態 | 選擇 Issue 清單 + 目標狀態，批量執行 Jira transition；完成後回填處理階段「已切換狀態」|
| 批量評論（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測 Issue Key 列，不需經過開單流程直接批量加評論 |
| 批量修改（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），選擇 Jira 欄位與 Sheet 欄位對應，批量修改摘要/描述/優先級等欄位 |
| 批量更新狀態（獨立 Tab） | 貼入 Lark Sheet 或 Google Sheets URL（可切換），自動偵測含 Jira 單號的列，批量執行 transition |
| 批量修改 — 描述附件 | Step 3 預覽表每列有附件欄：可選 Sheet 圖片欄自動讀取（點「讀取附件」），或 + 手動上傳；送出後圖片以 !filename! wiki markup 嵌入描述，影片以 [^filename] 方式嵌入；有未上傳影片時送出前彈出確認 |
| 重新讀取 Sheet | 批量開單/批量評論/批量修改/批量更新狀態 皆有此按鈕（Step 2 以後、頂部步驟列），操作到一半時可重新拉取最新 Sheet 資料，不切換 step、不清空已勾選/已填寫內容，只同步新增/移除的列 |
| 批量更新狀態 — Sheet 欄位篩選 | Step 2 預覽表格自動偵測 2~15 個唯一值的 Sheet 欄位，可篩選縮小範圍（跟批量修改/批量評論同一套模式）；全選只作用於篩選後可見的列；「重新讀取」保留篩選，換網址重新讀取則清空 |
| 批量更新狀態／批量修改 — Jira 目前狀態篩選 | 跟上面的 Sheet 欄位篩選不同資料來源——這個篩的是即時從 Jira API 抓回的單子狀態，選項從已載入資料動態收集、陸續補齊；還沒抓到狀態的列在篩選啟用時直接排除 |
| 切換工具自動帶入 Sheet 網址 | 批量開單/評論/更新狀態/修改 4 個工具切換時自動帶入「最後使用的 Sheet」網址，不用每次都重貼；切到評論/更新狀態/修改會自動帶入並自動重新讀取一次（每個分頁這次頁面停留期間只自動觸發一次，之後靠手動「讀取」/「重新讀取」按鈕），切到批量開單只帶入網址（Step 1 選專案/類型要先完成，不自動送出讀取請求）|
| 查看成員 / 專案 | 列出帳號可存取的 Jira 成員和專案清單 |

### 開單摘要的單一取值來源 `resolveRowSummary()`（2026-08-19，v4.6.1）

摘要有三個可能來源：AI 生成（`generatedSummaries[rowIndex]`，Step 3「AI 摘要生成」面板產生，那格輸入框的 onChange 也只寫回這個 state）、Step 3 手動填寫（`cellValues[rowIdx].summary`）、Sheet 原始「摘要」欄（`applyLarkPrefill()` 會把它寫進 `cellValues.summary`）。先前這三個來源的 fallback 順序散在四個地方各寫一組，而且不一致——最嚴重的是 `validateDynamicFields()` **只讀 `cellValues`**，完全不知道 AI 生成的值存在另一個 state，造成「畫面上明明看得到 AI 摘要、送出時卻整批被『摘要 為必填』擋下」。

**觸發條件是「Sheet 沒有『摘要』欄（或該列摘要是空的）」**：有摘要欄時 `applyLarkPrefill()` 會把它寫進 `cellValues.summary`，驗證剛好過關、送出時再被 AI 值蓋掉，這條縫就一直被遮著沒被發現。已查證**不是 v3.87.10 拆 `JiraCreateStep3.tsx` 造成的 regression**（拆分前後那段逐字相同），也不是任何一次驗證改版造成的——掃過 `JiraPage.tsx` 最近 60 個 commit 的每一版 `validateDynamicFields()` 本體，從來沒有任何一版提過 `summary`/`generatedSummaries`，所以這條縫從 v3.40.0（AI 摘要上線）就存在。

修法（跟 CodeX 討論定案，選「讓驗證去讀送出時的那套 fallback」而不是「生成時回寫 `cellValues`」——後者有「使用者清掉 AI 結果、`cellValues` 卻殘留舊摘要」的風險）：新增 `resolveRowSummary(rowIdx, record?)`，順序固定 `generatedSummaries → cellValues.summary → Sheet 摘要`，四個呼叫點（`validateDynamicFields()` 的 summary 欄、動態欄位模式送出、傳統模式送出、開單成功後的 Sheet 回填）全部改走這支 helper，之後不會再長出第五套順序。

### 必填防呆一定要用 `isFieldRequired()`，不能用 `field.required`（2026-09-10，v4.133.5～v4.133.6）

Step 3 動態欄位模式的必填驗證（`validateDynamicFields()`，`JiraPage.tsx`）**從 v3.97.0（2026-08-12）到 v4.133.4 之間是失效的**：條件寫成 `field.required && !val`。

`field.required` 是 **Jira createmeta 自己回的旗標**。而「描述／受託人／回報人／RD負責人」這四欄**在 Jira 裡本來就是選填**——它們會顯示紅星、會自動出現在必填區，靠的是前端自己加的 `isForcedRequiredField()`。

所以那段期間是 **畫面標紅星、送出完全不擋**：空著按下去直接開單，描述空白、受託人／回報人沒帶，而**後端 `/api/jira/batch-create` 只擋「摘要空白」一條，也不會拒**。

**⚠️ 這種壞法沒有任何徵兆**——不會報錯、不會少一列、開單還會成功，只是開出來的單缺欄位，而且事後沒人知道要補。

**怎麼跑進來的**：v3.97.0 為了讓「＋新增欄位」加進來的選填欄位不被誤判成必填，把迴圈從 `requiredJiraFields` 擴成 `[...requiredJiraFields, ...activeOptionalJiraFields]`，並加上 `field.required &&`。**那個條件本身是對的**（active optional 確實不該必填），但它連帶把強制必填那四欄一起放行了。改動前（v3.39.0）是 `for (const field of requiredJiraFields)` + `if (!val)`，是有擋的。

修法：條件改成 `isFieldRequired(field)`（= `f.required || isForcedRequiredField(f)`）。因為 `requiredJiraFields` 本來就是 `jiraFields.filter(isFieldRequired)`，`activeOptionalJiraFields` 對它必然為 false，語意精準等於「Jira 必填 or 強制必填」，不會把選填欄位誤擋。

**同時要修「描述」的取值來源，否則新的擋會製造另一個假象**：動態欄位模式的送出路徑本來就有 `cellValues['description'] || Sheet「內容」欄` 這層 fallback，但驗證只讀 `cellValues`——不一起處理的話會出現「送出時明明會用 Sheet 值、驗證卻說必填未填」，**跟 v4.6.1 摘要那條縫完全同型**（見上一節）。已抽成 `resolveRowDescription()`（`cellValues.description → Sheet 內容欄`），驗證與送出共用同一支。

**AI 摘要不受影響**：摘要走 `resolveRowSummary()`，AI 生成（`generatedSummaries`）是**第一優先**來源，Step 3 那格輸入框的 onChange 也是寫回同一個 state。四欄裡沒有任何 AI 產生路徑。**之後若要讓 AI 也寫描述，做法是把它加進 `resolveRowDescription()` 的第一優先，不是把必填擋放寬**——放寬的話「AI 沒產出」跟「AI 產出了」在程式裡會長得一樣，空描述照樣送出去。

**後端補驗已補上（v4.133.6）**：`batch-create` 先前只擋「摘要空白」一條，改 payload 就能送出缺這四欄的單（跟 v4.11.0 批量評論 AI 旗標那次同一類問題：當時也是只有前端把選項藏起來）。

原本擔心的「後端要多一份清單」是靠**把判斷抽到 `shared/jira-required-fields.ts`** 解決的——前端擋送出與後端補驗走**同一份**規則，不是各寫一份。⚠️ 各寫一份的漂移症狀就是「畫面標必填、送出卻放行」，跟這次的 bug 一模一樣，所以不能為了省事複製。

| 決定 | 為什麼 |
|---|---|
| **逐列回錯誤並跳過該列**，不整批 400 | 前端是**逐筆呼叫**的（`rows` 長度固定 1），整批擋下會讓已經合法的列也連帶失敗。做法跟上面摘要那條一致 |
| **`{ accountId: '' }` 算沒填** | 前端對「Sheet 人名對不到帳號」的 user 欄位送出的就是這個。只檢查「key 存在」會把它當成填好了——**先前那些列會開出沒有受託人的單，而且事後查不到** |
| **createmeta 拿得到時只認 meta 裡存在的欄位**，不跟常數清單聯集 | RD負責人**在每個專案可能是不同的 customfield id**（跟週報「QA驗證人員」同一個坑）。聯集的話在別的專案會同時要求 `customfield_10428` 與該專案真正的那個 id，而前者根本不在建立畫面上 → **每一列都被擋、而且擋的理由不存在**。meta 才是這個專案的權威來源，也跟前端算 `requiredJiraFields` 用的是同一份資料 |
| **回報人只在動態欄位模式強制** | 傳統模式（createmeta 讀取失敗時的 fallback）的前端驗證**本來就不查回報人**——Sheet 的「回報人」欄多半是人名、`validId()` 對不到 accountId 就是 undefined。後端硬要求會把那條 fallback 路徑整條擋死。前端送出時多帶 `dynamicFieldMode`，**沒帶（舊的快取前端）一律當成傳統模式**，往保守方向靠 |

⚠️ **`dynamicFieldMode` 是前端說了算，所以「回報人」這一項仍可被改 payload 繞過。**這是刻意的取捨：另一邊是「把 createmeta 失敗時的唯一退路擋死」，那個代價更大。描述／受託人／RD負責人 三項不受這個旗標影響，一律擋。

> 已驗證 34 + 25 項。**兩支都已注入違規確認會變紅**（前者 7 項、後者 5 項）：
> - `npx tsx shared/jira-required-fields.test.ts`（34 項，純函式）——規則本身：Jira 標選填的描述仍算必填｜`{ accountId: '' }` 算沒填｜傳統模式不要求回報人、動態模式要｜**別的專案不會多報一個不存在的欄位**｜meta 裡沒有的欄位不會被要求
> - `node scripts/ui-checks/jira-required-field-guard.mjs`（25 項，接線）——前端沒有自己另寫一份清單｜必填判斷沒有退回 `field.required`｜送出有帶 `dynamicFieldMode`｜**後端真的跑了補驗、而且缺欄位的列會被 `continue` 跳過**（不是記個錯誤然後照樣開單）｜摘要那條原本的防呆還在

> 已驗證 15 項（`scripts/ui-checks/jira-required-field-guard.mjs`，純靜態分析不連服務）：必填判斷用 `isFieldRequired(field)`｜**沒有退回 `field.required`**｜摘要與描述都走共用 resolver｜送出沒有自己另寫一套 fallback｜強制必填清單四欄都還在。**已把舊的壞版本注入回去確認 4 項會轉紅**，不是裝飾用的檢查。

### 「從 Lark 帶入」自動帶入機制與格式轉換（2026-08-12）

`applyLarkPrefill()`（`JiraPage.tsx`）掃的是 Jira 專案**全部**可用欄位（`jiraFields`，不只必填的 5 個），依序試幾組別名去 Sheet 欄名裡找對得上、有值的欄位：`summary` 試 `[Jira 欄位名稱, "摘要", "summary"]`；`description`/`assignee`/`reporter`/`customfield_10428`(RD負責人) 這 4 個有寫死對照（`FORCED_LARK_ALIAS`：分別對到 Sheet 欄「內容」/「受託人」/「回報人」/「RD負責人」）；其餘欄位只試 `[Jira 欄位顯示名稱, 欄位內部 key]`。**這代表「+新增欄位」加進來的選填欄位（環境/難易度/開始日期等）也會被自動掃到**，只要 Sheet 欄名跟 Jira 欄位名稱一致，不用額外設定；且欄位載入完成或「重新讀取 Sheet」後就會自動跑一次，不用手動點「從 Lark 帶入」。

**各型別的格式轉換**（Jira API 對不同欄位型別要求的資料結構不同，Sheet 抓到的都是純文字，需要轉換才能送出，否則開單會失敗）：

- **user/multiuser**：Sheet 值（可能是 accountId 或顯示名稱）比對「查看成員」清單解析成正確的 accountId，比對不到就不帶（這是原本就有的邏輯）
- **select/multiselect**（2026-08-12 修正）：原本直接把 Sheet 文字（例如「簡單」）當成 Jira 內部選項 id 送出去，但 Jira 的 id 是一串代碼（例如「10023」），兩者不相等，一定送出失敗。改成 `resolveSelectOptionId()` 拿 Sheet 值去比對這個欄位在 Jira 裡的 `options[].label`（trim、不分大小寫），找不到再退一步直接比對 `.id` 本身（方便進階使用者直接填 id）；multiselect 支援逗號、頓號、換行分隔多個值。任一值對不到，**這個欄位不會被帶入**（`<select>` 元素本來就放不進去無效值），改寫進 `cellErrors` 讓使用者送出前就看到明確原因（例如「難易度：Sheet 值『簡單』對不到 Jira 選項。可選：容易、普通、困難」），不會靜默漏資料
- **date**（2026-08-12 新增）：原本完全沒轉換，直接把 Sheet 原始值送給 Jira。`normalizeDateValue()` 已用真實 Lark Sheet 資料驗證（真實案例：「本機測試完成時間」欄位，raw value 是數字 `46235`/`46246`，反推對應 `2026-08-01`/`2026-08-12`，跟畫面顯示完全吻合）——**Lark Sheets API 的日期欄位原始值是「序列數字」，不是格式化字串**（Excel/Lotus 慣例，第 0 天 = 1899-12-30，用 `Date.UTC` 換算避免時區偏移），畫面上看到的日期格式是 Lark 前端自己轉換顯示的。也接受已經是 `YYYY-MM-DD`/`YYYY/MM/DD`（含月/日不補零）字串格式的情況；會驗證是真實存在的日曆日期（拒絕 `2026-02-31` 這種會被 `new Date()` 自動 rollover 成 `2026-03-03` 的無效日期，不用 `new Date(rawVal)` 硬吞字串）。純數字只接受整數（沒有真實資料證實 Lark 會用小數表示時分），换算後年份要落在 1900~2447 合理範圍（避免把其他數字欄位誤判成日期序列）。解析失敗同樣不帶入、寫進 `cellErrors`
- **number/datetime**：原本就有正確處理，未變動

`validateDynamicFields()` 送出前會再次檢查所有作用中欄位（必填 + 已加入的選填）的 select/multiselect/date 是否都能正確解析，兩層（帶入當下 + 送出前）都會擋，不會有「帶入時漏檢查、送出時才爆炸」或反過來的縫隙。

### 開單完成回填欄位
批量開單成功後自動回填以下 Lark Sheet 欄位：

| 欄位名稱 | 內容 |
|----------|------|
| Jira issue key | Issue Key（如 CGMN-26）|
| Jira URL | Jira 完整 URL |
| 處理階段 | 開單→`已開單`；評論→`添加評論`；轉換→`已切換狀態` |
| 處理時間 | 操作完成時間 |
| 單子標題貼這 | `CGMN-26`（Jira 超連結）+ 換行 + Issue 摘要 |

### 對帳補回填的 Jira 查詢一定要分頁（2026-09-03，v4.99.0）

`/api/jira/reconcile/preview` 原本只發**一次** `/rest/api/3/search/jql`、帶 `maxResults: 200`。但**那支端點的伺服器端硬上限是 100，多要不會多給**。

實測（DSFT，2026-09-03~09-04）：**實際 231 筆，工具只看到 100，漏掉 131 筆（57%）**，而畫面上寫的是「找到 100 筆配對」。

**⚠️ 這個截斷完全沒有徵兆，因為新端點的回應裡沒有 `total` 欄位**（跟舊的 `/search` 不同），只有 `nextPageToken` + `isLast`。不讀那兩個欄位的話，「拿到 100 筆」跟「總共就 100 筆」在程式裡長得一模一樣。

對這支工具特別嚴重——它的用途就是補回已遺失的單號，**漏掉的列會一直維持空白，而且沒有任何地方會提示**。

修法（跟 CodeX 討論定案）：一路分頁到 `isLast === true`，設 `MAX_PAGES = 20` / `MAX_ISSUES = 2000`。

**⚠️ 上限的用意不是「不要截斷」，是「截斷必須看得見、不能被當成完整結果送出」**（CodeX 原話）。所以：

- 回應多帶 `jiraFetched` / `pageCount` / `reachedLimit` / `limitReason` / `isComplete`，**一路傳到 UI**
- 標題文案從「找到 N 筆配對」改成「配對 N 筆 · 本次從 Jira 讀取 X 筆／Y 頁」——原本那句讀起來像「就這些」
- 不完整時**紅色警告橫幅放在結果上面**（放下面的話使用者已經看完數字、結論也下完了才看到；跟後台對帳那次同一個教訓）
- 不完整時按「補回填」**要先過一次確認對話框**，講明「只會補到其中一部分，剩下的列會維持空白且不會有提示」。拿不完整的集合去 reconcile 會造成「以為修完」的二次事故
- **前端讀不到 `isComplete` 時當成「不確定」，不是當成完整**——預設成 true 等於在舊版 server 上把截斷的結果重新標成完整，比沒做這個功能更糟
- 中途某一頁失敗一律整支失敗，不把「已抓到的幾頁」當結果回去——那又是一份看不出殘缺的資料

> 已用真實 Jira + 真實 Sheet 端到端驗證：修正後 `jiraFetched=231`／`pageCount=3`／`isComplete=true`，配對從 100 → 231 筆。
> **上限路徑也驗過**（暫時把 `MAX_PAGES` 降成 2）：停在 200 筆／2 頁、`isComplete=false`、`limitReason='maxPages'`，驗完已還原。

### 批量評論的處理階段判斷（2026-08-21，v4.18.0）

**批量評論分頁從上線起就沒有讀過「處理階段」**：`extractJiraIssuesFromRecords()`（`JiraPage.tsx`）建 issue 物件時 `stage` 寫死空字串，所以已經標成「添加評論」的列照樣被讀進來、而且**預設全部勾選**——真實案例：DSFT-8134／8135 已於 2026/8/20 17:04 評論過，隔天打開批量評論仍被預設勾選，一按送出就會重複留言。批次開單流程有完整的階段判斷、批量修改也有「已改過預設不勾選」，只有這一頁漏掉。

修法（跟批量修改同一套，不另創行為）：
- `extractJiraIssuesFromRecords()` **只負責誠實讀出 `處理階段`**；這個值代表「要不要預設勾選／要不要標示」由各流程自己解讀，不在共用 extractor 裡下判斷（CodeX review：避免共用函式污染其他流程）
- 批量評論載入後，**處理階段是空白或「已開單」才預設勾選**（`COMMENT_PENDING_STAGES` 白名單），其餘一律不勾並在清單標示「已處理：◯◯」
- **不強制擋掉**——要補留言時手動勾回去就能送

**為什麼用白名單而不是黑名單**：處理階段的值域會持續增加（批量修改自己加了「已修改欄位」），黑名單漏掉一個值＝預設幫使用者重複送出評論，而評論送出去收不回來。白名單漏掉新值最多只是「該勾的沒勾」，使用者自己勾回去即可，方向上安全得多。

**順手修掉的相關 bug**：「重新讀取 Sheet」原本寫成 `new Set([...prev, ...freshKeys].filter(k => freshKeys.has(k)))`——union 之後每個 fresh key 都會通過過濾，等於**每次重新讀取都把所有列重新勾回來**，使用者手動取消勾選的動作全部白做（跟那段程式碼自己的註解「保留已勾選 Issue」直接矛盾）。改成「本來就在清單裡的沿用使用者選擇、這次新出現的列才套白名單」。實作上要注意：判斷「上次有沒有這個 key」的 ref **必須在進 functional update 之前先抓成區域變數**，否則 updater 延後執行時 ref 早就被覆寫，新出現的列會全部被當成舊的。

### 處理階段偵測邏輯
| 處理階段值 | 偵測條件 | 動作 |
|------------|----------|------|
| （Jira Key 空白） | — | 執行開單 |
| 已開單（或空白，有 Key） | Jira Key 有值 + 處理階段 = `已開單` 或空 | 執行添加評論 |
| 添加評論 | Jira Key 有值 + 處理階段 = `添加評論` | 執行轉換狀態 |
| 已切換狀態 / 已完成 | 任何其他值 | 跳過（視為終態）|

### 4 個批量工具的穩定性修復（2026-08-03）

一次性審視 4 個批量工具（批次開單、批量評論、批量修改、批量更新狀態）後修的問題：

- **批量更新狀態：沒選目標狀態不再誤標成功**——`/api/jira/bulk-update` 先前不管有沒有選 `transitionId`（下拉選單有「不切換」選項，值為空字串）都回 `ok:true`，畫面上跟真的切換成功長得一樣，且會誤把「已切換狀態」寫回 Sheet 的處理階段欄。改成回傳 `skipped:true` 明確區分，前端顯示獨立的「⏭️ 跳過」列，Sheet 回填只算真的成功切換的列。
- **批量修改：新增處理階段追蹤**——先前完全沒有任何機制防止同一份 Sheet 被重複執行，重複跑會把附件重複上傳、描述重複疊加 `!filename!`。成功的列現在會回填「處理階段＝已修改欄位」，重新讀取/重新整理 Sheet 時，已處理過的列預設不勾選（可手動勾回去），並在清單上標示「已改過」提示。
- **批量評論：background job 改成持久化到 DB**——`commentJobStore` 先前純記憶體，worker 重啟會直接砍掉正在跑的 job，前端 polling 只會拿到含糊的「job not found」。新增 `jira_comment_jobs` 表，每次進度更新都快照；worker 啟動時把上次還沒跑完的 job 標記成中斷，回傳明確訊息（已完成 X/Y 筆、剩餘 Z 筆），前端沿用既有的 `stopped`/`stoppedReason` 顯示機制（新增 `stoppedKind: 'ai_quota' | 'worker_restart'` 區分文案，不會誤套用 Gemini 專用的錯誤說明）。**沒有自動續傳**——重啟後不會自動重新發送剩下的留言（風險是可能造成同一筆留言重複貼兩次，比使用者自己確認後手動重跑剩下幾筆的風險更高，對留言這種不能撤銷的操作不值得冒險）。
- **批次開單/批次轉換狀態：修正重任務鎖範圍**——`tryStartHeavyTask` 先前是「每一筆」HTTP request 拿放（前端逐筆呼叫），兩次 round-trip 之間鎖是空的，兩個分頁同時跑同一帳號的批次開單理論上會交錯執行、有機會重複開單；批次轉換狀態先前甚至完全沒上鎖。新增批次鎖 session（`POST .../begin` 拿 `batchToken`，逐筆請求都帶著它跳過重新搶鎖，跑完 `POST .../end` 釋放；3 分鐘閒置逾時自動清理，防止分頁關掉/斷線後永久卡住名額）。
- **批量修改：送出前重新確認 Issue 是否還存在/可存取**——比照批量更新狀態既有的 pre-flight re-validation 模式，送出前重新呼叫 `/api/jira/batch-fetch-fields`，過濾掉 Step 2 讀取之後被刪除/搬移/權限變更的 Issue，讓使用者確認要不要略過再繼續。
- **批次開單/批次轉換狀態/批量修改：加上 Jira API 節流**——原本只有批量評論有固定 2 秒間隔，其他三個對 Jira API 完全沒有節流，大批量時容易撞到 rate limit；統一補上 300ms 延遲（批次開單因為是「一筆一個 HTTP request」的架構，节流靠前端逐筆呼叫本身的網路延遲，沒有額外加延遲）。
- **4 個工具的歷史紀錄補上實際變更內容**——先前 `addHistory` 只存 `{issueKey, ok, error}`，事後查歷史紀錄看不出到底改了什麼。批次開單補上摘要文字、批量評論補上留言內容預覽（截斷 300 字，AI 重排版的情況下是使用者原始輸入而非逐字比對）、批量修改補上實際改的欄位/值與附件檔名、批次轉換狀態新增 `addHistory`（先前完全沒有）。

### 批量更新狀態／批量修改 篩選功能補齊（2026-08-12）

批量更新狀態 Step 2 原本完全沒有篩選機制（批量修改/批量評論早就有），使用者反應對照截圖後補上，跟既有模式做法一致：`updateFilterableColumns`/`updateTabColFilters`/`updateColumnUniqueValues`/`updateFilteredRecords`（`JiraPage.tsx`），全選 checkbox 改成只作用於 `updateFilteredRecords`（不是全部 `updateRecords`），避免篩選後按全選誤選到被篩掉的隱藏列；`updateFilteredRecords` 用既有的 `_rowIndex` 比對回原始列，不重新解析 issue key，避免跟既有匯入邏輯產生兩套判斷。「重新讀取」（`handleReloadUpdateSheet`）不清空篩選；回到 Step 1 換網址重新「讀取」（`handleUpdateFetchBitable`）才清空篩選——這個區分刻意保留，使用者拖動作到一半重新整理資料不該把篩選條件洗掉，但換一份新表格篩選條件多半已經不適用。

**Jira 目前狀態篩選是完全獨立的第二層篩選，不是同一組**：預覽表格顯示的「狀態」欄（批量更新狀態）/「狀態 (Jira)」欄（批量修改，`jiraCols = ['summary','assignee','status']` 本來就有）是即時從 Jira API 抓回的資料（`updateJiraData`/`editTabJiraData`），跟上面 Sheet 欄位篩選的資料來源完全不同，混在同一排篩選容易誤導使用者以為 Sheet 欄位篩選也能篩到這欄。新增 `updateJiraStatusFilter`/`editJiraStatusFilter`（單一字串，不是 per-column，因為只有一個狀態欄可篩）獨立一排並標明「Jira 目前狀態篩選」；可選清單（`updateJiraStatusOptions`/`editJiraStatusOptions`）從目前已載入的 Jira 資料動態收集 unique 值，不寫死 workflow 狀態，且用整包 Jira data state 當 `useMemo` dep，資料非同步陸續載入時選項會自動補齊，不用等全部載完才能篩。**篩選啟用時，還沒抓到 Jira 狀態的列直接排除**（不是模糊顯示成「符合」或「不確定」），避免筆數隨著資料陸續到位而跳動、語意不準確。批量修改的「預覽變更」（Step 3）沿用 Step 2 篩選後的 `editTabSelectedKeys`，不需要另外接篩選邏輯。

---
