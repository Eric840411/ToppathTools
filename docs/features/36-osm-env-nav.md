# 36. OSM 環境導航（v5.93.0，第一階段預覽；v5.94.0 銀月功德共用計數）

OSM Tools → **OSM 環境導航**（OSM 版號同步下方）。取代 Lark「主頁」分頁
（`sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=6uaMtK`）：QAT／UAT／Prod 各渠道的主站、OSM 後台、渠道後台、
政府（FPMS）後台，加上帳號、工具捷徑。版面由使用者在 Lark 話題逐項定稿（2026-11-20），Eric 定位置。

## 畫面

- **渠道入口**：QAT／UAT／Prod 分頁（記在 localStorage `envnav-tab`）。表頭上方一列「XX 共用入口」＝ Lark 每個環境標題列上的連結
  （超級後台／渠道後台／FPSM 後台）；QAT 的 AG 另有專用超級後台／渠道後台，顯示在 AG 名稱下方。
  StudioId／Toppath 渠道號／OSM 渠道號三欄置中。有登入資訊的網址前面有橘點，滑鼠移上去看帳密與註解。
- **帳號**：正式帳號（號碼｜帳號｜備註）、測試帳號（號碼｜備註；玩家名稱字數併進備註）。
- **工具捷徑**（右欄 420px）：按住 ⠿ 拖動排序；編輯模式下「編輯／＋新增」走右側抽屜（名稱、網址、放第幾個、刪除）。
- **銀月功德**（v5.94.0 改版）：右欄最下方、UP 左邊，去背。左＝敲木魚（狐形／人形同位置、木魚不動），右＝本週功德、化形進度、重置時間。
  - **全員共用**：所有人敲的都算進同一個本週計數（存 DB），每 15 秒同步別人敲的；每週一 00:00（台北時間）歸零。
  - **滿 30 才變人形**：本週合計未滿 30 是狐形，滿 30 當下播變身動畫，之後整週都是人形；換週歸零回狐形。**不能手動切換**（型態切換鈕、點角色變身都拿掉了）。
  - 素材來自 `.scratch-merit/merit-fox.html`，嵌入時另外注入 CSS（暫存在產生腳本，見下）；改完用 `.scratch-merit/apply_v2.py embed` 重新嵌進私有頁面。
- 普通版／仙俠版跟著工具切換（iframe 帶 `?theme=`）。

## 架構（第一階段）

- `src/pages/OsmEnvNavPage.tsx`：只放 iframe → `/osm-env-nav/page?embed=1&theme=…`。
- `server/routes/osm-env-nav.ts`：照 `office.ts`，**掛在 static／SPA fallback 之前**，自己驗登入＋`osm-env-nav` 權限；
  `Cache-Control: no-store`；iframe 內未登入只回文字（避免登入頁套在內框）。
- HTML 放**專案目錄外**的 `~/.toppath-private/osm-env-nav.html`（可用 `OSM_ENV_NAV_HTML` 改路徑）。v5.93.1 前放在專案內 `private-data/`，CodeX 實測 Vite dev server 不經登入就能直接拿到原始 HTML，所以搬出去，兩份 Vite 設定也另外擋 `private-data`／`.toppath-private` 路徑並代理 `/osm-env-nav`。檔案裡有 Lark 上的真實帳密與 token，
  **不進 git、不打包前端**；部署到別台要手動放檔，沒放會回 404 文字。
- 頁內編輯只在記憶體，重新整理就還原（畫面上方有提示）；帳密不寫 localStorage（CodeX 要求）。

### CodeX（2026-11-20）提醒的風險

- 有 `osm-env-nav` 權限的人就拿得到整份明文（含 Prod 憑證），遮罩不是保護 → 權限只開給該看的人。
- 同源 iframe 不是安全隔離；第二階段寫入時，使用者輸入不要直接進 innerHTML、網址只允許 http/https。
- 驗收要補：直接開 router、登出／換帳號、撤權、開發與正式模式都沒有旁路。

## 銀月功德 API（v5.94.0）

- 表：`osm_env_nav_merit(week_start PK, count)`、`osm_env_nav_merit_batch(batch_id PK, week_start, n, created_at)`（去重用，兩週後清掉）。
- `GET /api/osm-env-nav/merit` → `{ weekStart, count, evoAt: 30 }`；`POST /api/osm-env-nav/merit/hit` `{ batchId, n(1～20), weekStart? }` → 同樣格式。兩支都驗登入＋`osm-env-nav` 權限。
- CodeX（2026-11-26）確認的做法，改的時候不要拿掉：
  - 累加是原子 UPSERT，去重與累加在同一個 transaction（多人同敲不漏算、回應遺失重送不重複算）。
  - 批次屬於哪一週由前端帶（敲的當下那一週），只收本週與上一週；跨週重送不會算進新週。
  - **型態只看伺服器確認值**，不看前端樂觀數字（第 30 下沒寫成功不能先變身再退回）；第一次載入已滿 30 不播動畫。
  - 前端固定每 400ms 送一批（不是 debounce）、失敗的批次原封不動重送；有批次在路上時不收輪詢結果；同週較小的 count、較舊的 weekStart 不收。
  - v5.94.1：敲的當下屬於哪一週用伺服器時間校準（`serverNow`／`nextResetAt`），不是沿用上次同步到的那一週；離開頁面時用 keepalive 把還沒送的送掉。待送批次**沒有**存 localStorage，keepalive 也不保證送達——被限流退避中重新整理、斷網、瀏覽器被強制關閉，都可能掉最後幾下（CodeX 2026-11-26 同意：小互動可接受少量漏算）。**跨週歸屬那段沒有自動測試**，只過了原本 23 項冒煙。
  - 每帳號每分鐘最多 300 下，超過回 429（前端會退避重送）。不寫 `insertHistory`（太吵）。
- 冒煙：`node scripts/ui-checks/osm-env-nav-merit-smoke.mjs`（打本機真 server，跑完還原計數）。
- **部署**：除了程式，還要把新版 `~/.toppath-private/osm-env-nav.html` 手動放到那台（頁面不進 git）；只更新程式不換頁面的話，畫面仍是舊的各算各的版本。

## 第二階段（待做，動手前先問 CodeX）

新表＋帳密加密存放、寫入 API（樂觀鎖）、修改紀錄與歷史紀錄（`insertHistory`）、Lark 一次匯入（儲存格備註讀不到：sheets API 不含備註、export 缺 `drive:export:readonly` scope）。

## 產生／更新 HTML

目前由模擬稿流程產生（暫存目錄 `%TEMP%/tp-sheet`：`grid.json` → `gen.cjs` → `sheet-data.json`，`main.html`＋`extra.css`＋`app.js`＋`merit-inject.*` → `splice.py`），
產出 `mockup-osm-env-nav.html` 後複製到 `~/.toppath-private/osm-env-nav.html`。第二階段改成資料進 DB 後，這段流程就退場。

## 使用者可執行的操作

1. 側欄 OSM Tools → OSM 環境導航（需 `osm-env-nav` 權限，系統管理 → 權限頁開通）
2. 切 QAT／UAT／Prod 分頁；點共用入口或各欄網址開新分頁
3. 滑鼠移到有橘點的網址看帳密與註解
4. 切換正式／測試帳號
5. 拖動工具捷徑排序；開編輯模式後用抽屜新增／編輯／刪除（預覽版不會存）
6. 敲木魚積功德（全員共用，本週滿 30 銀月變人形）

- 切普通版／仙俠版**不重載** iframe（重載會清掉頁內還沒存的編輯）：src 固定用第一次的主題，之後直接改同源內框的 `data-theme-mode`。
