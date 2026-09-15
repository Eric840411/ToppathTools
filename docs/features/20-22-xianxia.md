# 境界稱號／版面模式／每日仙語

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 20. 帳號境界稱號（design/xianxia 分支）

### 功能說明
側邊欄帳號區塊顯示一個小稱號徽章，依帳號**累計登入天數**自動晉升，靈感取自《凡人修仙傳》的修煉境界（練氣期→築基期→金丹期→元嬰期→化神期→煉虛期→合體期→大乘期→渡劫期，共 9 階，門檻單位為天，可調整）。純展示用途，不影響任何權限判斷。

**計數來源**：`server/shared.ts` 的 `recordLoginDay()` 對 `account_cultivation` 表做 upsert，同一天內重複呼叫只算一天，累計的是「有活躍過的不同日曆天數」，不是登入次數或操作次數（`operation_history` 本身每 7 天會被自動清空，不適合拿來算長期累計）。**掛在 `server/index.ts` 的全站共用 middleware**（`getAuthAccount(req)` 判斷有登入就呼叫），不是只掛在 `/api/auth/login`——原本只掛登入端點時，登入 session cookie 有效期 7 天，這期間內重新整理/重開瀏覽器都不會再打登入 API（cookie 還有效不需要重新輸入帳密），導致「有在用但沒重新登入」的天數完全沒被算到；改成任何一支已登入的 API 請求（含 heartbeat）都算，才是「今天真的有在用」的正確訊號。`GET /api/account/cultivation` 回傳目前境界、累計登入天數、下一階名稱與門檻。

**排行榜（群英榜）**：獨立頁面（`GroupId`/`page key` = `cultivation-board`，側邊欄「宗門維運」分區），`GET /api/account/cultivation/leaderboard` 回傳所有未停用帳號依累計登入天數排序的清單（不含 token），目前登入的帳號那一列會高亮（`.cultivation-row--me`）。跟其他「系統」分區頁面一樣走 `ALL_PAGE_KEYS`/`SystemAdminPage` 權限表控管可見性。

**管理員手動調整境界**（`server/routes/permissions.ts`）：`SystemAdminPage.tsx` 帳號列表每列新增「調整境界」按鈕，開啟小視窗可直接輸入累計登入天數，或用下拉選單快速帶入某境界對應的門檻天數。實作上直接改 `account_cultivation.active_days`（`setCultivationDays()`），不是額外的覆寫欄位——調整後帳號正常登入仍會從這個新天數繼續往上累計，跟自動累計共用同一個計數器。`PUT /api/admin/accounts/:email/cultivation`（`requireAdmin` 保護）、`GET .../cultivation` 讀目前境界、`GET /api/admin/cultivation-levels` 給前端下拉選單用的境界門檻清單。

**修為 / 每日功課 / 副稱號（2026-08-30，v4.79.0，跟 CodeX 討論定案）**

境界維持「只看累計登入天數」不變，另外疊一層「修為」＝累計操作次數。**兩套刻意分開**：境界＝資歷，修為＝最近有沒有在做事。第一版不把兩者合併成同一個升級公式——境界現在等於資歷，突然改成看工作量會讓既有排名跳動，而且「管理員可手動調天數」那個功能會變得語意矛盾。

`account_cultivation.total_actions` 這個欄位**存在很久但從來沒被寫入過**（全部帳號都是 0，程式裡零處寫入），這版才接上。

**累加點是 `addHistory()`（`server/shared.ts`），不是全站 middleware**：

| 位置 | 為什麼不用／用 |
|------|--------------|
| `index.ts` 的全站 middleware（`recordLoginDay` 那裡）| ❌ 每支已登入 API 都會過，含 Dashboard 每 30 秒輪詢與 heartbeat。光開著網頁不做事一天就 ~2880 次，修為會變成「開著網頁的時間」 |
| `addHistory()` | ✅ 40 個呼叫點全是真實操作，定義剛好是「有留下操作歷史才算一次修為」，而且 40 個呼叫端都不用動 |

**⚠️ 修為記在 cookie 認證的帳號上，不是 `addHistory` 的 `operatorKey`**：後者來自 `ctx.user`，吃得到 header（例如 `x-jira-email`），等於可以把修為記到別人頭上——跟 v4.10.0 收緊 Jira 身分邊界是同一類問題。`RequestContext` 新增 `authEmail`（只來自 cookie），`recordCultivationAction()` 用它。背景工作（cron／agent 回報）沒有登入身分，`authEmail` 是 undefined，自然不計入，這正是想要的。

**今日次數存在 `account_cultivation.today_actions`／`today_date`，不從 `operation_history` 回算**：那張表的 `operator_key` 來源跟修為不一致，而且它 7 天會被自動清空。跨日用 SQL `CASE` 在同一次 upsert 裡判斷歸零，不先查再寫（避免兩次呼叫之間跨日）。

門檻：功課 3／5／10 次＝吐納／小周天／大周天；副稱號 0／50／200 次＝閉關中／勤修／破境在即。都刻意訂得低——這是「今天有在修行」的鼓勵，不是 KPI。

