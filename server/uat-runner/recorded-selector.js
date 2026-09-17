/**
 * server/uat-runner/recorded-selector.js
 *
 * 錄製選擇器的共用解析與驗證。**執行端與錄製端都 import 這一支**，不要各寫一份。
 *
 * ## 為什麼有這個檔案
 * 2026-09-17 使用者回報 EGM List 的第 4 步永遠「命中 0 個」，加延遲也沒用。根因是
 * 舊版錄製器產出的表格錨點寫成：
 *
 *     tr:has(td:text-is("4186-DFDC-9999")) > td:nth-of-type(17) button:nth-of-type(1)
 *
 * 後台是 Element UI 的 el-table，每一格的文字都包在 `<td><div class="cell">…</div></td>`
 * 裡；而 Playwright 的 `:text-is()` 只配**最小的那個元素**——它配到 div，`td:text-is()`
 * 永遠 0 個，整條選擇器在任何 el-table 上都不可能命中。這不是等待問題，延遲再久都一樣。
 *
 * 實測（見 recorded-selector.test.mjs）：
 *   <td>文字</td>            → td:text-is() 1 個 ／ :text-is() 1 個
 *   <td><div>文字</div></td> → td:text-is() **0 個** ／ :text-is() 1 個
 *
 * ## 相容策略（跟 CodeX 討論定案，2026-09-17）
 * **DB 裡存的原文不動**，只在執行時做相容：
 *   1. 先用原本的 selector。命中 1 個就用它，什麼都不做。
 *   2. 只有在「原式命中 0」而且「認得出是舊錄製器的表格錨點」時，才試修正式。
 *   3. 修正式必須**唯一命中**才套用；0 個或多筆一律不套用，讓原本的錯誤照常拋出。
 *   4. 套用時把原始與有效 selector 都印進 log，不是靜默改掉。
 *
 * ⚠️ 不做全域字串替換。`td:text-is(` 在別的地方可能是使用者自己寫的、有意義的寫法，
 *    只處理 `tr:has(td:text-is(` 這個舊錄製器產得出來的固定形狀。
 *
 * ⚠️ `recordedLocator()` 與 `checkLocator()` 必須共用這一支。只修其中一邊的話，
 *    預檢那邊仍會先用原式擋下來，修了等於沒修。
 */

/** 舊錄製器（v4.155.x 以前）產出的表格列錨點。只認這個固定形狀，不做泛用替換。 */
const LEGACY_ROW_ANCHOR = 'tr:has(td:text-is(';
const FIXED_ROW_ANCHOR = 'tr:has(:text-is(';

/**
 * 舊錄製器的表格錨點 → 修正式。不是那個形狀就回 null（呼叫端據此判斷「不認得，不處理」）。
 * 純字串函式，沒有 Playwright 依賴，所以測試可以直接驗它而不用開瀏覽器。
 */
export function legacyTableAnchorVariant(selector) {
  if (typeof selector !== 'string' || !selector.includes(LEGACY_ROW_ANCHOR)) return null;
  const fixed = selector.split(LEGACY_ROW_ANCHOR).join(FIXED_ROW_ANCHOR);
  return fixed === selector ? null : fixed;
}

/** locator(...).count()，選擇器語法壞掉時回 -1 而不是讓整個流程炸掉 */
async function safeCount(page, selector) {
  try { return await page.locator(selector).count(); }
  catch { return -1; }
}

/**
 * 解析一個錄製產生的 selector，必要時套用舊格式相容。
 *
 * 回傳 `{ selector, count, original, repaired }`：
 *   - `selector` 是**有效**的那一條（沒修就等於原文）
 *   - `count` 是有效那一條的命中數（-1 代表語法錯誤）
 *   - `repaired` 為 true 時 `original` 才有值
 *
 * 這支**不負責丟錯**。要不要因為命中數不對而失敗，由呼叫端決定——
 * 執行路徑與預檢路徑對「幾個算合法」的標準本來就不同。
 */
