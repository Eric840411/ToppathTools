## 30. 角色管理（v5.9.0）

> 使用者 2026-10-05：要能自己建角色、依角色分配可見功能。版面 CodeX 設計（文字線框）、使用者看樣稿 `mockup-role-management.html` 確認。
> 位置：系統管理 →「角色管理」分頁（原本的「功能權限」矩陣併進來）。只限管理員。

### 使用者可以做的事
| 操作 | 說明 |
|---|---|
| 看角色 | 左邊清單：顏色、名稱、幾個人在用、固定／內建／自訂標籤；可搜尋 |
| 新增角色 | 「＋ 新增」→ 名稱（1～20 字，不能跟其他角色或「管理員」同名）、顏色、勾可見功能 →「建立角色」 |
| 改角色 | 自建角色可改名、改色、改可見功能；內建（QA／PM／Other）這一版只能改色與可見功能；管理員唯讀 |
| 刪除角色 | 只有自建角色能刪。**還有帳號在用 → 擋下，列出是哪些帳號**，附「前往帳號管理」 |
| 指派角色 | 帳號管理 → 編輯 → 角色下拉（單選，一個帳號一個角色） |
| 識別碼帳號 | 新增帳號時勾「識別碼帳號（不是 Email）」才能用任意識別碼（原本是「角色＝Other 就不用 Email」） |

### 規則（CodeX 確認）
- **管理員固定**：不在角色表、永遠全開、不能改不能刪、不能用一般指派產生（避免把自己鎖在系統外）
- **key 不變、改名只改 label**：帳號與 `role_permissions` 都靠 key 對應。自建角色的 key 是產生的 `r_xxxx`
- **`builtin` 只是「這版鎖住」**，不是永久不可刪（使用者要求資料結構先想到之後開放）
- **刪除**：檢查使用中與刪除在同一個 transaction；刪掉時一併清掉它的權限列
- **一個帳號一個角色**。舊資料的逗號多角色（`pm,qa`）**權限照舊取聯集**，帳號管理會標出來、編輯時不預選，請管理員自己選一個（使用者同意：不自動選，避免默默少權限）
- **個人覆寫另外標**：帳號表的「＋覆寫 N」＝帳號在「功能權限」單獨加減的，避免以為角色勾的就是最終權限
- 指派的角色必須存在於角色表（後端驗）；未知角色一律沒有權限（`getPermissionsForRole`）
- 自助註冊（登入畫面）仍只能選 QA／PM，不開放自建角色
- 舊的 `/api/admin/permissions` 矩陣 API 留著相容，角色清單改照角色表；PUT 沒送的角色不動（原本會整排清成關）

### 一併修的安全問題
- `DELETE /api/accounts/:email`、`PATCH /api/accounts/:email/role` 原本**只看 `ADMIN_PIN` 環境變數——沒設的話任何人都能刪帳號、改角色**。改成一律要管理員登入（PIN 有設照樣要對）；PATCH 也改成只收單一、存在的角色

### v5.9.1（CodeX review）
- **管理員帳號不能刪、不能改角色、不能停用**：原本只驗呼叫者是不是管理員、沒保護目標，舊 DELETE／PATCH、管理頁 PUT／DELETE 都能把唯一的管理員弄掉 → 一律回 400。規則是 `adminTargetError`（舊多角色裡含 admin 也算）
- **自助註冊被管理員覆蓋**的情況不同：目標是管理員時**角色保持 admin、其他欄位照寫、回成功**（不是 400）
- **刪角色／改帳號不會互相穿插**：刪除在 immediate transaction 裡讀帳號（原本檢查的是傳進來的快照）。改帳號一律走 `updateAccountGuarded(db, email, patch)`／刪帳號走 `deleteAccountGuarded`：讀現況、保護、角色存在檢查、合併、寫入都在同一個 immediate transaction，**呼叫端拿不到也傳不進「先前讀到的帳號」**——v5.9.1 第一版只把「有帶 role」的包起來，只改名的請求仍把開頭讀到的舊角色整筆寫回（CodeX 重現：中間有人改派並刪掉角色 → 200 成功、帳號角色不存在）。server／worker 共用 data.db，immediate 讓兩邊只能一前一後
- 新增帳號走 `withAssignableRole`（存在檢查跟寫入同一個 transaction）
- 突變驗過：改回讀快照、管理員只認完全等於 admin、指派不檢查存在，各自有對應的測試變紅

### 檔案
| 檔案 | 內容 |
|---|---|
| `server/role-store.ts` | 角色表、新增／修改／刪除、使用中帳號、權限讀寫（純函式，傳入 db） |
| `server/routes/permissions.ts` | `/api/admin/roles`（GET／POST／PUT／DELETE）、帳號指派驗證、帳號清單的 multiRole／overrideCount |
| `src/components/RoleManager.tsx` | 角色管理畫面、角色標籤 |
| `src/pages/SystemAdminPage.tsx` | 分頁、帳號管理的角色下拉／標籤／多角色提示 |

### 測試
- `npx tsx server/role-store.test.ts`（21，記憶體 DB）
- `node scripts/ui-checks/role-manager-walkthrough.mjs`（兩種主題，真伺服器；只動測試帳號 asd 與走查角色，結束還原）
- 真伺服器 API：非管理員 403、指派不存在／admin 被擋、內建改名被擋、使用中刪除 409、舊 PATCH／DELETE 沒登入 403
