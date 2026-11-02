# 34. 文書工具（Eric Office 嵌入）

v5.68.0（2026-11-02）。使用者在 Lark 要求「串上之前做的文書工具」、部署在 Spug、要登入才能用，選**同源**（信任程式）。

## 是什麼

Eric Office＝`Desktop/craft-office` 的 13 個 Rust→WASM 純靜態 web build（來源 github.com/storytold/*）：

| 分組 | 工具 |
|---|---|
| 文書 | Word、Excel、PPT、PDF |
| 影像設計 | Photo、Light、Vector、Design、Fig、CAD |
| 影音 | Film、Effect、Sound |

沒有後端，檔案都在瀏覽器本機處理、不經過 Toppath 伺服器。全部約 790MB（`craft-office/live`）。

## 架構（跟 CodeX 2026-11-02 討論定案）

- **同網域、網址綁版本 `/office/v/<版本>/<app>/`**，由 Toppath 的 Express 送靜態檔（`server/routes/office.ts`）。同源所以 cookie 直接通，不另做登入、不用 CORS。
  `/office/<app>/…` 只是入口，302 到目前版本（302 不是 301：版本會隨部署改變）。
  ⚠️ **網址一定要綁版本**（v5.68.1，CodeX 審 5f7c6d0 [P2] 實際重現）：原本每個請求都重讀 CURRENT，舊版 HTML 載入後一切版，它要的 hash JS 在新版目錄裡找不到；
  固定檔名（Film／Effect／Light）則會拿到新版的檔，混版。
- **登入＋權限由這個 router 自己驗**：全站登入檢查（`index.ts`）只擋 `/api`、`/internal`，`/office` 是靜態檔不在範圍內。
  ⚠️ **router 一定要掛在 dist 的 `express.static`／SPA fallback 之前**，否則 SPA fallback 會先把 index.html 回給未登入的人。
  - 未登入：開頁面（`Sec-Fetch-Dest: document|iframe`）→ 302 回 `/`；子資源（JS／WASM）→ 401 JSON。不能把登入頁 HTML 回給 WASM 載入器。
  - 沒有 `office` 權限 → 403。`/api/office/apps` 同樣要登入＋權限。
- **權限 key `office`**：`ALL_PAGE_KEYS`、`PAGE_META`（系統管理頁可依角色開關）。
- **Film／Effect 開新分頁**：它們要 cross-origin isolation（SharedArrayBuffer）。iframe 要拿到 isolation，外層 Toppath 也得帶 COEP，
  會擋掉 Toppath 自己的跨源資源。所以這兩個開在最上層分頁；其餘 11 個嵌 iframe。所有 /office 檔案都帶 COOP／COEP／CORP same-origin
  （跟 craft-office 的 `serve-web.mjs` 一致），iframe 子文件帶 COEP 不影響外層。
  ⚠️ isolation 只在**安全來源**生效：HTTPS 或 localhost。區網 IP 走 http 時 `crossOriginIsolated` 是 false（實測）——Spug 要走 HTTPS。
- **同源不是安全隔離**：Office 的程式碼能碰 Toppath 主站 DOM、能用登入者身分打 API。使用者判定程式可信才選同源；
  要隔離的話改成獨立 origin＋Toppath 發單次票證換 Office session（CodeX 提的方案，沒做）。
- **iframe 最多同時 3 個**（`MAX_OPEN`）：WASM 很吃記憶體。滿了請使用者自己關一個，**不自動踢掉**（會丟未存的內容）；關閉前確認。
- **撤權不會立刻停用已開著的工具**：純前端已載入就會繼續跑。權限擋的是「下次載入」。
- **Effect 的 Service Worker 會繞過登入**（v5.68.1，CodeX 審 5f7c6d0 [P1] 實際重現）：Effect build 自帶 cache-first SW（離線用），
  登出後瀏覽器重開仍由 SW 回 200。處理：
  1. `/office/**/sw.js` 一律回**退役版**（`OFFICE_RETIRE_SW`）：裝上就清 Office 快取、註銷自己、重新載入已開頁面。
     ⚠️ 這支**不驗登入**——瀏覽器更新 SW 是直接打網路，登出狀態回 401 的話舊 SW 永遠換不掉。內容固定、不含資料。
     ⚠️ 比對的是**解碼後**的最後一段，而且在檢查版本存不存在**之前**（v5.68.2，CodeX 複審 38f09fb [P1] 實際重現）：
     原本比原始字串，`%73w.js` 照樣送出原本那支 SW；版本目錄被清掉後，那個 scope 的舊 SW 也要換得掉。
  2. 文書工具頁進來、以及 Toppath 登出時，前端也會註銷 `/office/` 底下的 SW、清快取（`src/officeServiceWorker.ts`）。
  代價：Effect 不能離線用、不能安裝成 App。
- **切到 Toppath 其他頁不會卸載工作區**（v5.68.1，CodeX 審 5f7c6d0 [P1]）：原本條件掛載，點 Dashboard 就把所有 iframe 連同未存內容丟掉。
  改成進過一次就保持掛載（隱藏）；關瀏覽器分頁／重新整理有 beforeunload 確認；登出時若還開著工具會先確認。
  ⚠️ 容器要放在 App.tsx 那個「Game Show 圖片比對／Bonus V2 換掉整個 `<main>`」的三元判斷**外面**（v5.68.2，CodeX 複審 38f09fb [P1]）：
  放在 `<main>` 裡的話切到那兩頁一樣被卸載。隱藏用 inline `display:none`，不用 `hidden` 屬性——`.main-content` 有設 display 會蓋過 `[hidden]`。

## 版本目錄與部署

```
OFFICE_DIST_DIR（預設 <Toppath 目錄>/office-dist，不進 git）
  releases/<版本>/<app>/…     一個版本一個目錄，不覆寫
  CURRENT                     一行字＝目前用哪個版本；寫 CURRENT.tmp 再 mv，一次切換、不用重啟 server
  releases/<版本>/.retired-at 被換下來的時間；清理時換下來未滿 OFFICE_RETAIN_MIN（預設 1440 分鐘）的不刪
