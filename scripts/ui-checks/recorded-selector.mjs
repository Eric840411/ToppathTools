/**
 * 錄製選擇器：el-table 的文字錨點、舊腳本相容、錄製當下驗證。
 *
 *   node scripts/ui-checks/recorded-selector.mjs
 *
 * 起因是 2026-09-17 使用者回報 EGM List 第 4 步永遠「命中 0 個」，加延遲也沒用。
 *
 * ⚠️ 這支**開真的 Chromium**。Playwright 的 `:text-is()` 是「最小元素」語意，
 *    那個語意只有在真的 Playwright 引擎上才看得出來——用字串比對或 jsdom 驗，
 *    會得到一個看起來很合理但完全錯誤的結論。
 *
 * ⚠️ 表格 fixture 一律用 el-table 的真實長相 `<td><div class="cell">…</div></td>`。
 *    這次的 bug 之所以躲過既有的 backend-recorder.browser-test.mjs，就是因為那支的
 *    fixture 寫成 `<td>文字</td>`——**斷言是對的，fixture 讓它驗不到**。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { backendRecorderScript, RECORDER_MARKER } from '../../server/uat-runner/backend-recorder.js';
import {
  legacyTableAnchorVariant, resolveRecordedSelector, verifyRecordedSelectorLive,
  applySelectorChecks, SELECTOR_CHECK_STATUSES, createRecordedLocators,
} from '../../server/uat-runner/recorded-selector.js';
import { runMultiTcSteps } from '../../server/uat-runner/multi-tc.js';

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✅ ' + name); }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w); }
};

const CELL = (text) => `<td><div class="cell">${text}</div></td>`;

// el-table 的真實長相：每一格的內容都包在 div.cell 裡
const FIXTURE = `
<table><thead><tr><th>Machine</th><th>Alias</th><th>Operation</th></tr></thead><tbody>
  <tr>${CELL('4186-DFDC-9999')}${CELL('A')}<td><div class="cell"><span><button class="b1">Edit</button></span><span><button class="b2">Del</button></span></div></td></tr>
  <tr>${CELL('4186-DFDC-1111')}${CELL('B')}<td><div class="cell"><span><button class="b1">Edit</button></span><span><button class="b2">Del</button></span></div></td></tr>
</tbody></table>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(FIXTURE);
  const count = async (s) => { try { return await page.locator(s).count(); } catch { return -1; } };

  // ── 1. 根因本身：td:text-is() 在 el-table 上必定 0 ─────────────────────────
  console.log('\n── 根因 ──');
  eq('舊式錨點 td:text-is 在 el-table 上命中 0', await count('tr:has(td:text-is("4186-DFDC-9999"))'), 0);
  eq('去掉 td 限定之後唯一命中', await count('tr:has(:text-is("4186-DFDC-9999"))'), 1);
  // 純文字格也要照樣命中，否則「修好舊的、弄壞新的」
  await page.setContent('<table><tbody><tr><td>PLAIN</td><td><button>E</button></td></tr></tbody></table>');
  eq('純文字格（沒有 wrapper）也唯一命中', await count('tr:has(:text-is("PLAIN"))'), 1);
  await page.setContent(FIXTURE);

  // ── 2. 相容：舊腳本不改 DB，執行時解析 ────────────────────────────────────
  console.log('\n── 舊腳本相容 ──');
  const legacy = 'tr:has(td:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button:nth-of-type(1)';
  eq('認得出舊錨點', typeof legacyTableAnchorVariant(legacy), 'string');
  eq('不是那個形狀就不碰', legacyTableAnchorVariant('button.save'), null);
  // ⚠️ 不做全域替換：使用者自己寫的 td:text-is 不在 tr:has 裡的，不能被動到
  eq('沒包在 tr:has 裡的 td:text-is 不動它', legacyTableAnchorVariant('td:text-is("X") button'), null);
  // ⚠️ 引號內是使用者資料（機台名稱、備註…），子字串全域替換會連它一起改掉。
  eq('引號內的同名字串不被動到',
    legacyTableAnchorVariant('tr:has(td:text-is("tr:has(td:text-is(\\"x\\")")) > td:nth-of-type(2) button'),
    'tr:has(:text-is("tr:has(td:text-is(\\"x\\")")) > td:nth-of-type(2) button');
  eq('引號沒收尾就不採信', legacyTableAnchorVariant('tr:has(td:text-is("abc'), null);

  // 這一條的 tail 是舊的 nth-of-type：修好錨點後會命中 2 顆（兩顆按鈕各自在自己的 span 裡
  // 都是 first-of-type），所以**必須不套用**，讓原本的錯誤照常出現。
  const ambiguous = await resolveRecordedSelector(page, legacy, () => {});
  eq('修正式有歧義時不套用', { repaired: ambiguous.repaired, selector: ambiguous.selector }, { repaired: false, selector: legacy });

  const legacyUnique = 'tr:has(td:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button.b2';
  const repaired = await resolveRecordedSelector(page, legacyUnique, () => {});
  eq('修正式唯一命中才套用', { repaired: repaired.repaired, count: repaired.count }, { repaired: true, count: 1 });
  eq('套用後保留原文可供對照', repaired.original, legacyUnique);
  eq('命中 1 的 selector 原封不動', (await resolveRecordedSelector(page, 'button.b2', () => {})).repaired, false);
  // 原式命中多筆時不該改寫——換成修正式只會變成另一種多筆，不會變正確
  const many = await resolveRecordedSelector(page, 'tr:has(td:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button, button.b1', () => {});
  eq('原式命中多筆時不套用相容', many.repaired, false);

  // ── 3. 錄製端產出的選擇器（真的注入、真的點）─────────────────────────────
  console.log('\n── 錄製端產出 ──');
  const ctx = await browser.newContext();
  await ctx.addInitScript(backendRecorderScript());
  const rec = await ctx.newPage();
  const events = [];
  rec.on('console', m => {
    const t = m.text();
    if (t.startsWith(RECORDER_MARKER)) events.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
  });
  await rec.goto('data:text/html,' + encodeURIComponent(FIXTURE));
  await rec.evaluate(() => window.__toppathArmRecorder?.());
  await rec.waitForTimeout(150);

  await rec.click('tr:nth-of-type(1) .b2');
  await rec.waitForTimeout(120);
  const step = events.at(-1);
  eq('用列內容錨定', step?.selectorStrategy, 'tableCell');
  eq('產出的選擇器不含舊式 td:text-is', String(step?.selector || '').includes('td:text-is('), false);
  eq('產出的選擇器唯一命中', await count(String(step?.selector || 'never')), 1);
  // 唯一命中還不夠：要確認命中的就是剛才點的那一顆，不是同一格裡的另一顆按鈕
  // 選擇器壞掉時 evaluate 會拋錯——這裡接住，讓它報成一項失敗而不是整支中斷，
  // 否則後面那些項目永遠不會跑到，看起來像「只錯一項」。
  const which = await rec.locator(step.selector).evaluate(n => n.className).catch(() => '(找不到元素)');
  eq('命中的是剛才點的那一顆（不是同格的另一顆）', which, 'b2');

  // 第二列：錨點換一台機器，不能還指到第一列
  await rec.click('tr:nth-of-type(2) .b1');
  await rec.waitForTimeout(120);
  const step2 = events.at(-1);
  const row2 = await rec.locator(step2.selector).evaluate(n => n.closest('tr').textContent).catch(() => '(找不到元素)');
  eq('第二列的步驟指到第二列', row2.includes('4186-DFDC-1111'), true);

  // ── 3b. CodeX 點名的三種情境 ──────────────────────────────
  console.log('\n── 重複錨點／固定欄副本／巢狀表格 ──');

  // (a) 錄完之後又多了一列錨點文字相同的，而且排在前面。
  //     ⚠️ 舊的 :nth-match() 寫法在這裡會**命中 1 個、卻是別一列的按鈕**，
  //     唯一性檢查根本擋不住。正確行為是命中多筆、大聲失敗。
  await rec.evaluate(() => {
    const tbody = document.querySelector('tbody');
    const clone = tbody.children[0].cloneNode(true);
    tbody.insertBefore(clone, tbody.firstChild);
    // 先複製再標，標記才不會跟著被複製過去。
    // 用身分比對而不是 rowIndex：fixture 有 thead，寫死的序號會驗到錯的東西。
    tbody.children[1].setAttribute('data-recorded-row', '1');
  });
  eq('同錨點的列多一列時會命中多筆（而不是安靜指到別列）', await rec.locator(step.selector).count() > 1, true);
  eq('舊的 :nth-match 寫法仍然只命中 1 個（唯一性檢查擋不住）',
    await rec.locator(':nth-match(tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button, 2)').count(), 1);
  eq('而且它指的不是錄製當下那一列（所以不能用）',
    await rec.locator(':nth-match(tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button, 2)')
      .evaluate(n => n.closest('tr').hasAttribute('data-recorded-row')).catch(() => null), false);
  await rec.evaluate(() => {
    document.querySelector('tbody').firstChild.remove();
    document.querySelector('[data-recorded-row]')?.removeAttribute('data-recorded-row');
  });
  eq('重複列拿掉後恢復唯一', await rec.locator(step.selector).count(), 1);

  // ── (b)(c) 固定欄副本與巢狀表格：走**實際錄製 → 完整 selector → 重播結果** ──
  //
  // ⚠️ 第一版這兩組是手寫 selector 只數列數，**根本沒經過錄製器**，也沒驗重播結果。
  //    CodeX 還指出固定欄那組寫 `M-2` 是錯的——錄製器會因為錨點重複而改選 `A`。
  //    實測確認他說對了，所以現在釘的是錄製器真正產出的那一條。
  //
  // 驗收標準：**要麼命中原目標，要麼明確拒絕**；命中 1 個卻是別的元素（WRONG）絕對不允許。
  const recordAndReplay = async (html, clickSelector, mutate) => {
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(backendRecorderScript());
    const page2 = await ctx2.newPage();
    const evts = [];
    page2.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) evts.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    await page2.goto('data:text/html,' + encodeURIComponent(html));
    await page2.evaluate(() => window.__toppathArmRecorder?.());
    await page2.waitForTimeout(150);
    await page2.click(clickSelector);
    await page2.waitForTimeout(150);
    const recorded = evts.at(-1);
    if (mutate) { await page2.evaluate(mutate); await page2.waitForTimeout(50); }
    // 走產品的解析，不是測試自己再寫一遍
    const resolved = await resolveRecordedSelector(page2, recorded.selector, () => {});
    let verdict = 'rejected';
    if (resolved.count === 1) {
      const id = await page2.locator(resolved.selector)
        .evaluate(n => n.getAttribute('data-toppath-rec-target') ?? '').catch(() => null);
      verdict = id === recorded.verifyId ? 'hit' : 'WRONG';
    }
    await ctx2.close();
    return { verdict, selector: recorded.selector, count: resolved.count };
  };

  // (b) el-table 固定欄：主表有全部欄位，.el-table__fixed 再複製一份錨點欄。
  const FIXED_TABLE = `<div class="el-table">
    <div class="el-table__body-wrapper"><table><tbody>
      <tr>${CELL('M-2')}${CELL('A')}<td><div class="cell"><button class="go">E</button></div></td></tr>
    </tbody></table></div>
    <div class="el-table__fixed"><table><tbody><tr>${CELL('M-2')}</tr></tbody></table></div>
  </div>`;
  const fixed = await recordAndReplay(FIXED_TABLE, '.el-table__body-wrapper .go');
  // 錄製器的「錨點只能出現一次」規則本身就擋掉了固定欄副本：
  // M-2 在主表與固定欄各一次→ 被跳過，改用只出現一次的 A。
  eq('固定欄：錄製器不拿被複製的文字當錨點', fixed.selector.includes('"M-2"'), false);
  eq('固定欄：重播命中原目標', fixed.verdict, 'hit');

  // (c) 巢狀表格：內層表格的列也是 tr，外層 tr 同樣含有內層的文字。
  const NESTED_TABLE = `<table><tbody><tr>${CELL('M-3')}<td><table><tbody>
    <tr>${CELL('inner')}<td><div class="cell"><button class="go">E</button></div></td></tr>
  </tbody></table></td></tr></tbody></table>`;
  const nested = await recordAndReplay(NESTED_TABLE, '.go');
  eq('巢狀：重播命中原目標', nested.verdict, 'hit');

  // (d) 真的歧義：錄完之後又出現一列錨點文字相同的。這種必須被拒絕。
  const dup = await recordAndReplay(FIXTURE, 'tr:nth-of-type(1) .b2', () => {
    const tbody = document.querySelector('tbody');
    const clone = tbody.children[0].cloneNode(true);
    tbody.insertBefore(clone, tbody.firstChild);
    // ⚠️ cloneNode 連錄製器的一次性標記一起複製走。不拇掉的話，「指到別列」
    //    也會因為標記相同而被判成命中原目標，這條斷言就失去鑑別力。
    clone.querySelectorAll('[data-toppath-rec-target]').forEach(n => n.removeAttribute('data-toppath-rec-target'));
  });
  eq('錄完後多出同錨點的列：明確拒絕（不是安靜指到別列）', dup.verdict, 'rejected');
  eq('拒絕的理由是命中多筆', dup.count > 1, true);

  // ── (e) 走**產品的執行入口**確認重複列真的被擋下來 ─────────────
  //
  // ⚠️ 前面的 (d) 是拿命中數**測試自己判定**「rejected」，而 `resolveRecordedSelector()`
  //    根本不負責拒絕——真正拒絕的是 `createRecordedLocators()` 的唯一性檢查。
  //    這一條走產品的 `runMultiTcSteps()` + 產品的 `checkLocator`，斷言兩件事：
  //    **拋出唯一性錯誤**，而且**沒有任何按鈕被按到**。（CodeX 2026-09-17）
  console.log('\n── 走產品執行入口 ──');
  {
    const ctx3 = await browser.newContext();
    await ctx3.addInitScript(backendRecorderScript());
    const page3 = await ctx3.newPage();
    const evts3 = [];
    page3.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) evts3.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    await page3.goto('data:text/html,' + encodeURIComponent(FIXTURE));
    await page3.evaluate(() => window.__toppathArmRecorder?.());
    await page3.waitForTimeout(150);
    await page3.click('tr:nth-of-type(1) .b2');
    await page3.waitForTimeout(150);
    const recordedStep = { ...evts3.at(-1), tcId: 'rec-1' };

    // 真的按下去會變成什麼：任何按鈕被按到就記一筆。
    //
    // ⚠️ 必須用 document 層的委派，不能逐顆 addEventListener——
    //    下面用 cloneNode 造重複列，**複製出來的按鈕不會帶著監聽器**。
    //    逐顆掛的話，退化成 .first() 按下複製列的按鈕時這條斷言看不到，
    //    會在「防線已經拿掉」的情況下依然維持綠燈。（注入測試時拓到）
    await page3.evaluate(() => {
      window.__clicks = [];
      document.addEventListener('click', e => {
        const btn = e.target.closest?.('button');
        if (btn) window.__clicks.push(btn.className);
      }, true);
    });
    // 錄完之後又出現一列錨點文字相同的
    await page3.evaluate(() => {
      const tbody = document.querySelector('tbody');
      const clone = tbody.children[0].cloneNode(true);
      tbody.insertBefore(clone, tbody.firstChild);
      clone.querySelectorAll('[data-toppath-rec-target]').forEach(n => n.removeAttribute('data-toppath-rec-target'));
    });

    const { recordedLocator, checkLocator } = createRecordedLocators(page3, { requireUnique: true });
    const traces = await runMultiTcSteps([recordedStep], {
      page: page3,
      checkLocator,
      async clickSelector(selector, waitMs) {
        // 走產品的 recordedLocator；它該拋就拋，不要在測試裡接起來
        const target = await recordedLocator(selector);
        await target.click({ timeout: 3000 });
        await page3.waitForTimeout(Number(waitMs) || 0);
        return 'selector';
      },
    }, [{ recordId: 'rec-1', tableId: 'tbl', number: 'TC-1', text: '重複列', sub: '' }]);

    const trace = traces?.traces?.[0] ?? traces?.[0] ?? null;
    const message = JSON.stringify(trace ?? traces);
    eq('產品入口：重複列會失敗', /定位必須唯一/.test(message), true);
    eq('產品入口：沒有任何按鈕被按到', await page3.evaluate(() => window.__clicks), []);

    // ⚠️ 這一條要說清楚：把唯一性檢查注入掉之後，「沒有按鈕被按到」**依然維持綠燈**，
    //    因為 Playwright 自己的 strict mode 會先因為解到兩個元素而拋錯。
    //    所以那條斷言驗的是「不管哪一層擋，總之不能點下去」，
    //    **不能拿它當成「我的唯一性檢查有效」的證據**。真正驗到我那一層的是上面那條。

    // 另一條路徑（requireUnique: false，即非 multi-TC）是明確的 .first()——
    // strict mode 不會救它，歧義會被**安靜地取第一個**。釘住這個既有行為，
    // 不是因為它對，是因為之後真要改的時候看得見差別在哪。
    const loose = createRecordedLocators(page3, { requireUnique: false });
    const first = await loose.recordedLocator(recordedStep.selector);
    eq('非 multi-TC 路徑：歧義時取第一個、不拋錯（既有行為）', await first.count(), 1);
    eq('而且取到的不是錄製的那一顆',
      await first.evaluate(n => n.getAttribute('data-toppath-rec-target') ?? ''), '');
    await ctx3.close();
  }

  // ── 4. 錄製當下的驗證 ─────────────────────────────────────────────────────
  console.log('\n── 錄製當下驗證 ──');
  const good = await verifyRecordedSelectorLive(rec, step2);
  eq('好的選擇器回 ok', good?.status, 'ok');
  const broken = await verifyRecordedSelectorLive(rec, { ...step2, selector: 'button.does-not-exist' });
  eq('找不到回 none', broken?.status, 'none');
  eq('命中多筆回 many', (await verifyRecordedSelectorLive(rec, { ...step2, selector: 'button' }))?.status, 'many');
  eq('語法錯誤回 invalid', (await verifyRecordedSelectorLive(rec, { ...step2, selector: 'tr:has(' }))?.status, 'invalid');
  eq('命中 1 個但不是那一顆回 mismatch', (await verifyRecordedSelectorLive(rec, { ...step2, selector: 'tr:nth-of-type(1) .b2' }))?.status, 'mismatch');
  // ⚠️ 頁面已經換掉時不能判成「選擇器壞了」——那會叫使用者去修根本沒壞的步驟
  eq('頁面已變動回 unknown（不是失敗）',
    (await verifyRecordedSelectorLive(rec, { ...step2, recordedUrl: 'https://somewhere-else.example/' }))?.status, 'unknown');
  eq('沒有 verifyId 就不驗', await verifyRecordedSelectorLive(rec, { selector: 'button' }), null);

  // ── 4b. 語法錯誤 vs 其他例外，不能混為一談 ───────────────────
  //
  // ⚠️ 第一版的 safeCount 把**所有**例外都當成「選擇器語法錯誤」（CodeX 指出）。
  //    導頁到一半、frame 被拆掉都會拋，那是「這次量不到」不是「selector 寫錯」——
  //    報成語法錯誤會把人導去改一條根本沒問題的選擇器。
  console.log('\n── 語法錯誤與其他例外要分開 ──');
  {
    // 用 stub 是因為要驗的是「例外怎麼分類」，不是 DOM 行為；
    // 真的去製造導頁競態反而不穩定。語法錯誤那一條在上面用真的頁面驗過了。
    const boom = (message) => ({
      url: () => 'https://example.test/',
      locator: (sel) => ({
        count: async () => {
          if (sel.startsWith('[data-toppath-rec-target=')) return 1;   // 標記還在
          throw new Error(message);
        },
        evaluate: async () => { throw new Error(message); },
      }),
    });

    const closed = await verifyRecordedSelectorLive(
      boom('Target page, context or browser has been closed'),
      { verifyId: 'v1', selector: '.x', recordedUrl: 'https://example.test/' });
    eq('頁面已關閉→ unknown（不是語法錯誤）', closed?.status, 'unknown');

    const syntax = await verifyRecordedSelectorLive(
      boom('Unexpected token "" while parsing css selector "tr:has("'),
      { verifyId: 'v1', selector: 'tr:has(', recordedUrl: 'https://example.test/' });
    eq('真的語法錯誤→ invalid', syntax?.status, 'invalid');

    // resolveRecordedSelector 碰到非語法例外時不能套相容——連量都量不到，
    // 沒有任何依據說修正式比較好。
    const legacyOnBrokenPage = await resolveRecordedSelector(
      boom('Target page, context or browser has been closed'),
      'tr:has(td:text-is("M-1")) > td:nth-of-type(2) button', () => {});
    eq('量不到的時候不套舊格式相容', legacyOnBrokenPage.repaired, false);
  }

  // ── 5. 結果掛回步驟：用 verifyId 不用位置 ─────────────────────────────────
  console.log('\n── 結果掛回步驟 ──');
  const applied = applySelectorChecks(
    [{ action: 'click', verifyId: 'a' }, { action: 'click' }, { action: 'click', verifyId: 'b' }],
    { b: { status: 'none', count: 0 }, a: { status: 'ok', count: 1 } });
  eq('依 verifyId 對應而不是陣列順序', applied.map(s => s.selectorCheck ?? null), ['ok', null, 'none']);

  // ── 6. 接線：執行與預檢兩條路徑真的都走同一支解析 ────────────
  //
  // ⚠️ 這一節驗的是**接線**，不是行為。run-lark-tc-backend.js 一 import 就會跑 main()，
  //    沒辦法在這裡真的叫它的 recordedLocator()。直接讀原始碼確認兩條路徑都呼叫了
  //    resolveRecordedSelector——只修執行那邊的話，預檢仍會先用原式擋下來，等於沒修。
  console.log('\n── 接線（讀原始碼，不是行為驗證）──');
  const runnerSrc = readFileSync(new URL('../../server/uat-runner/run-lark-tc-backend.js', import.meta.url), 'utf8')
    // 剪掉註解再比，否則寫在註解裡的同名字也算數。
    // 行尾註解用 CR/LF 字元類別而不是 .*$，因為這份檔是 CRLF。
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  // 定位跟唯一性檢查已經抽到 recorded-selector.js，這裡釘的是「runner 真的用那一支」。
  eq('runner 用共用的定位工廠', runnerSrc.includes('createRecordedLocators(p, {'), true);
  // ⚠️ 「定位必須唯一」這句話只能存在於共用那一支。runner 裡又出現一份，
  //    就代表有人把判斷再複製回去了——兩邊日後一定漂。
  eq('runner 裡沒有自己再寫一份唯一性判斷', runnerSrc.includes('定位必須唯一'), false);

  const recorderSrc = readFileSync(new URL('../../server/uat-runner/backend-recorder.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  eq('錄製器不再產出 :nth-match', recorderSrc.includes(':nth-match('), false);

  // ── 7. 前後端措辭沒有漂掉 ─────────────────────────────────────────────────
  console.log('\n── 措辭一致 ──');
  const labelSrc = readFileSync(new URL('../../shared/uat-selector-check.ts', import.meta.url), 'utf8');
  const labelled = [...labelSrc.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  const shouldLabel = SELECTOR_CHECK_STATUSES.filter(s => s !== 'ok' && s !== 'unknown');
  eq('每個「算問題」的 status 都有對應措辭', shouldLabel.filter(s => !labelled.includes(s)), []);
  eq('措辭表沒有多出產生端不會回的 status', labelled.filter(s => !SELECTOR_CHECK_STATUSES.includes(s)), []);
  eq('unknown 刻意不列為問題', labelled.includes('unknown'), false);

  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} 項通過，${fails.length} 項失敗`);
if (fails.length) { console.error('失敗項目：' + fails.join('；')); process.exitCode = 1; }
