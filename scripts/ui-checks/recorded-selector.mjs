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
  applySelectorChecks, SELECTOR_CHECK_STATUSES,
} from '../../server/uat-runner/recorded-selector.js';

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
  const bodyOf = (name) => {
    const at = runnerSrc.indexOf(name);
    return at < 0 ? '' : runnerSrc.slice(at, at + 1400);
  };
  eq('recordedLocator 呼叫共用解析', bodyOf('const recordedLocator').includes('resolveRecordedSelector'), true);
  eq('checkLocator 呼叫共用解析', bodyOf('async checkLocator(step)').includes('resolveRecordedSelector'), true);

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