```

1. 開發機：`node scripts/office/pack-release.mjs <craft-office/live> [版本名]`
   → `office-release/<版本>.tar.gz`。可壓縮的檔（含 .wasm）旁邊預先產生 `.gz`，伺服器只送現成的，不即時壓。
2. 把 tar.gz 傳到 Spug。
3. Spug：`OFFICE_DIST_DIR=… bash scripts/office/install-release.sh <版本>.tar.gz`
   先解到暫存目錄、驗每個工具都有 index.html、拒絕 symlink，再搬進 `releases/` 並切 CURRENT。
   只留最近 3 版，但**換下來未滿一天的不刪**——已開著的頁面網址綁著舊版本，刪了它的資源就 404。
4. 退版：`bash scripts/office/install-release.sh --rollback <版本>`。

沒部署（沒有 CURRENT 或指到不存在的版本）時頁面顯示「尚未部署」，`/office/*` 回 503。

⚠️ **build 完一定要重啟 toppath-server**（1102 本機實際遇到）：前端是新版、後端還是舊程式時，`/api/office/apps` 會落到 SPA fallback 回首頁 HTML（HTTP 200），
畫面顯示「伺服器還沒更新到有文書工具的版本」。畫面只列這個版本裡**實際有 index.html** 的工具。

⚠️ build 的路徑都是 `./xxx` 相對路徑，所以掛在子路徑下可以直接用；少結尾斜線會 302 補上，否則相對路徑會解析到上一層。

## 驗證

- 單元：`npx tsx server/office-files.test.ts`（36 條：CURRENT 指標、版本名、入口導向、sw.js、逐段解碼後的路徑檢查、`%2F`／`%5C`／`%2e%2e` 穿越、只列有部署的工具）。
- 真 server（DB 副本、build 後的 server 起在 3999、版本放 word＋film，另一版只放 film）：
  `node scripts/ui-checks/office-live-check.mjs <url> <DB 副本> <OFFICE_DIST_DIR>`，給了 OFFICE_DIST_DIR 會暫時切版驗「舊版本網址照常可用」再切回來。
  ⚠️ 第二個版本**不能跟第一版有同一個 word**：同一份 build 的 hash 檔名一樣，「忽略網址版本、一律用 CURRENT」的突變照樣 200，驗不出混版。
  ⚠️ 拿不到目前版本時腳本不會進切版那段——曾經把 CURRENT 寫成 `null`，之後每一輪都跟著壞。
  ⚠️ 路徑穿越不能用 `fetch` 測：WHATWG URL 會先把 `%2e%2e` 正規化，送出去的根本不是那條路徑（曾經因此看到假的 200）。腳本改用 `http.get` 送原始路徑。
- 注入（v5.68.2）：拿掉權限檢查 → 紅 3；router 掛到 SPA fallback 後面 → 紅 33；拿掉 `..` 與前綴檢查 → 紅 3；
  sw.js 也要登入 → 紅 5；忽略網址版本、一律用 CURRENT → 紅 3（含「切版後舊版 WASM 404」）；sw.js 比對解碼前的字串 → 紅 1（`%73w.js`）。
- 瀏覽器（區網 IP）：側欄進文書工具 → 開 Word，iframe 內 WordCraft 正常跑起來（src 是 `/office/v/<版本>/word/`）；
  切到 Dashboard、Game Show 圖片比對、Bonus V2 再回來，iframe 都是同一個（window 上的標記還在）；Film 開新分頁；localhost 下 Film／Effect `crossOriginIsolated=true`；
  Effect 載入後沒有殘留 SW 與快取，登出後重開導回首頁；普通版／修仙版、390px 手機寬無橫向捲動。

## 操作清單

- 側欄「文書工具」（修仙版「文房四寶」）→ 點工具開啟；開過的留在下方分頁列，切換不會遺失未存內容。
- 同時最多 3 個；要再開先關一個（× 會先確認）。切到 Toppath 其他頁不會關掉；關瀏覽器分頁、重新整理、登出前會確認。
- Film／Effect 標「新分頁」，點了開在瀏覽器新分頁。
- 管理員在「系統管理 → 角色管理」勾「文書工具（Eric Office）」開給角色。