> 已驗證 8 項（`scripts/ui-checks/cultivation-action-check.mjs`，用真實 request context 呼叫 `addHistory`，不碰外部服務）：有登入身分會累加｜背景工作不累加｜**header 冒用他人 email 拿不到修為**｜今日次數正確｜功課階段與副稱號計算正確。測試資料已清除。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看目前境界 | 側邊欄帳號名稱下方的小徽章，滑鼠移上去顯示累計登入天數與距離下一階還差幾天 |
| 查看副稱號 | 境界徽章旁，依累計修為顯示閉關中／勤修／破境在即，滑鼠移上去顯示累計修為數 |
| 查看今日功課 | 副稱號下方一條細進度，顯示今天做了幾件事、還差幾件到下一階段（吐納／小周天／大周天）|
| 查看群英榜排行 | 獨立頁面，列出所有帳號依境界/登入天數排名，自己的那一列會高亮 |
| 管理員調整境界 | 系統管理頁帳號列表「調整境界」按鈕，可直接輸入天數或用下拉選單快速帶入境界門檻 |

---

## 21. 普通版／修仙版切換（design/xianxia 分支）

### 功能說明
側邊欄底部「版面模式」開關，可在「普通版」（原本 main 分支的樣子）與「修仙版」（太玄道樞整套視覺）之間即時切換，選擇存在 `localStorage`（`toppath-theme-mode`），下次開啟沿用。

**實作方式**：`xianxia-complete.css`（全站修仙視覺層）不再用 `import` 靜態打包進主 CSS（那樣永遠會生效、無法整份關掉），改放在 `public/xianxia-complete.css`，由 `App.tsx` 在切到「修仙版」時動態插入 `<link rel="stylesheet">`，切回「普通版」時整個移除。

**普通版下會整個隱藏的修仙限定內容**：側邊欄雙標籤（只顯示原功能名一行）、境界稱號徽章、群英榜排行榜（連帶側邊欄的入口按鈕）、每日仙語小卡片與其管理頁（連帶側邊欄的入口按鈕）、背景境界（玄月／赤霄）切換、側邊欄品牌名稱（改回「Toppath Tools」）。這些判斷都以 `themeMode === 'xianxia'` 為準，不是靠 CSS 藏起來（CSS 沒載入時這些元素本來就不會被畫出正確樣子，所以直接不渲染）。

**已知限制**：目前只做了「全站共用外殼」（側邊欄、頂欄、境界稱號/排行榜）的切換；個別頁面內部如果有更深層的修仙化改動（例如 Dashboard 的 Hero 橫幅結構），普通版下 xianxia CSS 關閉後會變成無樣式的原始 HTML 排版，不是逐一還原成「main 分支當初那個版本」的樣子——真的要每個頁面都精準復原，工作量接近整個重做一次，目前先以「視覺上乾淨、可用」為標準，非逐頁像素級還原。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 切換版面模式 | 側邊欄底部「版面模式」按鈕組，選普通版或修仙版，選擇會記住 |

---

## 22. 每日仙語（design/xianxia 分支）

**路由**：`GET /api/xianxia/quote-of-day`、`GET/POST /api/xianxia/quotes`、`PUT/DELETE /api/xianxia/quotes/:id`、`POST /api/xianxia/quotes/ai-suggest`

### 功能說明
Dashboard（修仙版）Hero 橫幅下方顯示一張每日語錄小卡片，語錄來源為《凡人修仙傳》《仙逆》《斗破蒼穹》《誅仙》等知名國漫/仙俠小說的經典台詞。只在修仙版顯示，普通版整個隱藏（含側邊欄管理頁入口）。

**語錄庫存在 `xianxia_quotes` 表**（`id`/`text`/`source`/`created_at`/`last_used_cycle`），初始批次語錄透過 `server/xianxia-quotes-seed.json`（`INSERT OR IGNORE`，不覆蓋已編輯過的資料）在啟動時補齊，比對 `config-templates.json`/`machine-profiles.json` 既有的種子檔案載入慣例——**這批初始語錄是先用 WebSearch 查證多個獨立語錄整理網站交叉確認過的，不是純憑印象生成**，但仍建議使用者自己覆核一輪，用字/斷句可能因原著版本或轉載差異而有出入。

**每日抽選演算法（不重複循環制）**：`getDailyQuote()`（`server/routes/xianxia-quotes.ts`）——同一天內（Asia/Taipei 時區）所有人看到的都是同一則（存在 `settings` 表 `xianxia_daily_quote`，含 `date`/`quoteId`/`cycle`），隔天才會重新抽。抽選規則是「這一輪（`cycle`）還沒抽過的語錄裡隨機挑一則」，該則的 `last_used_cycle` 更新為目前 `cycle`；當整輪語錄都抽完（沒有 `last_used_cycle < cycle` 的候選）才會把 `cycle` +1、重新開始新一輪。語錄庫可以隨時新增，新加入的語錄 `last_used_cycle` 預設 0，會立刻被目前這輪視為「還沒抽過」，不用等下一輪才會出現。

**AI 建議只回傳草稿，不會自動寫入語錄庫**：`POST /api/xianxia/quotes/ai-suggest` 呼叫 `callGeminiWithRotation()` 請 Gemini 列出候選語錄，prompt 明確要求「不確定就不要列，寧可少列也不要列錯」，但 AI 仍可能編造不存在的句子或講錯出處，管理頁上每則候選都要人工按「加入語錄庫」才會真的存入（等同於再過一次 `POST /api/xianxia/quotes`），不會自動信任 AI 產出。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查看每日語錄 | Dashboard（修仙版）Hero 橫幅下方自動顯示，每天固定一則 |
| 管理語錄庫 | 「每日仙語管理」頁（系統分區）手動新增/編輯/刪除語錄，可查看每則目前用到第幾輪 |
| AI 建議候選語錄 | 管理頁「AI 建議」按鈕，Gemini 生成候選草稿，需人工確認出處後才按「加入語錄庫」存入 |

---
