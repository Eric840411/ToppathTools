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
 *
 * ## 驗收標準（跟 CodeX 定下，2026-09-17）
 *
 * 這一輪「測試驗錯對象／驗到一個不可能失敗的東西」出現了**五次**。三條硬規定：
 *
 *   1. **走產品入口**——不是測 helper，也不是測試自己再寫一份同樣的邏輯。
 *   2. **驗實際副作用**——「有沒有按下去」要看真的按鈕事件與 `page.mouse.click`，
 *      不是看測試自己設的旗標。
 *   3. **對應缺陷注入回去要真的轉紅**——而且**每一條分支要分開注入**，
 *      否則只驗到其中一條（實際發生過：只注入 CSS 分支時 text= 分支的洞沒被拓到）。
 */
import { stripComments as stripSrc } from './lib/strip-comments.mjs';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { backendRecorderScript, RECORDER_MARKER } from '../../server/uat-runner/backend-recorder.js';
import {
  legacyTableAnchorVariant, resolveRecordedSelector, verifyRecordedSelectorLive,
  applySelectorChecks, SELECTOR_CHECK_STATUSES, createRecordedLocators, isAmbiguityError, clickRecorded,
  locateRecorded, setCheckedRecorded, hiddenToggleProxy, legacyLabelVariant, countRecorded,
} from '../../server/uat-runner/recorded-selector.js';
import { runMultiTcSteps } from '../../server/uat-runner/multi-tc.js';
import { runSteps } from '../../server/uat-runner/block-engine.js';

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

  // ── (e2) 走**產品的點擊流程**，驗歧義不會掉進任何備援 ──────────
  //
  // ⚠️ 第一版這段是測試自己設「有沒掉進備援」的旗標，而且在重新定位時就被擋下來、
  //    根本沒走到 click——證明不了 runner 沒呼叫備援。（CodeX 指出）
  //    現在走產品的 clickRecorded()，並且**監聽 page.mouse.click**——座標備援真的按下去
  //    就一定會經過它，這才是「沒有掉進座標備援」的客觀證據。
  console.log('\n── 產品點擊流程：歧義不得進備援 ──');
  {
    const mkPage = async (html) => {
      const pg = await browser.newPage();
      await pg.setContent(html);
      await pg.evaluate(() => {
        window.__clicks = [];
        document.addEventListener('click', e => {
          const b = e.target.closest?.('button');
          if (b) window.__clicks.push(b.className);
        }, true);
      });
      // 監聽座標點擊（座標備援唯一的出口）
      const mouseHits = [];
      const realMouseClick = pg.mouse.click.bind(pg.mouse);
      pg.mouse.click = async (...args) => { mouseHits.push(args); return realMouseClick(...args); };
      return { pg, mouseHits };
    };
    const dup = () => {
      const tbody = document.querySelector('tbody');
      tbody.insertBefore(tbody.children[0].cloneNode(true), tbody.firstChild);
    };
    const selector = 'tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button.b2';

    // ① 拿到 locator 之後才變多筆
    {
      const { pg, mouseHits } = await mkPage(FIXTURE);
      const { recordedLocator } = createRecordedLocators(pg, { requireUnique: true });
      const target = await recordedLocator(selector);   // 此刻唯一
      await pg.evaluate(dup);                            // 之後才重複
      let err = '';
      try {
        await clickRecorded({ page: pg, locator: target, selector, waitMs: 0,
          viewport: { x: 10, y: 10 }, allowFallback: true, viewportOk: async () => true, timeout: 800 });
      } catch (e) { err = String(e.message) }
      eq('① 拿到 locator 後變多筆：拋歧義錯誤', isAmbiguityError(err), true);
      eq('① 沒有任何按鈕被按到', await pg.evaluate(() => window.__clicks), []);
      eq('① 沒有呼叫座標點擊', mouseHits.length, 0);
      await pg.close();
    }

    // ② click 逾時之後、JS 備援之前才變多筆
    //
    // ⚠️ 第一版是在頁面裡排 300ms 定時器，**不保證「逾時之後」才插入**——
    //    定時器晚一點或早一點，驗到的就是不同的時序，可能因為錯的理由而綠。（CodeX 指出）
    //    改成包裝真實的 click()：等它真的逾時了才插入重複，再把原錯誤重拋。
    //    這樣 JS 備援跑到的時候，DOM 一定已經是多筆。
    {
      const OVERLAY = FIXTURE + '<div id="mask" style="position:fixed;inset:0;z-index:9999"></div>';
      const { pg, mouseHits } = await mkPage(OVERLAY);
      const { recordedLocator } = createRecordedLocators(pg, { requireUnique: true });
      const target = await recordedLocator(selector);
      // ⚠️ 旗標只能在**真的逾時**時才設。第一版是「任何例外都算逾時」，
      //    萬一先發生別的錯誤，測試照樣插入重複、最後因為 JS 層的歧義而全綠——
      //    驗到的就不是「click 逾時後、JS 備援前」這個指定時序了。（CodeX 2026-09-17 P2）
      //    其他錯誤直接重拋，不插入、不設旗標，讓那條斷言自己紅掉。
      let timedOut = false;
      let firstErrorName = '';
      const sequenced = new Proxy(target, {
        get(obj, prop) {
          if (prop !== 'click') return typeof obj[prop] === 'function' ? obj[prop].bind(obj) : obj[prop];
          return async (...args) => {
            try { return await obj.click(...args) }
            catch (e) {
              firstErrorName = e?.name || '';
              if (firstErrorName !== 'TimeoutError') throw e;   // 不是逾時就不是我要驗的時序
              timedOut = true;
              await pg.evaluate(() => {
                const tbody = document.querySelector('tbody');
                tbody.insertBefore(tbody.children[0].cloneNode(true), tbody.firstChild);
              });
              throw e;   // 原錯誤原封不動丟回去，讓產品走它原本的備援流程
            }
          };
        },
      });
      let err = '';
      try {
        await clickRecorded({ page: pg, locator: sequenced, selector, waitMs: 0,
          viewport: { x: 10, y: 10 }, allowFallback: true, viewportOk: async () => true, timeout: 700 });
      } catch (e) { err = String(e.message) }
      eq('② click 拋的確實是 TimeoutError（不是別的錯）', firstErrorName, 'TimeoutError');
      eq('② 所以重複是在逾時之後才插入的（時序成立）', timedOut, true);
      eq('② 逾時後變多筆：JS 備援不得吞歧義', isAmbiguityError(err), true);
      eq('② 沒有任何按鈕被按到', await pg.evaluate(() => window.__clicks), []);
      eq('② 沒有掉進座標備援', mouseHits.length, 0);
      await pg.close();
    }

    // ③ 沒有歧義時，備援要照常可用——不能因為改嚴了就把正常備援也堵死
    {
      const OVERLAY = '<button class="only">go</button><div id="mask" style="position:fixed;inset:0;z-index:9999"></div>';
      const { pg, mouseHits } = await mkPage(OVERLAY);
      const { recordedLocator } = createRecordedLocators(pg, { requireUnique: true });
      const target = await recordedLocator('button.only');
      const mode = await clickRecorded({ page: pg, locator: target, selector: 'button.only', waitMs: 0,
        viewport: { x: 10, y: 10 }, allowFallback: true, viewportOk: async () => true, timeout: 700 });
      eq('③ 被遮罩擋住但不歧義：JS 備援成功', mode, 'selector');
      eq('③ 而且按鈕真的被按到', await pg.evaluate(() => window.__clicks), ['only']);
      eq('③ 沒有用到座標', mouseHits.length, 0);
      await pg.close();
    }
  }

  // ── (e3) 唯一模式必須回完整 locator，不能回 .first() ─────────────
  //
  // ⚠️ `.first()` 是「明言只要第一個」，Playwright 就不會在動作當下再做 strict 檢查。
  //    於是「檢查完之後才新增的重複元素」永遠檢查不到，會安靜地動第一個。
  //    這條路徑是 `locateRecorded()`（積木的單一目標、runner 的 pressKey 都走它）——
  //    跟上面 ① 走的 `createRecordedLocators()` 是兩支，要分開驗。（CodeX 2026-09-17 P1）
  console.log('\n── 唯一模式回完整 locator ──');
  {
    const pg = await browser.newPage();
    await pg.setContent(FIXTURE);
    await pg.evaluate(() => {
      window.__clicks = [];
      document.addEventListener('click', e => {
        const b = e.target.closest?.('button');
        if (b) window.__clicks.push(b.className);
      }, true);
    });
    const selector = 'tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(3) button.b2';

    // ⚠️ 定位有**兩條分支**：text=/label= 走 getByText/getByLabel，其他走 page.locator。
    //    只驗一條的話，另一條退回 `.first()` 也不會紅。兩條分開驗。（CodeX 指出）
    for (const [branch, sel] of [['CSS', selector], ['text=', 'text=4186-DFDC-9999']]) {
      const page5 = await browser.newPage();
      await page5.setContent(FIXTURE);
      await page5.evaluate(() => {
        window.__clicks = [];
        document.addEventListener('click', e => {
          const b = e.target.closest?.('button');
          if (b) window.__clicks.push(b.className);
        }, true);
      });

      const found = await locateRecorded(page5, sel, { requireUnique: true });
      eq(`${branch}：檢查當下是唯一的`, found.count, 1);

      // 檢查完之後才出現重複
      await page5.evaluate(() => {
        const tbody = document.querySelector('tbody');
        tbody.insertBefore(tbody.children[0].cloneNode(true), tbody.firstChild);
      });

      // 回的若是 `.first()`，這裡會回 1（看不見新增的那一個）
      eq(`${branch}：唯一模式回完整 locator（重複後看得到 2）`, await found.locator.count(), 2);

      let err = '';
      try { await found.locator.click({ timeout: 700 }) } catch (e) { err = String(e.message) }
      eq(`${branch}：動作當下被 strict 檢查擋下來`, isAmbiguityError(err), true);
      eq(`${branch}：沒有任何按鈕被按到`, await page5.evaluate(() => window.__clicks), []);
      await page5.close();
    }
    await pg.close();
  }

  // ── (f) 真瀏覽器跑積木：錄製格式的選擇器在 read_block 上不再 SyntaxError ──
  //
  // 這一條直接重現使用者 2026-09-17 回報的那個失敗：
  //   預檢寫「命中 1 個·可見」，執行卻 `SyntaxError: ... is not a valid selector`。
  //
  // ⚠️ 假的 page 驗不出這個——它不會像真瀏覽器一樣拒絕不合法的 CSS。
  //    實測：把 read_block 注入回原生 querySelector 版本時，block-engine 的假 page
  //    測試只有「沒回頭用 page.evaluate」那一條會紅，這一條才是真的拓到錯誤。
  console.log('\n── 真瀏覽器跑積木 ──');
  {
    const realPage = await browser.newPage();
    await realPage.setContent(FIXTURE);
    const noop = async () => {};
    const blockCtx = {
      page: realPage,
      openPath: noop,
      resolveSubtypePath: () => null,
      takeScreenshot: async () => null,
      callBuiltin: async () => ({ notes: '', criticalFails: [], manual: false }),
    };
    // 錄製器今天產出來的形狀
    const modern = 'tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(2)';
    const rModern = await runSteps([{ action: 'read_block', selector: modern, as: 'm' }], blockCtx);
    eq('真瀏覽器：read_block 讀得到錄製格式的選擇器', rModern.pass, true);

    // 舊格式（td:text-is）——靠執行時相容修正，也要讀得到
    const legacyRead = 'tr:has(td:text-is("4186-DFDC-9999")) > td:nth-of-type(2)';
    const rLegacy = await runSteps([{ action: 'read_block', selector: legacyRead, as: 'l' }], blockCtx);
    eq('真瀏覽器：read_block 也讀得到舊格式（靠相容）', rLegacy.pass, true);

    // 純 CSS 照常
    const rCss = await runSteps([{ action: 'read_block', selector: 'table', as: 'c' }], blockCtx);
    eq('真瀏覽器：純 CSS 照常可用', rCss.pass, true);

    // 壞語法要講明是語法錯誤，而不是「找不到」
    const rBad = await runSteps([{ action: 'read_block', selector: 'tr:has(', as: 'b' }], blockCtx);
    eq('真瀏覽器：壞語法講清楚是語法錯誤',
      rBad.pass === false && /語法錯誤/.test(rBad.criticalFails.join('')), true);

    // 命中多筆要擋下來（單一目標）
    const rMany = await runSteps([{ action: 'read_block', selector: 'button', as: 'x' }], blockCtx);
    eq('真瀏覽器：命中多筆被擋下來',
      rMany.pass === false && /定位必須唯一/.test(rMany.criticalFails.join('')), true);

    // 零命中要跟「多筆」分開講
    const rNone = await runSteps([{ action: 'read_block', selector: '.does-not-exist', as: 'n' }], blockCtx);
    eq('真瀏覽器：零命中說的是「找不到」',
      rNone.pass === false && /找不到/.test(rNone.criticalFails.join('')), true);

    await realPage.close();
  }

  // ── (g) 隱藏的 Element UI 勾選框 ────────────────────────────
  //
  // 使用者 2026-09-17 回報：第 28 步 `setChecked` 等到 30 秒逾時，
  // 預檢寫「命中 1 個·不可見·位置 (-214, 428)，0 × 0」。
  // Element UI 把真正的 input 藏起來，看得見的是 `.el-checkbox__inner`。
  console.log('\n── 隱藏的勾選框 ──');
  {
    const EL_CSS = `<style>
      .el-checkbox__original{opacity:0;position:absolute;margin:0;width:0;height:0;z-index:-1}
      .el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #999}
    </style>`;
    const cb = (id, attrs = '') => `<label class="el-checkbox" data-k="${id}"><span class="el-checkbox__input">
      <span class="el-checkbox__inner"></span><input type="checkbox" class="el-checkbox__original" ${attrs}>
    </span></label>`;

    const pg = await browser.newPage();
    await pg.setContent(`${EL_CSS}
      ${cb('plainoff')}
      ${cb('plainon', 'checked')}
      ${cb('dis', 'disabled')}
      <div data-k="bare"><input type="checkbox" class="el-checkbox__original"></div>
      <div data-k="naked"><input type="checkbox" id="n1"><label for="n1">看得見的</label></div>`);
    const input = (k) => pg.locator(`[data-k="${k}"] input`);

    // ① 勾選：原本會 30 秒逾時，現在要真的勾起來
    const r1 = await setCheckedRecorded(input('plainoff'), true, { timeout: 1500 });
    eq('隱藏框：勾選成功', r1.ok, true);
    eq('隱藏框：原 input 真的被勾了', await input('plainoff').isChecked(), true);

    // ② 取消勾選
    const r2 = await setCheckedRecorded(input('plainon'), false, { timeout: 1500 });
    eq('隱藏框：取消勾選成功', r2.ok, true);
    eq('隱藏框：原 input 真的被取消了', await input('plainon').isChecked(), false);

    // ③ 已經符合就不碰——亂點會把它反向取消
    const before = await input('plainoff').isChecked();
    const r3 = await setCheckedRecorded(input('plainoff'), true, { timeout: 1500 });
    eq('已符合：不重複點', r3.ok && /不重複點/.test(r3.note || ''), true);
    eq('已符合：狀態沒被反向改掉', await input('plainoff').isChecked(), before);

    // ④ disabled 要明講，不要等到逾時
    const r4 = await setCheckedRecorded(input('dis'), true, { timeout: 1500 });
    eq('disabled：失敗且說得出是 disabled', r4.ok === false && /disabled/.test(r4.problem || ''), true);

    // ⑤ 隱藏、但找不到明確關聯的可點元素 → 不猜，要說清楚
    const r5 = await setCheckedRecorded(input('bare'), true, { timeout: 1200 });
    eq('沒代理：不猜、說明原因', r5.ok === false && /找不到明確關聯/.test(r5.problem || ''), true);

    // ⑥ 普通的 label[for] 也要能走
    const r6 = await setCheckedRecorded(input('naked'), true, { timeout: 1500 });
    eq('label[for]：也能勾到', r6.ok && await input('naked').isChecked(), true);

    // ⑦ 代理歧義：同一個 el-checkbox 裡有兩個 inner → 不猜
    await pg.setContent(`${EL_CSS}<label class="el-checkbox" data-k="amb"><span class="el-checkbox__input">
      <span class="el-checkbox__inner"></span><span class="el-checkbox__inner"></span>
      <input type="checkbox" class="el-checkbox__original">
    </span></label>`);
    const amb = await hiddenToggleProxy(pg.locator('[data-k="amb"] input'));
    // 兩個 inner → inner 這條不成立；退到祖先 label 仍然是唯一的，那是合法的代理
    eq('代理歧義：inner 不唯一時不拿它', amb.kind === 'el-checkbox__inner', false);

    // ⑦b 點了代理、但狀態沒變——**不能當成成功**。
    //     點得到不代表改得到；沒這條的話，畫面沒勾起來卻報經過。
    await pg.setContent(`${EL_CSS}<label class="el-checkbox" data-k="dead" onclick="event.preventDefault()">
      <span class="el-checkbox__input">
        <span class="el-checkbox__inner"></span><input type="checkbox" class="el-checkbox__original">
      </span></label>`);
    const r7b = await setCheckedRecorded(pg.locator('[data-k="dead"] input'), true, { timeout: 1500 });
    eq('點了代理但狀態沒變：要報錯不能當成功',
      r7b.ok === false && /沒有變成預期/.test(r7b.problem || ''), true);

    // ⑧ 延遲出現：不可見不能一律當成失敗，Playwright 本來就會等
    await pg.setContent('<div id="late"></div>');
    await pg.evaluate(() => setTimeout(() => {
      document.getElementById('late').innerHTML = '<input type="checkbox" id="l1">';
    }, 250));
    const r8 = await setCheckedRecorded(pg.locator('#l1'), true, { timeout: 3000 });
    eq('延遲出現：等到了就正常成功', r8.ok, true);

    await pg.close();
  }

  // ── (h) 實際錄製 → 重播：隱藏勾選框走完整積木入口 ────────────
  //
  // 前面那一組是直接呼叫 setCheckedRecorded()；這一組走**錄製器實際產出的選擇器**
  // 加上積木引擎的 set_checked，確認整條路徑都通。
  console.log('\n── 錄製→重播：隱藏勾選框 ──');
  {
    const EL_CSS = '<style>.el-checkbox__original{opacity:0;position:absolute;margin:0;width:0;height:0;z-index:-1}'
      + '.el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #999}</style>';
    const ROW = EL_CSS + `<table><tbody><tr>
      <td><div class="cell"><label class="el-checkbox"><span class="el-checkbox__input">
        <span class="el-checkbox__inner"></span><input type="checkbox" class="el-checkbox__original">
      </span></label></div></td>
      <td><div class="cell">4186-JJBX-0001</div></td>
    </tr></tbody></table>`;

    // 真的錄一次：點那個看得見的方框
    const ctx4 = await browser.newContext();
    await ctx4.addInitScript(backendRecorderScript());
    const rec4 = await ctx4.newPage();
    const evts4 = [];
    rec4.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) evts4.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    await rec4.goto('data:text/html,' + encodeURIComponent(ROW));
    await rec4.evaluate(() => window.__toppathArmRecorder?.());
    await rec4.waitForTimeout(150);
    await rec4.click('.el-checkbox__inner');
    await rec4.waitForTimeout(150);
    await ctx4.close();

    // 重播：用錄製產的選擇器指到原生 input（錄製端保留 input + 目標狀態，
    // 不改成錄可見 span 的 click——否則重跑可能反向取消勾選）
    const play = await browser.newPage();
    await play.setContent(ROW);
    const blockCtx4 = {
      page: play,
      openPath: async () => {},
      resolveSubtypePath: () => null,
      takeScreenshot: async () => null,
      callBuiltin: async () => ({ notes: '', criticalFails: [], manual: false }),
    };
    const sel = 'tr:has(:text-is("4186-JJBX-0001")) > td:nth-of-type(1) input';
    const r = await runSteps([{ action: 'set_checked', selector: sel, checked: true }], blockCtx4);
    eq('重播：set_checked 積木通過', r.pass, true);
    eq('重播：原 input 真的被勾了', await play.locator(sel).isChecked(), true);

    // 再跑一次同樣的步驟：**不可以被反向取消**
    const again = await runSteps([{ action: 'set_checked', selector: sel, checked: true }], blockCtx4);
    eq('重播：再跑一次不會反向取消', again.pass && await play.locator(sel).isChecked(), true);
    await play.close();
  }

  // ── (i) 一次點擊不得錄成兩顆積木（v4.158.1）────────────────
  //
  // Element UI 的勾選框：使用者點看得見的 span，那一下會觸發藏起來那個 input 的
  // change——於是同一個動作會被錄成 click + set_checked 兩顆。
  //
  // 使用者 2026-09-17 就是卡在那顆多餘的 click（舊錄製器的 span:nth-of-type(2)，命中 0），
  // 而後面那顆 set_checked 其實就能完成工作。（CodeX 上一輪點名要查這件事）
  //
  // ⚠️ 只能排除「裝飾層」。label 裡的真按鈕、沒有勾選框的 label 都不能被誤殺——
  //    所以這裡兩種正向案例跟去重案例一樣重要。
  console.log('\n── 一次點擊只錄一顆 ──');
  {
    const CSS = '<style>.el-checkbox__original{opacity:0;position:absolute;width:0;height:0}'
      + '.el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #999}</style>';
    const PAGE = CSS + '<table><tbody><tr>'
      + '<td><div class="cell"><label class="el-checkbox"><span class="el-checkbox__input">'
      + '<span class="el-checkbox__inner"></span><input type="checkbox" class="el-checkbox__original">'
      + '</span></label></div></td>'
      + '<td><div class="cell">4186-DFDC-9999</div></td></tr></tbody></table>'
      + '<label class="el-checkbox" id="withbtn"><span class="deco"></span>'
      + '<input type="checkbox" class="el-checkbox__original"><button id="inner-btn">按鈕</button></label>'
      + '<label id="plainlabel"><span id="plainspan">沒有勾選框的 label</span></label>';

    const recordOne = async (clickSel) => {
      const c = await browser.newContext();
      await c.addInitScript(backendRecorderScript());
      const pg = await c.newPage();
      const got = [];
      pg.on('console', m => {
        const t = m.text();
        if (t.startsWith(RECORDER_MARKER)) got.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
      });
      await pg.goto('data:text/html,' + encodeURIComponent(PAGE));
      await pg.evaluate(() => window.__toppathArmRecorder?.());
      await pg.waitForTimeout(150);
      await pg.click(clickSel);
      await pg.waitForTimeout(250);
      await c.close();
      return got.map(e => e.action);
    };

    eq('點勾選框的可見方框 → 只有 set_checked', await recordOne('.el-checkbox__inner'), ['set_checked']);
    // 正向案例：不能因為去重而把 label 裡的真按鈕一起吞掉
    eq('label 裡的真按鈕 → 照常錄 click', await recordOne('#inner-btn'), ['click']);
    eq('沒勾選框的 label → 照常錄 click', await recordOne('#plainspan'), ['click']);
  }

  // ── (j) Element UI 表單：label 跟 input 沒有關聯（v4.159.0）────────
  //
  // 使用者 2026-09-17：二級彈窗的 Jackpot ID 下拉選單，第 20 步 `label=Jackpot ID`
  // 命中 0。Element UI 的 .el-form-item__label **沒 for、也沒包住 input**，
  // 而 Playwright 的 getByLabel 靠的是真正的關聯——錄製器推得出文字，不代表它找得到。
  console.log('\n── Element UI 表單的 label ──');
  {
    const FORM = '<div class="el-form-item"><label class="el-form-item__label">Jackpot ID</label>'
      + '<div class="el-form-item__content"><input class="a" value="4186-dfdc1"></div></div>'
      + '<div class="el-form-item"><label class="el-form-item__label">Min Bet</label>'
      + '<div class="el-form-item__content"><input class="b" value="100"></div></div>';

    const pg = await browser.newPage();
    await pg.setContent(FORM);

    // 先釘住根因：舊式的 label= 在這種表單上本來就是 0
    eq('根因：getByLabel 在 el-form-item 上命中 0',
      await pg.getByLabel('Jackpot ID', { exact: true }).count(), 0);

    // 執行時相容：舊腳本的 label= 要被接住
    const legacy = await locateRecorded(pg, 'label=Jackpot ID', { requireUnique: true });
    eq('舊腳本的 label= 要被相容到', legacy.count, 1);
    eq('而且拿到的是對的那一格', await legacy.locator.inputValue(), '4186-dfdc1');
    const legacy2 = await locateRecorded(pg, 'label=Min Bet', { requireUnique: true });
    eq('另一格也各自對得上', await legacy2.locator.inputValue(), '100');

    // 找不到的欄位不能亂猜
    const nope = await locateRecorded(pg, 'label=根本沒這個欄位', { requireUnique: true });
    eq('沒這個欄位就是 0，不亂猜', nope.count, 0);

    // ⚠️ 上面那幾條直接呼叫 locateRecorded()——**那不是產品跑的路徑**。
    //    實際執行是走 createRecordedLocators() 的預檢與點擊，而它曾經自己留了
    //    一份解析拷貝，所以 label= 的相容加進去也沒用——使用者那邊依然命中 0。
    //    （而這些直接呼叫的斷言全程是綠的。這是今天第八次同型問題。）
    //    所以這裡必須額外走一次**產品入口**。
    const viaFactory = createRecordedLocators(pg, { requireUnique: true });
    // 沒相容到時這裡會拋「定位必須唯一（命中 0 個）」——接住它，
    // 讓它變成一條紅的斷言而不是整支中斷，否則後面的項目都不會跑到。
    const pre = await viaFactory.checkLocator({ selector: 'label=Jackpot ID' }).catch(e => ({ error: String(e.message) }));
    eq('預檢（產品入口）也要相容到', pre?.count, 1);
    eq('預檢會把原文與有效的都留下來', pre?.original, 'label=Jackpot ID');
    const viaClick = await viaFactory.recordedLocator('label=Jackpot ID').catch(() => null);
    eq('點擊（產品入口）拿到的也是對的那一格',
      viaClick ? await viaClick.inputValue() : '(定位失敗)', '4186-dfdc1');

    // 再走一次積木引擎，確認整條路徑都通
    const blockCtx5 = {
      page: pg,
      openPath: async () => {},
      resolveSubtypePath: () => null,
      takeScreenshot: async () => null,
      callBuiltin: async () => ({ notes: '', criticalFails: [], manual: false }),
    };
    const rb = await runSteps([{ action: 'read_block', selector: 'label=Jackpot ID', as: 'jp' }], blockCtx5);
    eq('積木引擎走 label= 也通', rb.pass, true);
    await pg.close();

    // 純字串層：只認 label=，別的不碰
    eq('只處理 label= 開頭的', legacyLabelVariant('text=X'), []);

    // 錄製端：現在不再產 label=，而是範圍選擇器
    const c = await browser.newContext();
    await c.addInitScript(backendRecorderScript());
    const rec = await c.newPage();
    const got = [];
    rec.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) got.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    await rec.goto('data:text/html,' + encodeURIComponent(FORM));
    await rec.evaluate(() => window.__toppathArmRecorder?.());
    await rec.waitForTimeout(150);
    await rec.click('.a');
    await rec.waitForTimeout(150);
    const step = got.at(-1);
    eq('錄製端不再產 label=', String(step.selector).startsWith('label='), false);
    eq('改產 form item 範圍選擇器', step.selectorStrategy, 'formItem');
    eq('而且當場就唯一命中', await rec.locator(step.selector).count(), 1);
    await c.close();
  }

  // ── (k) 錄製器不得使用瀏覽器原生對話框（v4.159.0）──────────
  //
  // 使用者 2026-09-17：「標記功能只有第一個有用」。實測發現壞掉的四個選項
  // 剛好就是會跳輸入框的那四個——錄製的瀏覽器是 Playwright 控制的，
  // 沒註冊 dialog handler 時 alert/prompt 會被**自動關掉**，prompt() 立刻回 null。
  console.log('\n── 不得使用原生對話框 ──');
  {
    // 先釘住「為什麼不能用」：沒有 handler 時 prompt 就是 null
    const probe = await browser.newPage();
    await probe.setContent('<div>x</div>');
    eq('根因：沒 dialog handler 時 prompt() 直接回 null',
      await probe.evaluate(() => prompt('x', 'y')), null);
    await probe.close();

    // 所以注入腳本裡不得再出現原生對話框
    const injected = stripSrc(backendRecorderScript());
    eq('注入腳本裡沒有 prompt/alert/confirm',
      /(^|[^.\w])(alert|prompt|confirm)\s*\(/.test(injected), false);

    // 行為：需要輸入的選項現在真的會寫入
    const c = await browser.newContext();
    await c.addInitScript(backendRecorderScript());
    const rec = await c.newPage();
    const got = [];
    rec.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) got.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    // ⚠️ 刻意不註冊 dialog handler，跟真實的錄製環境一致
    await rec.goto('data:text/html,' + encodeURIComponent('<input class="a" value="123">'));
    await rec.evaluate(() => window.__toppathArmRecorder?.());
    await rec.waitForTimeout(150);

    const pickOption = async (idx) => {
      const before = got.length;
      await rec.click('.a', { modifiers: ['Alt'] });
      await rec.waitForTimeout(180);
      await rec.evaluate((i) => {
        const m = [...document.querySelectorAll('[data-toppath-recorder-ui]')]
          .find(el => (el.textContent || '').includes('要檢查這個元素的什麼'));
        m?.querySelectorAll('button')[i]?.click();
      }, idx);
      await rec.waitForTimeout(150);
      // 要輸入的選項會換成輸入面板，填完按確定
      const hasInput = await rec.evaluate(() => {
        const m = [...document.querySelectorAll('[data-toppath-recorder-ui]')].find(el => el.querySelector('input'));
        if (!m) return false;
        m.querySelector('input').value = '我填的值';
        [...m.querySelectorAll('button')].find(b => b.textContent === '確定')?.click();
        return true;
      });
      await rec.waitForTimeout(200);
      return { added: got.slice(before), hasInput };
    };

    const r2 = await pickOption(1);   // 等於某個數字
    eq('「等於某個數字」改成選單內輸入', r2.hasInput, true);
    eq('「等於某個數字」真的寫入了', r2.added.map(e => e.assertion?.kind), ['equals']);
    eq('而且用的是我填的值', r2.added[0]?.assertion?.expect, '我填的值');

    const r7 = await pickOption(6);   // 這裡要人工看
    eq('「這裡要人工看」也寫得入', r7.added.map(e => e.assertion?.kind), ['manual']);
    await c.close();
  }

  // ── (l) 下拉選項跟表格欄位撞名（v4.160.0）─────────────────
  //
  // 使用者 2026-09-17：第 21 步 `text=4186-dfdc1` **命中 8 個**——因為表格的
  // Jackpot Model 欄也一堆同名。選項面板是掛在 <body> 底下的獨立元素，不在彈窗裡。
  //
  // ⚠️ 強制唯一之前，這種情況會 `.first()` 點到**表格儲存格**——下拉完全沒選到，
  //    而且不會報錯，最後按 Sure 送出一個空的值。這次能看到紅字就是進步。
  console.log('\n── 下拉選項與表格撞名 ──');
  {
    const CELL = (t) => '<td><div class="cell">' + t + '</div></td>';
    const rows = ['4186-dfdc1', '4186-dfdc1', '4186-dfdc2', '4186-dfdc1']
      .map((m, i) => '<tr>' + CELL('M-' + i) + CELL(m) + '</tr>').join('');
    const PAGE = '<table><tbody>' + rows + '</tbody></table>'
      + '<div class="el-select-dropdown el-popper"><ul class="el-select-dropdown__list">'
      + '<li class="el-select-dropdown__item selected"><span>4186-dfdc1</span></li>'
      + '<li class="el-select-dropdown__item"><span>4186-dfdc2</span></li>'
      + '</ul></div>';

    const pg = await browser.newPage();
    await pg.setContent(PAGE);

    // 先釘住根因
    eq('根因：text= 會跟表格欄位撞名',
      await pg.getByText('4186-dfdc1', { exact: true }).count() > 1, true);

    // 走產品入口：預檢與點擊都要收斂到打開著的面板
    const { recordedLocator, checkLocator } = createRecordedLocators(pg, { requireUnique: true });
    const pre = await checkLocator({ selector: 'text=4186-dfdc1' }).catch(e => ({ error: String(e.message) }));
    eq('預檢（產品入口）收斂到唯一', pre?.count, 1);
    const picked = await recordedLocator('text=4186-dfdc1').catch(() => null);
    eq('點到的是下拉選項，不是表格儲存格',
      picked ? (await picked.evaluate(n => n.className)).includes('el-select-dropdown__item') : false, true);

    // 面板裡就有兩個同名選項（使用者實際遇到：Jackpot 清單里 4186-dfdc1 出現兩次）
    // ——這是**資料本身的歧義**，猜哪一個都可能設錯。不猜，但要把原因跟出路講出來；
    //    只丟一句「命中 11 個」等於讓人自己去猜。
    {
      const dupPage = await browser.newPage();
      await dupPage.setContent(PAGE.replace(
        '<li class="el-select-dropdown__item"><span>4186-dfdc2</span></li>',
        '<li class="el-select-dropdown__item"><span>4186-dfdc2</span></li>'
        + '<li class="el-select-dropdown__item"><span>4186-dfdc1</span></li>'));
      const f = createRecordedLocators(dupPage, { requireUnique: true });
      const dup = await f.checkLocator({ selector: 'text=4186-dfdc1' }).catch(e => ({ error: String(e.message) }));
      eq('面板裡同名選項不止一個時不猜', /定位必須唯一/.test(dup?.error || ''), true);
      eq('而且要說出是面板裡同名、並給出路',
        /同名選項/.test(dup?.error || '') && /nth=0/.test(dup?.error || ''), true);
      // 給的路要真的走得通
      const nth0 = '.el-select-dropdown:visible .el-select-dropdown__item:has(:text-is("4186-dfdc1")) >> nth=0';
      eq('給的 nth=0 真的可以用', await dupPage.locator(nth0).count(), 1);
      await dupPage.close();
    }

    // ⚠️ 面板全關著時絕對不能亂選——宁可報錯
    await pg.evaluate(() => document.querySelectorAll('.el-select-dropdown').forEach(d => { d.style.display = 'none' }));
    const closed = await checkLocator({ selector: 'text=4186-dfdc1' }).catch(e => ({ error: String(e.message) }));
    eq('下拉沒開著時不收斂、照常報歧義', /定位必須唯一/.test(closed?.error || ''), true);
    await pg.close();

    // 錄製端：現在直接產限定面板的選擇器
    const c = await browser.newContext();
    await c.addInitScript(backendRecorderScript());
    const rec = await c.newPage();
    const got = [];
    rec.on('console', m => {
      const t = m.text();
      if (t.startsWith(RECORDER_MARKER)) got.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
    });
    await rec.goto('data:text/html,' + encodeURIComponent(PAGE));
    await rec.evaluate(() => window.__toppathArmRecorder?.());
    await rec.waitForTimeout(150);
    await rec.click('.el-select-dropdown__item.selected');
    await rec.waitForTimeout(150);
    const st = got.at(-1);
    eq('錄製端認得出是下拉選項', st.selectorStrategy, 'dropdownOption');
    eq('而且當場就唯一命中', await rec.locator(st.selector).count(), 1);
    eq('不再產跟表格撞名的 text=', String(st.selector).startsWith('text='), false);
    await c.close();
  }

  // ── (m) 關著的彈窗還在 DOM 裡，同名按鈕是常態（v4.160.1）─────
  //
  // 使用者 2026-09-17：第 24 步 `text=Sure` **命中 2 個**。後台有好幾顆
  // Batch Set…，每一顆都有自己的彈窗，而 Element UI 把關著的彈窗留在 DOM 裡。
  //
  // ⚠️ 這是我在 v4.157.0 改強制唯一時弄壞的：舊的非唯一路徑會優先取可見的那一個，
  //    我把那段一併拿掉。補回來但收緊：**剛好一個可見才用**。
  console.log('\n── 關著的彈窗造成的同名按鈕 ──');
  {
    const dialog = (hidden) => '<div class="el-dialog__wrapper"' + (hidden ? ' style="display:none"' : '') + '>'
      + '<div class="el-dialog"><button class="el-button"><span>Cancel</span></button>'
      + '<button class="el-button el-button--primary"><span>Sure</span></button></div></div>';

    // ① 兩顆同名、只有一顆看得見 → 用看得見的那一顆
    const pg = await browser.newPage();
    await pg.setContent(dialog(true) + dialog(false));
    eq('根因：text=Sure 本來就命中多筆', await pg.getByText('Sure', { exact: true }).count(), 2);
    const { recordedLocator, checkLocator } = createRecordedLocators(pg, { requireUnique: true });
    const pre = await checkLocator({ selector: 'text=Sure' }).catch(e => ({ error: String(e.message) }));
    eq('預檢（產品入口）收斂到看得見的那一個', pre?.count, 1);
    eq('而且它真的是可見的', pre?.visible, true);
    const btn = await recordedLocator('text=Sure').catch(() => null);
    eq('點擊拿到的也是可見的那一顆', btn ? await btn.isVisible() : false, true);
    await pg.close();

    // ② 兩顆都看得見 → 真歧義，照常報錯（不能因為收斂而變成亂猜）
    const both = await browser.newPage();
    await both.setContent(dialog(false) + dialog(false));
    const f2 = createRecordedLocators(both, { requireUnique: true });
    const amb = await f2.checkLocator({ selector: 'text=Sure' }).catch(e => ({ error: String(e.message) }));
    eq('兩顆都看得見時照常報歧義', /定位必須唯一/.test(amb?.error || ''), true);
    await both.close();

    // ③ 一個都不可見時**不能收斂**——Element UI 的勾選框本來就是隱藏的，
    //    收斂會把它變成 0 個，把已經修好的勾選又弄壞。
    const hidden = await browser.newPage();
    await hidden.setContent('<style>.el-checkbox__original{opacity:0;position:absolute;width:0;height:0}</style>'
      + '<label class="el-checkbox"><input type="checkbox" class="el-checkbox__original"></label>');
    const f3 = createRecordedLocators(hidden, { requireUnique: true });
    const one = await f3.recordedLocator('input.el-checkbox__original').catch(() => null);
    eq('隱藏的勾選框不受影響（仍然拿得到）', one !== null, true);
    await hidden.close();
  }

  // ── (n) CodeX 2026-09-17 第二輪 review 點名的五項（v4.161.0）───────
  console.log('\n── CodeX 第二輪點名的五項 ──');
  {
    // ① [P1] 收斂後不能回 .nth()——定位完第二顆才變可見也要被擋
    {
      const pg = await browser.newPage();
      await pg.setContent('<button class="s" style="display:none">Sure</button><button class="s">Sure</button>');
      const { recordedLocator } = createRecordedLocators(pg, { requireUnique: true });
      const btn = await recordedLocator('text=Sure');
      eq('① 收斂當下是唯一的', await btn.count(), 1);
      // 定位之後第二顆才變可見
      await pg.evaluate(() => { document.querySelector('.s').style.display = '' });
      eq('① 第二顆變可見後，回的集合跟著變成 2', await btn.count(), 2);
      let err = '';
      try { await btn.click({ timeout: 800 }) } catch (e) { err = String(e.message) }
      eq('① 所以動作當下被 strict 擋下來', isAmbiguityError(err), true);
      await pg.close();
    }

    // ② [P1] 一個隱藏的下拉選項 + 一個可見的同名儲存格 → 不得收斂到儲存格
    {
      const pg = await browser.newPage();
      await pg.setContent('<table><tbody><tr><td><div class="cell">4186-dfdc1</div></td></tr></tbody></table>'
        + '<div class="el-select-dropdown" style="display:none"><ul class="el-select-dropdown__list">'
        + '<li class="el-select-dropdown__item"><span>4186-dfdc1</span></li></ul></div>');
      const f = createRecordedLocators(pg, { requireUnique: true });
      const r = await f.checkLocator({ selector: 'text=4186-dfdc1' }).catch(e => ({ error: String(e.message) }));
      eq('② 下拉關著時不得收斂到表格儲存格',
        /定位必須唯一/.test(r?.error || ''), true);
      await pg.close();
    }

    // ③ [P2] label 帶冒號時，錄製當下不得產出零命中
    {
      const FORM = '<div class="el-form-item"><label class="el-form-item__label">Min Bet:</label>'
        + '<div class="el-form-item__content"><input class="a"></div></div>';
      const c = await browser.newContext();
      await c.addInitScript(backendRecorderScript());
      const rec = await c.newPage();
      const got = [];
      rec.on('console', m => {
        const t = m.text();
        if (t.startsWith(RECORDER_MARKER)) got.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
      });
      await rec.goto('data:text/html,' + encodeURIComponent(FORM));
      await rec.evaluate(() => window.__toppathArmRecorder?.());
      await rec.waitForTimeout(150);
      await rec.click('.a');
      await rec.waitForTimeout(150);
      const st = got.at(-1);
      eq('③ label 帶冒號時錄製當下就命中 1', await rec.locator(st.selector).count(), 1);
      await c.close();

      // 舊腳本的 label=Min Bet（沒冒號）也要相容到
      const play = await browser.newPage();
      await play.setContent(FORM);
      const f = createRecordedLocators(play, { requireUnique: true });
      const r = await f.checkLocator({ selector: 'label=Min Bet' }).catch(e => ({ error: String(e.message) }));
      eq('③ 舊腳本 label=Min Bet 也相容得到', r?.count, 1);
      await play.close();
    }

    // ④ [P2] 已在 DOM 裡、稍後才顯示的勾選框要等
    {
      const pg = await browser.newPage();
      await pg.setContent('<style>.hide{display:none}</style>'
        + '<label class="el-checkbox hide" id="lb"><span class="el-checkbox__inner"></span>'
        + '<input type="checkbox" class="el-checkbox__original"></label>');
      await pg.evaluate(() => setTimeout(() => document.getElementById('lb').classList.remove('hide'), 300));
      const r = await setCheckedRecorded(pg.locator('#lb input'), true, { timeout: 3000 });
      eq('④ 暫時隱藏的勾選框會等到它出現', r.ok, true);
      eq('④ 而且真的勾上了', await pg.locator('#lb input').isChecked(), true);
      await pg.close();
    }

    // ⑤ 即時驗證不得自己 page.locator()——label= 會拋 Unknown engine
    {
      const pg = await browser.newPage();
      await pg.setContent('<div class="el-form-item"><label class="el-form-item__label">Min Bet</label>'
        + '<div class="el-form-item__content"><input id="mb" data-toppath-rec-target="v1"></div></div>');
      const r = await verifyRecordedSelectorLive(pg, {
        verifyId: 'v1', selector: 'label=Min Bet', recordedUrl: pg.url(),
      });
      eq('⑤ label= 的即時驗證不會變成語法錯誤', r?.status === 'invalid', false);
      eq('⑤ 而且認得出就是剛才那一個', r?.status, 'ok');
      await pg.close();
    }
  }

  // ── (o) CodeX 第三輪：相容候選要聯集、期限要共用、解析只能一支 ──
  console.log('\n── CodeX 第三輪 ──');
  {
    // ① [P1] 兩個欄位分別是 `Min Bet:` 與 `Min Bet：` → 是歧義，不能選第一個
    {
      const pg = await browser.newPage();
      await pg.setContent(
        '<div class="el-form-item"><label class="el-form-item__label">Min Bet:</label>'
        + '<div class="el-form-item__content"><input class="a"></div></div>'
        + '<div class="el-form-item"><label class="el-form-item__label">Min Bet：</label>'
        + '<div class="el-form-item__content"><input class="b"></div></div>');
      const f = createRecordedLocators(pg, { requireUnique: true });
      const r = await f.checkLocator({ selector: 'label=Min Bet' }).catch(e => ({ error: String(e.message) }));
      eq('① 半形、全形冒號各一個欄位 → 算歧義，不選第一個',
        /定位必須唯一/.test(r?.error || ''), true);
      // 計數那一支也不能把歧義吞掉
      const c = await countRecorded(pg, 'label=Min Bet');
      eq('① countRecorded 也要看到 2', c.count, 2);
      await pg.close();
    }

    // ①b 只有一個時照常相容（不能因為改聯集就把正常情況弄壞）
    {
      const pg = await browser.newPage();
      await pg.setContent('<div class="el-form-item"><label class="el-form-item__label">Min Bet:</label>'
        + '<div class="el-form-item__content"><input class="a"></div></div>');
      const f = createRecordedLocators(pg, { requireUnique: true });
      const r = await f.checkLocator({ selector: 'label=Min Bet' }).catch(e => ({ error: String(e.message) }));
      eq('①b 只有一個時仍然相容得到', r?.count, 1);
      await pg.close();
    }

    // ② [P2] 等待與點擊共用期限：永遠不會出現的代理不得拖到兩個 timeout
    {
      const pg = await browser.newPage();
      await pg.setContent('<style>.el-checkbox__original{opacity:0;position:absolute;width:0;height:0}</style>'
        + '<div><input type="checkbox" class="el-checkbox__original"></div>');   // 沒有任何代理
      const t0 = Date.now();
      const r = await setCheckedRecorded(pg.locator('input'), true, { timeout: 1200 });
      const spent = Date.now() - t0;
      eq('② 找不到代理最後仍然失敗', r.ok, false);
      eq('② 而且沒有拖到兩個期限（<1.8 倍）', spent < 1200 * 1.8, true);
      await pg.close();
    }

    // ②b 真正會加倍的情境：**等了一段才出現代理，而且接著點不到**。
    //    上面那一組根本沒走到 click（永遠沒代理），所以注入「點擊重拿完整 timeout」
    //    不會轉紅——這是我第一版漏掉的那一半。
    {
      const pg = await browser.newPage();
      await pg.setContent('<style>.el-checkbox__original{opacity:0;position:absolute;width:0;height:0}'
        + '.el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #999}'
        + '#mask{position:fixed;inset:0;z-index:9999}.late{display:none}</style>'
        + '<label class="el-checkbox late" id="lb"><span class="el-checkbox__inner"></span>'
        + '<input type="checkbox" class="el-checkbox__original"></label>'
        + '<div id="mask"></div>');
      // 600ms 後代理才出現；但遮罩一直在，所以接著的 click 一定逾時
      await pg.evaluate(() => setTimeout(() => document.getElementById('lb').classList.remove('late'), 600));
      const t0 = Date.now();
      const r = await setCheckedRecorded(pg.locator('#lb input'), true, { timeout: 1500 });
      const spent = Date.now() - t0;
      eq('②b 遮罩擋住時仍然失敗', r.ok, false);
      // 實測：共用期限 ~1528ms，點擊重拿完整 timeout ~2175ms。門檻拉到兩者中間。
      eq('②b 等待與點擊共用期限（不得接近兩倍）', spent < 1500 * 1.25, true);
      await pg.close();
    }

    // ③ 解析只能一支：共用模組裡不得有第二處自己 parse text=/label=
    {
      const selSrc = stripSrc(readFileSync(new URL('../../server/uat-runner/recorded-selector.js', import.meta.url), 'utf8'));
      const parses = (selSrc.match(/getByText\(|getByLabel\(/g) || []).length;
      // resolveToSet 裡各一次，就是全部
      eq('③ 全檔只在一處認 text=/label=', parses, 2);
    }
  }

  // ── (q) CodeX 第四輪：相容不得吞掉原式的歧義、期限不得被延長 ──
  console.log('\n── CodeX 第四輪 ──');
  {
    // ① [P1] 兩個**原生關聯**的 Min Bet（原式命中 2），另外還有一個舊式 Element UI 欄位。
    //    相容不得跳過原本的歧義去選第三個。
    {
      const pg = await browser.newPage();
      await pg.setContent(
        '<label for="m1">Min Bet</label><input id="m1">'
        + '<label for="m2">Min Bet</label><input id="m2">'
        + '<div class="el-form-item"><label class="el-form-item__label">Min Bet</label>'
        + '<div class="el-form-item__content"><input id="m3"></div></div>');
      eq('① 原式（真關聯）本來就命中 2',
        await pg.getByLabel('Min Bet', { exact: true }).count(), 2);
      const f = createRecordedLocators(pg, { requireUnique: true });
      const r = await f.checkLocator({ selector: 'label=Min Bet' }).catch(e => ({ error: String(e.message) }));
      eq('① 相容不得吞掉原式的歧義', /定位必須唯一/.test(r?.error || ''), true);
      const c = await countRecorded(pg, 'label=Min Bet');
      eq('① countRecorded 也不得回 1', c.count, 2);
      await pg.close();
    }

    // ② [P2] 代理接近期限才出現——不得再白給 500ms
    {
      const pg = await browser.newPage();
      await pg.setContent('<style>.el-checkbox__original{opacity:0;position:absolute;width:0;height:0}'
        + '.el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #999}'
        + '#mask{position:fixed;inset:0;z-index:9999}.late{display:none}</style>'
        + '<label class="el-checkbox late" id="lb"><span class="el-checkbox__inner"></span>'
        + '<input type="checkbox" class="el-checkbox__original"></label><div id="mask"></div>');
      // 快到期限（900/1000）才出現，而且遮罩讓它點不到
      await pg.evaluate(() => setTimeout(() => document.getElementById('lb').classList.remove('late'), 900));
      const t0 = Date.now();
      const r = await setCheckedRecorded(pg.locator('#lb input'), true, { timeout: 1000 });
      const spent = Date.now() - t0;
      eq('② 接近期限才出現：仍然失敗', r.ok, false);
      // Math.max(500, …) 版本會變成 ~900 + 500 = 1400；正確版應該接近 1000
      eq('② 且沒有白給額外的 500ms', spent < 1000 * 1.25, true);
      await pg.close();
    }
  }

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
  // 剪掉註解再比，否則寫在註解裡的同名字也算數。
  // ⚠️ 用共用的 stripSrc，不要自己寫正則——純正則會把字串裡的 `/*` 當註解開頭
  //    （見 lib/strip-comments.mjs），而那會讓下面這些**負面斷言假通過**。
  const runnerSrc = stripSrc(readFileSync(new URL('../../server/uat-runner/run-lark-tc-backend.js', import.meta.url), 'utf8'));
  // 定位跟唯一性檢查已經抽到 recorded-selector.js，這裡釘的是「runner 真的用那一支」。
  eq('runner 用共用的定位工廠', runnerSrc.includes('createRecordedLocators(p, {'), true);
  // ⚠️ 「定位必須唯一」這句話只能存在於共用那一支。runner 裡又出現一份，
  //    就代表有人把判斷再複製回去了——兩邊日後一定漂。
  eq('runner 裡沒有自己再寫一份唯一性判斷', runnerSrc.includes('定位必須唯一'), false);

  eq('runner 的點擊走共用流程', runnerSrc.includes('clickRecorded({'), true);
  eq('runner 沒有自己再寫一份 strict mode 正則', runnerSrc.includes('strict mode violation'), false);
  // 座標備援只能存在於共用那一支；runner 裡又出現就是有人複製回去了
  eq('runner 裡沒有自己的座標備援實作', /mouse\.click\(/.test(runnerSrc), false);
  // ⚠️ 定位只能有一條路徑。今天有兩次是「修在沒人走的那一支」，
  //    其中一次是因為 block-engine 自己還留著一份。釘住：不得再出現分身。
  const blockSrc = stripSrc(readFileSync(new URL('../../server/uat-runner/block-engine.js', import.meta.url), 'utf8'));
  eq('block-engine 不得自己解析 text=/label=',
    /getByText|getByLabel|startsWith\('text=|startsWith\('label=/.test(blockSrc), false);
  eq('block-engine 也不得留自己的 recordedLocator',
    /function recordedLocator/.test(blockSrc), false);
  // ⚠️ 這條要驗**產出的腳本**，不是 backend-recorder.js 這個檔案本身。
  //    那支檔案整份是一個 template literal，裡面的 `//` 註解有兩層：
  //    檔案層的註解，與**樣板字串裡、會變成產出腳本一部分**的註解。
  //    原本讀檔案 + 舊的純正則剝註解時，兩層剛好都被抹掉所以是綠的；
  //    換成正確的剝註解（不動字串內容）之後才發現：它比的對象一直是錯的，
  //    而且正是 CodeX 說的「負面斷言在假通過」那一類。
  //    驗產出的腳本同時解決兩件事——比對的是真正的產物，註解也只剩一層。
  const producedScript = stripSrc(backendRecorderScript());
  eq('錄製器不再產出 :nth-match', producedScript.includes(':nth-match('), false);

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
