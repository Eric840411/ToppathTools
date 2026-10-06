/**
 * 後台站台層級的「機台異常」警告彈窗（登入後一直開著：標題 Warnning（原文拼錯）／Warning、
 * 內文「Currently N machines are abnormal」）。它的 .v-modal 遮罩會擋住後續點擊。
 *
 * **所有呼叫點共用這一支**（CodeX 2026-10-06 定案）——原本各處自己寫：
 *   - `dismissWarningDialog` 用 /Warnning|Warning/i 比對整個 wrapper 文字 → **真的 Warning 確認框也會被藏掉**
 *   - 幾個 verifier 內嵌一段「藏掉 Warnning、然後無條件藏掉第一個 .v-modal」→ 別的對話框還開著時連它的遮罩一起拿掉
 *   - 後台設定片段（backend-ops.js）的 openPath 完全沒處理 → 片段第一下點擊被遮罩擋到逾時（claude-osm-2 回報）
 *
 * 辨識規則：**標題是 Warnning／Warning，而且內文有「machines are abnormal」**，兩個都要。只處理這種窗；
 * 其他確認框（例如標題同樣是 Warning 的刪除確認）與它們的遮罩一律保留。
 * 遮罩只有在「藏完之後畫面上已經沒有其他開著的對話框」才拿掉——Element UI 的 .v-modal 是共用的，
 * 別的對話框還開著時拿掉會讓它失去遮罩、被誤點到後面的東西。
 */

/** 在頁面裡標記站台警告彈窗（data-uat-site-warning="1"），回傳標了幾個。判斷規則只寫在這裡 */
export async function markSiteWarnings(page) {
  return page.evaluate(() => {
    let n = 0;
    document.querySelectorAll('.el-dialog__wrapper').forEach(w => {
      const title = (w.querySelector('.el-dialog__title')?.textContent || '').trim();
      const body = (w.querySelector('.el-dialog__body')?.textContent || w.textContent || '');
      if (/^warn+ing$/i.test(title) && /machines are abnormal/i.test(body)) { w.setAttribute('data-uat-site-warning', '1'); n++; }
    });
    return n;
  });
}

/**
 * 關掉站台警告彈窗（JS 隱藏，不按 Cancel——按了會觸發 Vue Router 導頁）。
 * waitMs > 0：先等它出現（剛導頁時彈窗還沒畫出來）；0＝只處理已經開著的。回傳有沒有藏到東西
 */
export async function dismissSiteWarning(page, waitMs = 3000) {
  if (waitMs > 0) {
    await page.locator('.el-dialog__wrapper').filter({ hasText: /machines are abnormal/i })
      .first().waitFor({ state: 'visible', timeout: waitMs }).catch(() => {});
  }
  if (!(await markSiteWarnings(page))) return false;
  const hidden = await page.evaluate(() => {
    let found = false;
    document.querySelectorAll('[data-uat-site-warning="1"]').forEach(w => {
      if (w.style.display !== 'none') { w.style.display = 'none'; found = true; }
    });
    // 還有其他開著、會用共用遮罩的元件 → 遮罩留著。不只 el-dialog：MessageBox 確認框（$confirm）與 drawer
    // 也共用 .v-modal（CodeX 596f4df [P2]：只查 .el-dialog__wrapper 的話，站台警告＋MessageBox 確認框同時開著時
    // 會把確認框的遮罩拿掉）
    const shown = el => el.style.display !== 'none' && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const othersOpen = [...document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, .el-drawer__wrapper')]
      .some(w => !w.hasAttribute('data-uat-site-warning') && shown(w));
    if (found && !othersOpen) document.querySelectorAll('.v-modal').forEach(m => { m.style.display = 'none'; });
    return found;
  });
  if (hidden) await page.waitForTimeout(500);
  return hidden;
}
