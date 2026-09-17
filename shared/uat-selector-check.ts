/**
 * 錄製當下的 selector 驗證結果 → 給人看的一句話。
 *
 * 產生 status 的是 `server/uat-runner/recorded-selector.js`（那一支要原封不動送到
 * agent，所以不能 import TS）。措辭放這裡讓前端與 server 共用一份，不要各寫各的——
 * 「前後端各寫一份規則一定會漂移」在這個專案已經踩過好幾次。
 *
 * ⚠️ `unknown` 刻意不在這張表裡。它代表「畫面已經換掉、元素已經消失，無法確認」，
 *    不是失敗。把它標成問題會讓使用者去修根本沒壞的步驟。
 *    `scripts/ui-checks/recorded-selector.mjs` 會驗這張表跟產生端的 status 沒有漂掉。
 */
export const SELECTOR_CHECK_LABEL: Record<string, string> = {
  none: '錄製當下就找不到這個元素（選擇器壞了，重播一定失敗）',
  many: '這個選擇器一次命中多個元素，重播時會被「定位必須唯一」擋下來',
  mismatch: '命中的不是你剛才點的那一個元素，重播會點到別的東西',
  invalid: '選擇器語法錯誤',
}
