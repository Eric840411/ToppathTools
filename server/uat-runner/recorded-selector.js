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

/**
 * 舊錄製器的表格錨點 → 修正式。不是那個形狀就回 null（呼叫端據此判斷「不認得，不處理」）。
 *
 * ⚠️ 不能用 `includes` + `split/join`——那是子字串全域替換，**連引號裡的文字也會被改**。
 *    機台名稱、備註那些值是使用者資料，裡面出現什麼都不意外。（CodeX 2026-09-17 指出）
 *    所以這裡逐字掃，**只改落在引號外的結構部分**，引號內的內容原封不動。
 *
 * 純字串函式，沒有 Playwright 依賴，所以測試可以直接驗它而不用開瀏覽器。
 */
export function legacyTableAnchorVariant(selector) {
  if (typeof selector !== 'string' || !selector.includes(LEGACY_ROW_ANCHOR)) return null;
  let out = '';
  let quote = '';          // 目前在哪種引號裡（'' 代表不在引號裡）
  let changed = false;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      // 引號內：一律原封不動，只跟著轉義與結束引號走
      out += ch;
      if (ch === '\\' && i + 1 < selector.length) { out += selector[++i]; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (selector.startsWith(LEGACY_ROW_ANCHOR, i)) {
      out += 'tr:has(:text-is(';
      i += LEGACY_ROW_ANCHOR.length - 1;
      changed = true;
      continue;
    }
    out += ch;
  }
  // 引號沒收尾代表這條 selector 本身就不完整，不採信它、也不改它
  if (quote || !changed) return null;
  return out;
}

/**
 * locator(...).count()，不讓例外把整個流程炸掉。
 *
 * ⚠️ 不能把所有例外都當成「選擇器語法錯誤」（第一版就是這樣，CodeX 指出）。
 *    導頁到一半、frame 被拆掉、頁面關掉都會拋，那些是「這次量不到」，
 *    不是「這條 selector 寫錯了」——報成語法錯誤會把人導去改一條根本沒問題的選擇器。
 *
 * 回 `{ count, failure }`：failure 為 null（成功）、'invalid'（語法）或 'error'（其他）。
 */