export async function resolveRecordedSelector(page, selector, log = console.log) {
  const count = await safeCount(page, selector);
  if (count === 1) return { selector, count, original: selector, repaired: false };

  // 只有「原式命中 0」才考慮相容。命中多筆是另一種問題（錨點不夠獨特），
  // 換成修正式只會把多筆變成不同的多筆，不會變正確。
  if (count !== 0) return { selector, count, original: selector, repaired: false };

  const variant = legacyTableAnchorVariant(selector);
  if (!variant) return { selector, count, original: selector, repaired: false };

  const variantCount = await safeCount(page, variant);
  // 歧義不套用。修正式命中多筆時猜哪一顆都可能點錯，寧可讓原本的錯誤照常出現。
  if (variantCount !== 1) return { selector, count, original: selector, repaired: false };

  log(`ℹ️ 舊錄製器的表格錨點已在執行時相容處理（腳本內容未更動）\n   原始：${selector}\n   有效：${variant}`);
  return { selector: variant, count: 1, original: selector, repaired: true };
}

/**
 * 錄製當下就驗一次剛產出的 selector，結果回報給使用者。**不擋錄製**。
 *
 * ## 為什麼不能把「命中 0」直接當成 selector 壞掉（CodeX 2026-09-17 指出）
 * console 事件回到 Node 這一側時，那一下點擊可能已經換頁、關掉彈窗、或把那一列刪掉了。
 * 此時元素本來就不在，0 個是正常的，不是選擇器有問題。所以要先確認「畫面還是錄的當下
 * 那個畫面」，不是就回報 `unknown`，不下判斷。
 *
 * ## 為什麼唯一命中還要再比一次身分
 * 命中 1 個不等於命中**你剛才點的那一個**。錄製器會在被點的元素上留一個一次性的
 * `data-toppath-rec-target`，這裡比對它，對不上就是 `mismatch`——那比「找不到」更危險，
 * 因為重播時會安靜地點到別的東西。
 *
 * 回傳 `{ verifyId, status, count }`，status 為：
 *   ok       唯一命中，而且就是剛才那一顆
 *   none     畫面沒變、元素還在，但選擇器找不到它 → 錄的當下就是壞的
 *   many     命中多筆 → 重播時會被「定位必須唯一」擋下來
 *   mismatch 唯一命中但不是剛才那一顆
 *   invalid  選擇器語法錯誤
 *   unknown  畫面已變動或元素已消失，無法確認（**不是失敗**）
 */
export async function verifyRecordedSelectorLive(page, step) {
  const verifyId = step?.verifyId;
  if (!verifyId || typeof step.selector !== 'string' || !step.selector) return null;
  try {
    if (step.recordedUrl && page.url() !== step.recordedUrl) return { verifyId, status: 'unknown', count: null };
    const marked = await page.locator(`[data-toppath-rec-target="${verifyId}"]`).count();
    if (marked !== 1) return { verifyId, status: 'unknown', count: null };

    const count = await safeCount(page, step.selector);
    if (count < 0) return { verifyId, status: 'invalid', count: null };
    if (count === 0) return { verifyId, status: 'none', count: 0 };
    if (count > 1) return { verifyId, status: 'many', count };

    // 沒有那個屬性回 ''（這就是 mismatch），evaluate 本身挂掉才回 null（無法確認）。
    // 兩者不能用同一個值表示，否則「點到別顆」會被當成「不確定」静静放過。
    const hit = await page.locator(step.selector)
      .evaluate(node => node.getAttribute('data-toppath-rec-target') ?? '')
      .catch(() => null);
    if (hit === null) return { verifyId, status: 'unknown', count: 1 };
    return { verifyId, status: hit === verifyId ? 'ok' : 'mismatch', count: 1 };
  } catch {
    // 驗證本身出問題絕對不能影響錄製。使用者正在操作，這裡任何 throw 都會變成他的問題。
    return { verifyId, status: 'unknown', count: null };
  }
}

/**
 * 這支可能回的 status。措辭（給人看的那一句）在 `shared/uat-selector-check.ts`，
 * 不放這裡——這一支要原封不動送到 agent，不能 import TS。
 * 兩邊有沒漂掉由 scripts/ui-checks/recorded-selector.mjs 驗。
 */
export const SELECTOR_CHECK_STATUSES = ['ok', 'none', 'many', 'mismatch', 'invalid', 'unknown'];

/**
 * 把驗證結果掛回步驟上。用 verifyId 對應，不用陣列位置——
 * 驗證是非同步回來的，順序不保證跟步驟一樣。
 */
export function applySelectorChecks(steps, checks) {
  if (!checks || !Object.keys(checks).length) return steps;
  return (steps ?? []).map(step => {
    const check = step?.verifyId ? checks[step.verifyId] : null;
    return check ? { ...step, selectorCheck: check.status } : step;
  });
}
