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

- **同網域 `/office/<app>/`**，由 Toppath 的 Express 送靜態檔（`server/routes/office.ts`）。同源所以 cookie 直接通，不另做登入、不用 CORS。
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
- **撤權不會立刻停用已開著的工具**：純前端已載入就會繼續跑；Effect 還註冊了 Service Worker（scope 在 `/office/effect/` 內）。
  權限擋的是「下次載入」。

## 版本目錄與部署

```
OFFICE_DIST_DIR（預設 <Toppath 目錄>/office-dist，不進 git）
  releases/<版本>/<app>/…     一個版本一個目錄，不覆寫
  CURRENT                     一行字＝目前用哪個版本；寫 CURRENT.tmp 再 mv，一次切換、不用重啟 server
```

1. 開發機：`node scripts/office/pack-release.mjs <craft-office/live> [版本名]`
   → `office-release/<版本>.tar.gz`。可壓縮的檔（含 .wasm）旁邊預先產生 `.gz`，伺服器只送現成的，不即時壓。
2. 把 tar.gz 傳到 Spug。
3. Spug：`OFFICE_DIST_DIR=… bash scripts/office/install-release.sh <版本>.tar.gz`
   先解到暫存目錄、驗每個工具都有 index.html、拒絕 symlink，再搬進 `releases/` 並切 CURRENT；只留最近 3 版。
4. 退版：`bash scripts/office/install-release.sh --rollback <版本>`。

沒部署（沒有 CURRENT 或指到不存在的版本）時頁面顯示「尚未部署」，`/office/*` 回 503。畫面只列這個版本裡**實際有 index.html** 的工具。

⚠️ 舊 build 的路徑都是 `./xxx` 相對路徑，所以掛在子路徑下可以直接用；`/office/word` 少結尾斜線會 301 補上，否則相對路徑會解析到 `/office/xxx`。

## 驗證

- 單元：`npx tsx server/office-files.test.ts`（23 條：CURRENT 指標、逐段解碼後的路徑檢查、`%2F`／`%5C`／`%2e%2e` 穿越、只列有部署的工具）。
- 真 server（DB 副本、build 後的 server 起在 3999、版本只放 word＋film）：`node scripts/ui-checks/office-live-check.mjs <url> <DB 副本>`，33 條。
  ⚠️ 路徑穿越不能用 `fetch` 測：WHATWG URL 會先把 `%2e%2e` 正規化，送出去的根本不是那條路徑（曾經因此看到假的 200）。腳本改用 `http.get` 送原始路徑。
- 注入：拿掉權限檢查 → 紅 3 條；router 掛到 SPA fallback 後面 → 紅 6 條；拿掉 `..` 與前綴檢查 → 紅 1 條（另有單元測試覆蓋）。
- 瀏覽器（區網 IP）：側欄進文書工具 → 開 Word，iframe 內 WordCraft 正常跑起來；Film 開新分頁；localhost 下 Film `crossOriginIsolated=true`；
  普通版／修仙版、390px 手機寬無橫向捲動。

## 操作清單

- 側欄「文書工具」（修仙版「文房四寶」）→ 點工具開啟；開過的留在下方分頁列，切換不會遺失未存內容。
- 同時最多 3 個；要再開先關一個（× 會先確認）。
- Film／Effect 標「新分頁」，點了開在瀏覽器新分頁。
- 管理員在「系統管理 → 角色管理」勾「文書工具（Eric Office）」開給角色。