async function safeCount(page, selector) {
  try { return { count: await page.locator(selector).count(), failure: null, message: '' }; }
  catch (e) {
    const message = String(e?.message ?? e).split('\n')[0].slice(0, 200);
    // Playwright 對壞掉的選擇器會明確講「while parsing css selector」或「is not a valid selector」。
    const invalid = /while parsing css selector|is not a valid selector|Unknown engine|SyntaxError/i.test(message);
    return { count: null, failure: invalid ? 'invalid' : 'error', message };
  }
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
  const first = await safeCount(page, selector);
  const count = first.count;
  const base = { selector, count, original: selector, repaired: false, failure: first.failure, message: first.message };
  if (count === 1) return base;

  // 只有「原式命中 0」才考慮相容。命中多筆是另一種問題（錨點不夠獨特），
  // 換成修正式只會把多筆變成不同的多筆，不會變正確。
  // 拋例外的時候也不碰：連量都量不到，沒有依據說修正式比較好。
  if (count !== 0) return base;

  const variant = legacyTableAnchorVariant(selector);
  if (!variant) return base;

  const second = await safeCount(page, variant);
  // 歧義不套用。修正式命中多筆時猜哪一顆都可能點錯，寧可讓原本的錯誤照常出現。
  if (second.count !== 1) return base;

  log(`ℹ️ 舊錄製器的表格錨點已在執行時相容處理（腳本內容未更動）\n   原始：${selector}\n   有效：${variant}`);
  return { selector: variant, count: 1, original: selector, repaired: true, failure: null, message: '' };
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

    const probe = await safeCount(page, step.selector);
    // 語法錯誤才叫 invalid；其他例外（導頁、frame 被拆）是「量不到」，不是選擇器的錯。
    if (probe.failure === 'invalid') return { verifyId, status: 'invalid', count: null };
    if (probe.failure) return { verifyId, status: 'unknown', count: null };
    const count = probe.count;
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
/**
 * 這個錯誤是不是「不確定要動哪一個」？
 *
 * ⚠️ 歧義錯誤**絕對不能掉進任何備援**（JS 觸發、座標點擊）。
 *    座標備援會真的在那個位置按下去，等於把「不知道該點哪個」變成一個看不見的誤點。
 *
 * runner 與測試 import 同一支；各寫一份的話，測試只是在驗自己那份正則。
 * （預檢過了、點下去前 DOM 才變成多筆時，Playwright 會在 click 拋 strict mode。）
 */
export function isAmbiguityError(error) {
  const message = String(error?.message ?? error ?? '');
  return /strict mode violation|resolved to \d+ elements/i.test(message)
    || message.includes('定位必須唯一');
}

/**
 * 舊錄製器對 Element UI 表單產的 `label=欄位名`。
 *
 * ⚠️ 那種 label 跟 input 沒有任何關聯，**Playwright 的 getByLabel 永遠找不到**。
 *    錄製器是從 `.el-form-item` 的結構推出文字再寫成 label= 的——
 *    推得出來不代表找得到。跟 `td:text-is` 那個是同一種病。
 *    （使用者 2026-09-17：二級彈窗的 Jackpot ID 下拉選單。）
 */
export function legacyLabelVariant(selector) {
  if (typeof selector !== 'string' || !selector.startsWith('label=')) return null;
  const text = selector.slice(6).trim();
  if (!text) return null;
  return '.el-form-item:has(> .el-form-item__label:text-is(' + JSON.stringify(text) + ')) input';
}

/**
 * 舊錄製器對「下拉選項」產的 `text=選項文字`。
 *
 * ⚠️ 選項文字常跟表格里的欄位重複（使用者 2026-09-17：`text=4186-dfdc1` 命中 8 個）。
 *    收斂到「目前打開著的下拉面板」裡找；面板全關著時這條是 0，不會亂選。
 *    跟其他相容一樣：**唯一命中才套用**。
 */
export function dropdownOptionVariants(selector) {
  if (typeof selector !== 'string' || !selector.startsWith('text=')) return [];
  const text = selector.slice(5).trim();
  if (!text) return [];
  return ['el-select-dropdown', 'el-dropdown-menu'].map(panel =>
    '.' + panel + ':visible .' + panel + '__item:has(:text-is(' + JSON.stringify(text) + '))');
}

/**
 * 「命中不是一個」的訊息。**只能有這一份**——runner、積木引擎、預檢全部共用。
 * 各寫各的話，日後改措辭只會改到其中一邊，而測試又只盯得住一邊。
 */
export function ambiguityMessage(selector, count) {
  return `定位必須唯一：${selector}（命中 ${count} 個）`;
}

/**
 * 把一條錄製選擇器解成「單一元素」的 locator，並把**怎麼失敗的**講清楚。
 *
 * 回 `{ locator, count, failure, message, selector }`：
 *   failure: null 成功｜'invalid' 選擇器語法錯｜'error' 其他例外（量不到）
 *   count:   0 沒找到｜1 唯一｜>1 多筆（呼叫端自己決定多筆算不算錯）
 *
 * ⚠️ 呼叫端要把這三種分開回報，不要全吞成 null。
 *    「沒找到」要改頁面或等待、「語法錯」要改選擇器、「量不到」要重跑——下一步完全不同。
 */
export async function locateRecorded(page, selector, { requireUnique = false } = {}) {
  const fail = (failure, message) => ({ locator: null, count: null, failure, message, selector });
  if (typeof selector !== 'string' || !selector) return fail('invalid', '選擇器是空的');

  // text=/label= 走 Playwright 的 exact 比對，並優先取可見的那一個。
  // （舊式 text= 是模糊比對，text=Edit 會命中 Player Credit Log，這裡不能改成模糊。）
  const exact = selector.startsWith('text=') ? page.getByText(selector.slice(5), { exact: true })
    : selector.startsWith('label=') ? page.getByLabel(selector.slice(6), { exact: true }) : null;

  if (exact) {
    try {
      let count = await exact.count();
      if (count !== 1) {
        // 舊腳本相容：下拉選項的 text= 常跟表格欄位撞名，收斂到打開著的面板裡。
        for (const variant of dropdownOptionVariants(selector)) {
          const alt = await safeCount(page, variant);
          if (alt.count === 1) {
            const full = page.locator(variant);
            return { locator: requireUnique ? full : full.first(), count: 1, failure: null, message: '', selector: variant };
          }
        }
      }
      if (count === 0) {
        // 舊腳本相容：`label=X` 在 Element UI 表單上永遠是 0，改試 form item 範圍。
        // 跟表格錨點同一個規矩：**唯一命中才套用**，歧義就不碰。
        const variant = legacyLabelVariant(selector);
        if (variant) {
          const alt = await safeCount(page, variant);
          if (alt.count === 1) {
            const full = page.locator(variant);
            return { locator: requireUnique ? full : full.first(), count: 1, failure: null, message: '', selector: variant };
          }
        }
      }
      // ⚠️ 唯一模式回**完整 locator**，不能回 `.first()`。
      //    `.first()` 是「明言只要第一個」，Playwright 就不會再做 strict 檢查——
      //    檢查完之後才新增的重複元素永遠檢查不到，會安靜地動第一個。
      //    回完整 locator，動作當下 Playwright 會再驗一次。（CodeX 2026-09-17 P1）
      if (requireUnique) return { locator: count === 1 ? exact : null, count, failure: null, message: '', selector };
      if (count <= 1) return { locator: exact.first(), count, failure: null, message: '', selector };
      for (let i = 0; i < count; i++) {
        const candidate = exact.nth(i);
        if (await candidate.isVisible().catch(() => false)) return { locator: candidate, count, failure: null, message: '', selector };
      }
      return { locator: exact.first(), count, failure: null, message: '', selector };
    } catch (e) {
      const message = String(e?.message ?? e).split('\n')[0].slice(0, 200);
      return fail(/while parsing css selector|is not a valid selector|Unknown engine|SyntaxError/i.test(message) ? 'invalid' : 'error', message);
    }
  }

  const resolved = await resolveRecordedSelector(page, selector);
  if (resolved.failure) return fail(resolved.failure, resolved.message);
  const full = page.locator(resolved.selector);
  return {
    // 同上：唯一模式不能 `.first()`，否則檢查後才出現的重複永遠擋不到。
    locator: requireUnique ? (resolved.count === 1 ? full : null) : full.first(),
    count: resolved.count,
    failure: null,
    message: '',
    selector: resolved.selector,
  };
}

/**
 * 數「完整集合」有幾個。
 *
 * ⚠️ 計數積木絕對不能改用 locateRecorded()——它回的是 `.first()`，
 *    接上去會**永遠最多算到 1**，把一個看得見的錯誤換成一個安靜的錯誤。
 *    （CodeX 2026-09-17 指出；我原本就打算這樣接。）
 *    它仍然走 Playwright locator，只是不套 `.first()`。
 */
export async function countRecorded(page, selector) {
  if (typeof selector !== 'string' || !selector) return { count: null, failure: 'invalid', message: '選擇器是空的', selector };
  const exact = selector.startsWith('text=') ? page.getByText(selector.slice(5), { exact: true })
    : selector.startsWith('label=') ? page.getByLabel(selector.slice(6), { exact: true }) : null;
  if (exact) {
    try {
      const n = await exact.count();
      if (n === 0) {
        const variant = legacyLabelVariant(selector);
        if (variant) {
          const alt = await safeCount(page, variant);
          if (alt.count === 1) return { count: 1, failure: null, message: '', selector: variant };
        }
      }
      return { count: n, failure: null, message: '', selector };
    }
    catch (e) {
      const message = String(e?.message ?? e).split('\n')[0].slice(0, 200);
      return { count: null, failure: /while parsing css selector|is not a valid selector|Unknown engine|SyntaxError/i.test(message) ? 'invalid' : 'error', message, selector };
    }
  }
  const resolved = await resolveRecordedSelector(page, selector);
  if (resolved.failure) return { count: null, failure: resolved.failure, message: resolved.message, selector };
  return { count: resolved.count, failure: null, message: '', selector: resolved.selector };
}

/** 失敗分類 → 給人看的一句話。積木失敗訊息共用這一份。 */
export function describeLocateFailure(result, what) {
  if (result.failure === 'invalid') return `選擇器語法錯誤：${what}（${result.message}）`;
  if (result.failure === 'error') return `選擇器量不到（頁面可能正在導頁或已關閉）：${what}（${result.message}）`;
  return '';
}

/**
 * 錄製步驟的點擊流程（含兩層備援）。**runner 與測試跑同一支**。
 *
 * 後台登入後有一個站台層級的警告彈窗，遮罩會把底下的按鈕蓋住，
 * 所以 click 被擋時改用 JS 直接觸發；都不行才用錄製座標。
 *
 * ⚠️ **歧義錯誤在每一層都要直接拋出去，不得進入任何備援。**
 *    座標備援會真的在那個位置按下去——把「不知道該點哪個」變成一個看不見的誤點。
 *    JS 那一層的 `.catch(() => false)` 特別容易把它吞掉。（CodeX 2026-09-17 P1）
 *
 * 回 'selector'（正常或 JS 觸發）或 'coordinate'（用了錄製座標）。
 */
export async function clickRecorded({ page, locator, selector, waitMs = 0, viewport,
  allowFallback = false, viewportOk = async () => false, log = () => {}, timeout = 10000 }) {
  try {
    await locator.click({ timeout });
  } catch (e) {
    if (isAmbiguityError(e)) throw e;
    if (!allowFallback) throw e;
    let clicked = false;
    try {
      // 直接對 Playwright 已解析到的同一個節點觸發 click；
      // HTMLElement.click() 仍會冒泡到 Vue 綁在父層的 handler。
      await locator.evaluate(el => { el.click(); });
      clicked = true;
    } catch (inner) {
      // 這裡原本是 `.catch(() => false)`——會把 strict mode 錯誤吞成「點不到」，
      // 然後掉進座標點擊。歧義必須在這一層也拋出去。
      if (isAmbiguityError(inner)) throw inner;
      clicked = false;
    }
    if (!clicked) {
      const x = Number(viewport?.x), y = Number(viewport?.y);
      if (!await viewportOk() || !Number.isFinite(x) || !Number.isFinite(y)) throw e;
      const inside = await page.evaluate(({ x, y }) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight, { x, y });
      if (!inside) throw e;
      await page.mouse.click(x, y);
      await page.waitForTimeout(waitMs);
      log(`  ↳ selector 找不到，viewport 相符，使用錄製座標：(${x}, ${y})`);
      return 'coordinate';
    }
    log(`  ↳ 點擊被遮罩攜截，改用 JS 直接觸發：${selector}`);
  }
  await page.waitForTimeout(waitMs);
  return 'selector';
}

/**
 * 隱藏的原生 checkbox/radio → 看得見、點得到的代理元素。
 *
 * ## 為什麼需要
 * Element UI 把真正的 `<input class="el-checkbox__original">` 藏起來（0×0、移到畫面外），
 * 看得見的是它畫出來的 `.el-checkbox__inner`。錄製到的是真正的 input（那是對的），
 * 但 Playwright 不操作不可見的元素，所以 `setChecked` 會一直等到逾時。
 * （使用者 2026-09-17 回報：第 28 步 30 秒逾時，預檢寫「命中 1 個·不可見· 0×0」。）
 *
 * ## 為什麼不能「往上找可見祖先就點」（CodeX 2026-09-17）
 * 那會點到整列或別的控制項。所以只認**明確關聯**的三種，而且每種都要唯一：
 *   ① `label[for=<input id>]`　② 祖先 `<label>`　③ 所屬 el-checkbox/el-radio 內唯一的 inner
 * 找不到或有歧義就回 problem，不猜。
 */
export async function hiddenToggleProxy(inputLocator) {
  const uniqueOrNull = async (loc) => {
    try { return await loc.count() === 1 && await loc.isVisible() ? loc : null } catch { return null }
  };

  // ③ 先試 Element UI 的 inner：它比整個 label 窄，不會碰到 label 裡的文字或其他控件
  for (const kind of ['el-checkbox', 'el-radio']) {
    const owner = inputLocator.locator(`xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ${kind} ')][1]`);
    const inner = await uniqueOrNull(owner.locator(`.${kind}__inner`));
    if (inner) return { locator: inner, kind: `${kind}__inner`, problem: '' };
  }

  // ① 明確用 for= 關聯的 label
  const id = await inputLocator.getAttribute('id').catch(() => null);
  if (id) {
    const page = inputLocator.page();
    const byFor = await uniqueOrNull(page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`));
    if (byFor) return { locator: byFor, kind: 'label[for]', problem: '' };
  }

  // ② 直接包著它的 label
  const wrapping = await uniqueOrNull(inputLocator.locator('xpath=ancestor::label[1]'));
  if (wrapping) return { locator: wrapping, kind: 'label', problem: '' };

  return { locator: null, kind: '', problem: '這個勾選框是隱藏的，而且找不到明確關聯的可點元素（label 或 el-checkbox 的方框）' };
}

/**
 * 把一個錄製到的 checkbox 設成指定狀態。回 `{ ok, note, problem }`。
 *
 * 順序是 CodeX 定的：
 *   1. 先讀現在的 checked——**已經符合就不碰**（乱點會把它反向取消）
 *   2. 要改才確認沒 disabled
 *   3. 可見就正常 setChecked；隱藏且找得到代理就**正常點擊代理**（不是 DOM click()）
 *   4. 最後**回頭驗原 input 的狀態**——點了不代表真的改成功
 *
 * ⚠️ 不可見不能一律當成失敗：Playwright 本來就會等可操作條件，
 *    有些元素只是「即將可見」。認得出來的隱藏 input 直接走代理（不用等），
 *    其他情況保留有上限的等待，逾時再把原因講清楚。（CodeX 2026-09-17）
 */
export async function setCheckedRecorded(target, desired, { timeout = 10000 } = {}) {
  const want = Boolean(desired);
  let current;
  try { current = await target.isChecked() } catch (e) { return { ok: false, problem: `讀不到勾選狀態：${String(e.message).split('\n')[0]}` } }
  if (current === want) return { ok: true, note: `已經是${want ? '勾選' : '未勾選'}，不重複點` };

  if (await target.isDisabled().catch(() => false)) {
    return { ok: false, problem: `這個勾選框是 disabled，改不了（目前${current ? '已勾' : '未勾'}，預期${want ? '勾選' : '未勾選'}）` };
  }

  const visible = await target.isVisible().catch(() => false);
  if (visible) {
    try { await target.setChecked(want, { timeout }) }
    catch (e) { return { ok: false, problem: `設定勾選失敗：${String(e.message).split('\n')[0]}` } }
    return { ok: true, note: want ? '已勾選' : '已取消勾選' };
  }

  const proxy = await hiddenToggleProxy(target);
  if (!proxy.locator) {
    return { ok: false, problem: `${proxy.problem}。這種元素 Playwright 不會去點，會一直等到逾時` };
  }
  try { await proxy.locator.click({ timeout }) }
  catch (e) { return { ok: false, problem: `點不到可見的勾選框（${proxy.kind}）：${String(e.message).split('\n')[0]}` } }

  // 點了不代表成功——回頭驗原 input
  const after = await target.isChecked().catch(() => null);
  if (after !== want) {
    return { ok: false, problem: `點了${proxy.kind}，但勾選狀態沒有變成預期（目前${after === null ? '讀不到' : after ? '已勾' : '未勾'}）` };
  }
  return { ok: true, note: `${want ? '已勾選' : '已取消勾選'}（原生框是隱藏的，改點 ${proxy.kind}）` };
}

/**
 * 建立執行端的兩支定位函式。**runner 與測試 import 同一支**，不要各寫一份。
 *
 * ⚠️ 這支會被抽出來，是因為測試原本是**自己判定「這種情況應該被拒絕」**：
 *    它只拿到命中數就自己說「rejected」，而 `resolveRecordedSelector()` 根本不負責拒絕。
 *    真正拒絕的是這裡的唯一性檢查，所以測試必須走這一支才算驗到。（CodeX 2026-09-17）
 *
 * ⚠️ `requireUnique` 為 false 時，recordedLocator 會退到 `.first()`——
 *    那條路徑上的歧義是**安靜取第一個**，不是大聲失敗。這是既有行為，
 *    重錄腳本（multi-TC）走的是 requireUnique 那條，不受影響。
 *
 * @param page      Playwright page
 * @param requireUnique  true 時命中數不是 1 就拋「定位必須唯一」
 * @param preview   選用：給 bounds 回一張預覽圖（純診斷用，不影響判定）
 */
export function createRecordedLocators(page, { requireUnique = false, preview = null } = {}) {
  // ⚠️ 這裡**只能**轉手給 locateRecorded()，不得自己再寫一份解析。
  //
  //    2026-09-17 就是因為這裡留了第三份拷貝（自己叫 getByLabel / resolveRecordedSelector），
  //    把 `label=` 的舊格式相容加進 locateRecorded 之後，**預檢與點擊這兩條路徑根本沒走到**，
  //    使用者那邊看到的還是一模一樣的「label=Jackpot ID（命中 0 個）」。
  //    誏刺的是舊版本的註解就寫著「只修一邊等於沒修」——而它本身就是那一邊。
  const recordedLocator = async (selector) => {
    const found = await locateRecorded(page, selector, { requireUnique });
    if (found.failure) throw new Error(describeLocateFailure(found, selector));
    if (!found.locator) throw new Error(ambiguityMessage(selector, found.count));
    return found.locator;
  };

  /** 預檢：不管工廠是不是 requireUnique，預檢本身永遠要求唯一。 */
  const checkLocator = async (step) => {
    if (!step.selector) return;
    const found = await locateRecorded(page, step.selector, { requireUnique: true });
    const info = { count: found.count, visible: false, bounds: null };
    if (found.failure) {
      const error = new Error(describeLocateFailure(found, step.selector));
      error.locator = info;
      throw error;
    }
    // 相容有套用時把原文與有效的都留下來，不是靜默改掉
    if (found.selector !== step.selector) { info.original = step.selector; info.effective = found.selector; }
    if (found.count !== 1 || !found.locator) {
      const error = new Error(ambiguityMessage(step.selector, found.count));
      error.locator = info;
      throw error;
    }
    info.visible = await found.locator.isVisible();
    info.bounds = await found.locator.boundingBox();
    if (preview && info.bounds) {
      try { info.preview = await preview(info.bounds); } catch { /* diagnostics must not alter execution */ }
    }
    return info;
  };

  return { recordedLocator, checkLocator };
}

/**
 * 這支可能回的 status。措辭（給人看的那一句）在 shared/uat-selector-check.ts，
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
