/**
 * block-engine 的行為測試。用假的 ctx（不開瀏覽器）驗執行器本身的語意——
 * 這裡要守的是「失敗不能變成通過」這條線，那是積木化最容易出事的地方。
 *
 * 跑法：node server/uat-runner/block-engine.test.mjs
 */
import { runSteps, toNumber, numbersEqual, countBucket } from './block-engine.js';
import { verifierRanAssertion } from './verifier-params.js';
import { wildcardToRegExp } from './block-engine.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (extra !== undefined) console.log('        ', JSON.stringify(extra)); }
}

/** 假的 ctx：page.evaluate 直接回預先塞好的資料 */
/**
 * 假的 page。
 *
 * ⚠️ locator() 必須長得像真的 Playwright locator（count / nth / evaluate / elementHandle …）。
 *    積木已經不再把選擇器丟進原生 querySelector，假的 page 若只有 evaluate，
 *    測試驗的就是一個產品已經不走的路徑。
 *
 * 數量規則：`__counts[selector]` 有就用它，否則 pageData 裡有算 1、沒有算 0。
 * 讓測試可以直接造「命中多筆」跟「一個都沒有」。
 */
function makeCtx(pageData = {}, builtin = null) {
  const calls = [];
  const counts = {};
  const texts = {};
  const checked = {};
  const disabled = {};
  const makeLocator = (sel) => {
    const n = sel in counts ? counts[sel] : (sel in pageData ? 1 : 0);
    const self = {
      __sel: sel,
      async count() { return n },
      first() { return self },
      nth() { return self },
      async isVisible() { return n > 0 },
      // 勾選狀態：產品現在會先讀 isChecked（已符合就不點）再確認 isDisabled。
      // 假 page 沒這兩個的話，測試驗的又會是一條產品已經不走的路徑。
      async isChecked() { return Boolean(checked[sel]) },
      async isDisabled() { return Boolean(disabled[sel]) },
      async setChecked(v) { checked[sel] = v; calls.push({ kind: 'setChecked', sel, v }) },
      async innerText() { return String(texts[sel] ?? '') },
      async focus() {},
      async click() {},
      async selectOption(v) { calls.push({ kind: 'selectOption', sel, v }) },
      async boundingBox() { return null },
      async elementHandle() { return n ? { __sel: sel } : null },
      async evaluate() { return sel in texts ? texts[sel] : (sel in pageData ? pageData[sel] : null) },
    };
    return self;
  };
  return {
    calls,
    page: {
      __counts: counts,
      __texts: texts,
      __checked: checked,
      __disabled: disabled,
      url: () => 'https://stub.test/',
      async evaluate(fn, args) {
        calls.push({ kind: 'evaluate', args });
        if (args?.selector in pageData) return pageData[args.selector];
        return null;
      },
      async waitForTimeout() {},
      locator(sel) { return makeLocator(sel) },
      getByText(t) { return makeLocator('text=' + t) },
      getByLabel(t) { return makeLocator('label=' + t) },
    },
    async openPath(p, w) { calls.push({ kind: 'open', p, w }); },
    resolveSubtypePath(sub) { return sub === 'Dashboard' ? '/dashboard' : null; },
    async takeScreenshot(name) { calls.push({ kind: 'shot', name }); return `/tmp/${name}.png`; },
    async callBuiltin(name, options) { calls.push({ kind: 'builtin', name, options }); return builtin ?? { notes: `ran ${name}`, criticalFails: [], manual: false }; },
  };
}

const BLUE = { 'Total Available EGM': '5', 'Total System Connected EGM': '2' };

// ── 1. 正常流程 ────────────────────────────────────────────────────────
{
  const ctx = makeCtx({ '.blue-block': BLUE });
  const r = await runSteps([
    { action: 'open_page', subtype: 'Dashboard' },
    { action: 'read_block', selector: '.blue-block', labels: 'Total Available EGM\nTotal System Connected EGM', as: 'blue' },
    { action: 'assert_filled', from: 'blue' },
    { action: 'screenshot', name: 'tc1' },
  ], ctx);
  check('正常流程 pass', r.pass === true, r);
  check('正常流程沒有 criticalFails', r.criticalFails.length === 0, r.criticalFails);
  check('截圖有被收集', r.allShotPaths.length === 1, r.allShotPaths);
}

// ── 2. onFail: continue 也必須算失敗（CodeX 抓到的 bug）─────────────────
{
  const ctx = makeCtx({ '.blue-block': { 'Total Available EGM': '', 'X': '1' } });
  const r = await runSteps([
    { action: 'read_block', selector: '.blue-block', labels: 'Total Available EGM\nX', as: 'blue' },
    { action: 'assert_filled', from: 'blue', onFail: 'continue' },
    { action: 'screenshot', name: 'after' },
  ], ctx);
  check('continue 失敗仍然算 FAIL', r.pass === false, r);
  check('continue 失敗有進 criticalFails', r.criticalFails.length === 1, r.criticalFails);
  check('continue 失敗後有繼續往下跑', r.allShotPaths.length === 1, r.allShotPaths);
}

// ── 3. onFail: stop 中止後面的步驟 ─────────────────────────────────────
{
  const ctx = makeCtx({ '.blue-block': { 'A': '' } });
  const r = await runSteps([
    { action: 'read_block', selector: '.blue-block', labels: 'A', as: 'blue' },
    { action: 'assert_filled', from: 'blue', onFail: 'stop' },
    { action: 'screenshot', name: 'never' },
  ], ctx);
  check('stop 失敗算 FAIL', r.pass === false, r);
  // 原本是斷言「截圖數 == 0」來證明後面沒跑。收工會自動補一張之後那個間接證據失效，
  // 改成直接看有沒有跑到名為 never 的那顆——比數量更精準，也不會被自動截圖干擾。
  check('stop 之後不再執行', !r.allShotPaths.some(p => p.includes('never')), r.allShotPaths);
  check('  但收工仍自動留下證據', r.allShotPaths.some(p => p.includes('result')), r.allShotPaths);
}

// ── 4. manual 不是失敗 ─────────────────────────────────────────────────
{
  const ctx = makeCtx();
  const r = await runSteps([{ action: 'mark_manual', reason: '需等 5 分鐘觀察' }], ctx);
  // pass 在 runner 的慣例裡是「有沒有硬失敗」，不是最終判定。manual 要回 pass:true
  // 搭配 manual:true，外層才會算成「需人工」；回 false 會被算成失敗。
  check('manual 回 pass:true（外層用 pass+manual 組合判定需人工）', r.pass === true, r);
  check('manual 沒有 criticalFails', r.criticalFails.length === 0, r.criticalFails);
  check('manual 旗標有設', r.manual === true && r.manualReason.includes('5 分鐘'), r);
}

// ── 5. 判定優先序：criticalFails 蓋過 manual ───────────────────────────
{
  const ctx = makeCtx({ '.b': { A: '' } });
  const r = await runSteps([
    { action: 'read_block', selector: '.b', labels: 'A', as: 'v' },
    { action: 'assert_filled', from: 'v', onFail: 'continue' },
    { action: 'mark_manual', reason: '也需人工' },
  ], ctx);
  check('同時有 fail 與 manual 時 pass=false（硬失敗優先）', r.pass === false, r);
  check('同時有 fail 與 manual 時 criticalFails 不為空（FAIL 優先）', r.criticalFails.length > 0, r.criticalFails);
}

// ── 6. 不認得的積木一定失敗，不能靜默跳過 ──────────────────────────────
{
  const r = await runSteps([{ action: 'no_such_block' }], makeCtx());
  check('不認得的積木 → FAIL', r.pass === false && r.criticalFails.length === 1, r);
}

// ── 7. 引用不存在的變數 → criticalFail 且中止 ──────────────────────────
{
  const ctx = makeCtx();
  const r = await runSteps([
    { action: 'assert_filled', from: 'notDefined' },
    { action: 'screenshot', name: 'never' },
  ], ctx);
  check('引用不存在變數 → FAIL', r.pass === false && r.criticalFails.length === 1, r.criticalFails);
  check('引用不存在變數 → 中止', !r.allShotPaths.some(p => p.includes('never')), r.allShotPaths);
}

// ── 8. 變數型別不符要擋下來 ────────────────────────────────────────────
{
  const ctx = makeCtx({ table: [{ n: '3' }, { n: '1' }] });
  const r = await runSteps([
    { action: 'read_table', selector: 'table', as: 'rows' },
    { action: 'assert_filled', from: 'rows' },   // rows 是 tableRows，assert_filled 要 blockFields
  ], ctx);
  check('變數型別不符 → FAIL', r.pass === false, r);
  check('型別不符訊息點名兩種 kind', /tableRows|blockFields/.test(r.criticalFails.join(' ')), r.criticalFails);
}

// ── 9. 變數重名預設報錯、加 overwrite 才允許 ───────────────────────────
{
  const ctx = makeCtx({ '.a': { X: '1' } });
  const dup = await runSteps([
    { action: 'read_block', selector: '.a', labels: 'X', as: 'v' },
    { action: 'read_block', selector: '.a', labels: 'X', as: 'v' },
  ], ctx);
  check('變數重名 → FAIL', dup.pass === false && /重複/.test(dup.criticalFails.join('')), dup.criticalFails);

  const ok = await runSteps([
    { action: 'read_block', selector: '.a', labels: 'X', as: 'v' },
    { action: 'read_block', selector: '.a', labels: 'X', as: 'v', overwrite: true },
  ], makeCtx({ '.a': { X: '1' } }));
  check('明確 overwrite → 通過', ok.pass === true, ok);
}

// ── 10. 缺必填參數要指名是哪個欄位 ─────────────────────────────────────
{
  const r = await runSteps([{ action: 'read_block', selector: '.a' }], makeCtx({ '.a': { X: '1' } }));
  check('缺必填參數 → FAIL', r.pass === false, r);
  check('缺必填參數訊息有指名欄位', /要抓的標籤|存成變數名/.test(r.criticalFails.join('')), r.criticalFails);
}

// ── 11. assert_equals 容差 ─────────────────────────────────────────────
{
  const ctx = makeCtx({ '.a': { N: 'PHP 1,000' }, '.b': { N: '1005' } });
  const within = await runSteps([
    { action: 'read_block', selector: '.a', labels: 'N', as: 'x' },
    { action: 'read_block', selector: '.b', labels: 'N', as: 'y' },
    { action: 'assert_equals', left: 'x.N', right: 'y.N', tolerancePct: 1 },
  ], ctx);
  check('容差內視為相等（且會去掉貨幣符號與千分位）', within.pass === true, within.notes);

  const outside = await runSteps([
    { action: 'read_block', selector: '.a', labels: 'N', as: 'x' },
    { action: 'read_block', selector: '.b', labels: 'N', as: 'y' },
    { action: 'assert_equals', left: 'x.N', right: 'y.N', tolerancePct: 0.1 },
  ], makeCtx({ '.a': { N: 'PHP 1,000' }, '.b': { N: '1005' } }));
  check('超出容差視為不相等', outside.pass === false, outside.notes);
}

// ── 12. assert_sorted ──────────────────────────────────────────────────
{
  const good = await runSteps([
    { action: 'read_table', selector: 'table', as: 't' },
    { action: 'assert_sorted', from: 't', column: 'bet', direction: 'desc' },
  ], makeCtx({ table: [{ bet: '900' }, { bet: '500' }, { bet: '100' }] }));
  check('遞減排序正確 → pass', good.pass === true, good.notes);

  const bad = await runSteps([
    { action: 'read_table', selector: 'table', as: 't' },
    { action: 'assert_sorted', from: 't', column: 'bet', direction: 'desc' },
  ], makeCtx({ table: [{ bet: '100' }, { bet: '900' }] }));
  check('排序不符 → FAIL', bad.pass === false, bad.notes);

  // ⚠️ 欄名打錯是最容易出事的情況：舊版會 map 出一整排 undefined、被 filter 清空，
  //    然後「空陣列必然有序」→ 印「✅ 0 列排序正確」→ 整筆 TC 通過。
  //    下面這組資料本身是 [100, 900]（沒有遞減），欄名一打錯就會被蓋掉。
  const badCol = await runSteps([
    { action: 'read_table', selector: 'table', as: 't' },
    { action: 'assert_sorted', from: 't', column: 'bettt', direction: 'desc' },
  ], makeCtx({ table: [{ bet: '100' }, { bet: '900' }] }));
  check('欄名打錯 → FAIL，不可以假通過', badCol.pass === false, badCol.notes);
  check('而且要講出目前有哪些欄位', /目前欄位：bet/.test(badCol.notes), badCol.notes);

  // ⚠️ 判定要驗「外層會不會算成 PASS」，不是只看有沒有印「排序正確」。
  //    runner 的規則是：`if (pass && manual) skipCount++; else if (pass) passCount++`
  //    ——所以「算成 PASS」等於 `pass && !manual`。只檢查 notes 的話，
  //    onNotComparable 用 warn（pass=true、manual=false）照樣會被算進 PASS，
  //    測試卻是綠的（CodeX review 指出）。
  // ⚠️ 直接用 runner 在用的那一支，不要在測試裡複製規則——
  //    複製的話兩邊日後不同步，測試會繼續綠、實際統計卻已經變了。
  const countsAsPass = r => countBucket(r) === 'pass';
  const sortedCases = [
    ['空表格', []],
    ['整欄都不是數字', [{ bet: 'aaa' }, { bet: 'bbb' }]],
    ['部分列不是數字（900/oops/100）', [{ bet: '900' }, { bet: 'oops' }, { bet: '100' }]],
    ['部分列缺欄', [{ bet: '900' }, {}, { bet: '100' }]],
  ];
  for (const [name, table] of sortedCases) {
    const r = await runSteps([
      { action: 'read_table', selector: 'table', as: 't' },
      { action: 'assert_sorted', from: 't', column: 'bet', direction: 'desc' },
    ], makeCtx({ table }));
    check(`${name} → 不計入 PASS`, !countsAsPass(r), `pass=${r.pass} manual=${r.manual} ${r.notes}`);
    check(`${name} → 不印成「排序正確」`, !/✅.*排序正確/.test(r.notes), r.notes);
  }

  // 部分列比不了時，不可以拿剩下的列下結論——這組剩下的 [900, 100] 剛好有序，
  // 舊版就是靠這個印出「✅ 2 列排序正確」把中間那列蓋掉的。
  const partial = await runSteps([
    { action: 'read_table', selector: 'table', as: 't' },
    { action: 'assert_sorted', from: 't', column: 'bet', direction: 'desc' },
  ], makeCtx({ table: [{ bet: '900' }, { bet: 'oops' }, { bet: '100' }] }));
  check('要指出是第幾列比不了、以及佔幾列', /第 2 列.*1\/3 列/.test(partial.notes), partial.notes);

  // 全部可解析時才真的比，行為不變
  const allNum = await runSteps([
    { action: 'read_table', selector: 'table', as: 't' },
    { action: 'assert_sorted', from: 't', column: 'bet', direction: 'desc' },
  ], makeCtx({ table: [{ bet: '900' }, { bet: '500' }, { bet: '100' }] }));
  check('全部可解析且有序 → 仍然算 PASS', countsAsPass(allNum), allNum.notes);

  // countBucket 本身也要驗——它現在是 runner 統計的唯一來源，改壞了整份報表會錯。
  // 這裡照 runner 原本那四條分支逐一釘住，包含「blocked（pass=false, manual=true）
  // 算 fail」這個既有的不一致：它跟 Lark 回填用的 'manual' 對不起來，但那是既有
  // 行為，釘住是為了「之後真要改時會有人看到這條紅」，不是認可它。
  check('通過且需人工 → skip', countBucket({ pass: true, manual: true }) === 'skip');
  check('單純通過 → pass', countBucket({ pass: true, manual: false }) === 'pass');
  check('明確跳過 → skip', countBucket({ pass: false, manual: false, skip: true }) === 'skip');
  check('失敗 → fail', countBucket({ pass: false, manual: false, skip: false }) === 'fail');
  check('blocked（pass=false、manual=true）目前算 fail（既有行為，刻意釘住）',
    countBucket({ pass: false, manual: true, skip: false }) === 'fail');

  // ⚠️ 共用函式只守「分類規則」，守不到「runner 把分類加到錯的計數器」
  //    ——例如 `if (bucket === 'pass') skipCount++`。那需要整合測試，但真正的
  //    整合測試要跑完整 runner（含 Lark 與瀏覽器），跑不動。這裡退一步做靜態
  //    檢查：直接讀 runner 那段接線，確認三個 bucket 各自加到自己的計數器。
  //    ⚠️ 它驗的是「接線」不是「執行結果」，不要當成整合測試（CodeX review）。
  {
    const runnerSrc = readFileSync(new URL('./run-lark-tc-backend.js', import.meta.url), 'utf8');
    const wiring = runnerSrc.slice(runnerSrc.indexOf('const bucket = countBucket('));
    const seg = wiring.slice(0, wiring.indexOf('const noteStr'));
    check('runner 用的是共用的 countBucket()', /const bucket = countBucket\(result\)/.test(seg), seg);
    check("bucket 'pass' 加到 passCount", /bucket === 'pass'\)\s*passCount\+\+/.test(seg), seg);
    check("bucket 'skip' 加到 skipCount", /bucket === 'skip'\)\s*skipCount\+\+/.test(seg), seg);
    check('其餘落到 failCount', /else\s+failCount\+\+/.test(seg), seg);
    // ⚠️ 這一條只排除**特定寫法**（`result.pass && result.manual`），
    //    抓不到等價的改寫（換順序、拆成變數、用 if/else 串）。
    //    它擋的是「複製貼上舊那段」這個最可能的迴歸路徑，不是「證明沒有第二份規則」
    //    ——不要把它讀成後者（CodeX review 特別點名這個限制）。
    check('runner 沒有把舊那段分類規則複製回來',
      !/result\.pass\s*&&\s*result\.manual/.test(runnerSrc.slice(runnerSrc.indexOf('const bucket = countBucket('))), 'still duplicated');
  }
}

// ── 13. builtin_verifier 相容層 ────────────────────────────────────────
{
  const ctx = makeCtx({}, { notes: 'verifyDashboard ok', criticalFails: [], manual: false });
  const r = await runSteps([{ action: 'builtin_verifier', name: 'verifyDashboard', options: '{"tolerancePct":2}' }], ctx);
  check('內建驗證器可呼叫且 pass', r.pass === true, r);
  // 收工的自動截圖會排在最後，所以不能再用 at(-1) 抓 builtin 那一筆
  check('參數有原封不動傳下去', ctx.calls.find(c => c.kind === 'builtin')?.options?.tolerancePct === 2, ctx.calls);

  const bad = makeCtx({}, { notes: 'boom', criticalFails: ['色塊缺失'], manual: false });
  const r2 = await runSteps([{ action: 'builtin_verifier', name: 'verifyDashboard' }], bad);
  check('內建驗證器回 criticalFails 要傳遞出來', r2.pass === false && r2.criticalFails.length === 1, r2.criticalFails);

  const badJson = makeCtx({}, { notes: 'ok', criticalFails: [], manual: false });
  const r3 = await runSteps([{ action: 'builtin_verifier', name: 'v', options: '{壞掉的 json' }], badJson);
  check('參數 JSON 壞掉不中斷，改用預設值', r3.pass === true && /不是合法 JSON/.test(r3.notes), r3.notes);
}

// ── 14. 新動作積木（錄製會產生的那幾顆）───────────────────────────────
{
  const ctx = makeCtx();
  ctx.clickSelector = async (sel, wait, viewport, recordedViewport) => { ctx.calls.push({ kind: 'click', sel, wait, viewport, recordedViewport }); return 'selector' };
  ctx.typeInto = async (sel, val) => { ctx.calls.push({ kind: 'type', sel, val }) };
  ctx.pressKey = async (sel, key) => { ctx.calls.push({ kind: 'keypress', sel, key }) };
  ctx.dragPointer = async (step) => { ctx.calls.push({ kind: 'drag', step }) };
  ctx.applyFilter = async (f, v, sub, wait) => { ctx.calls.push({ kind: 'filter', f, v, sub, wait }) };
  const r = await runSteps([
    { action: 'click', selector: 'text=查詢', selectorStrategy: 'text', viewport: { x: 12, y: 34 }, recordedViewport: { width: 1280, height: 720 } },
    { action: 'type_text', selector: '#kw', value: 'abc' },
    { action: 'keypress', selector: '#kw', key: 'Enter' },
    { action: 'drag', selector: '#slider', fromX: 10, fromY: 20, toX: 80, toY: 20 },
    { action: 'apply_filter', field: 'Date', value: '2026-08-22' },
  ], ctx);
  check('新動作積木可執行且 pass', r.pass === true, r);
  check('click 有帶到 selector', ctx.calls.some(c => c.kind === 'click' && c.sel === 'text=查詢'), ctx.calls);
  check('type 有帶到值', ctx.calls.some(c => c.kind === 'type' && c.val === 'abc'), ctx.calls);
  check('keypress 有帶到 selector 與按鍵', ctx.calls.some(c => c.kind === 'keypress' && c.sel === '#kw' && c.key === 'Enter'), ctx.calls);
  check('drag 有帶到完整座標', ctx.calls.some(c => c.kind === 'drag' && c.step.toX === 80), ctx.calls);
  check('click 有帶到座標備援資料', ctx.calls.some(c => c.kind === 'click' && c.viewport?.x === 12 && c.recordedViewport?.width === 1280), ctx.calls);
  check('filter 有帶到欄位', ctx.calls.some(c => c.kind === 'filter' && c.f === 'Date'), ctx.calls);
}

// ── 15. assert_absent（反向斷言）───────────────────────────────────────
{
  // 頁面上有錯誤提示 → 應該 FAIL
  const shown = makeCtx();
  shown.page.__counts['.el-message--error'] = 1
  shown.page.__texts['.el-message--error'] = '查詢失敗'
  const bad = await runSteps([{ action: 'assert_absent', selector: '.el-message--error' }], shown);
  check('不該出現的元素出現了 → FAIL', bad.pass === false && bad.criticalFails.length === 1, bad.criticalFails);

  // 沒出現 → pass
  const clean = makeCtx();
  clean.page.__counts['.el-message--error'] = 0
  const ok = await runSteps([{ action: 'assert_absent', text: '查無資料' }], clean);
  check('沒出現 → pass', ok.pass === true, ok);

  // selector 與 text 都沒填＝什麼都沒檢查，不能顯示通過
  const empty = makeCtx();
  empty.page.evaluate = async () => null;
  const none = await runSteps([{ action: 'assert_absent' }], empty);
  check('selector 與 text 都空 → FAIL（不能假裝檢查過）', none.pass === false, none.criticalFails);
}

// ── 16. 控制項類斷言（既有 verifier 驗的多半是這種）────────────────────
{
  const withBtn = makeCtx(); withBtn.page.evaluate = async () => 'Add EGM'
  const ok = await runSteps([{ action: 'assert_control_exists', text: 'Add' }], withBtn)
  check('找得到按鈕 → pass', ok.pass === true, ok.notes)

  const noBtn = makeCtx(); noBtn.page.evaluate = async () => null
  const bad = await runSteps([{ action: 'assert_control_exists', text: 'Add' }], noBtn)
  check('找不到按鈕 → FAIL 且訊息指名', bad.pass === false && /Add/.test(bad.criticalFails.join('')), bad.criticalFails)

  const noText = await runSteps([{ action: 'assert_control_exists' }], makeCtx())
  check('沒填文字 → FAIL（必填）', noText.pass === false, noText.criticalFails)
}

{
  const has = makeCtx(); has.page.evaluate = async () => ['UserId', 'Total Bet Amount', 'Win']
  const ok = await runSteps([{ action: 'assert_column_exists', columns: 'Total Bet Amount' }], has)
  check('表格有這一欄 → pass', ok.pass === true, ok.notes)

  const miss = makeCtx(); miss.page.evaluate = async () => ['UserId', 'Win']
  const bad = await runSteps([{ action: 'assert_column_exists', columns: 'Total Bet Amount\nJackpot' }], miss)
  check('缺欄位 → FAIL 且列出缺哪些', bad.pass === false && /Total Bet Amount/.test(bad.criticalFails.join('')), bad.criticalFails)

  const noTable = makeCtx(); noTable.page.evaluate = async () => null
  const nt = await runSteps([{ action: 'assert_column_exists', columns: 'X' }], noTable)
  check('找不到表格 → FAIL', nt.pass === false, nt.criticalFails)
}

{
  const five = makeCtx(); five.page.evaluate = async () => 5
  check('選項數在範圍內 → pass', (await runSteps([{ action: 'assert_option_count', selector: 'select', min: 2 }], five)).pass === true)
  check('選項數低於下限 → FAIL', (await runSteps([{ action: 'assert_option_count', selector: 'select', min: 9 }], five)).pass === false)
  check('選項數高於上限 → FAIL', (await runSteps([{ action: 'assert_option_count', selector: 'select', min: 1, max: 3 }], five)).pass === false)
  const none = makeCtx(); none.page.evaluate = async () => null
  check('找不到下拉 → FAIL', (await runSteps([{ action: 'assert_option_count', selector: 'select' }], none)).pass === false)
}

// ── assert_dialog_fields ───────────────────────────────────────────────
// 這顆有三次 page.evaluate（開→讀→關），假 ctx 用呼叫序號回不同結果
function dialogCtx(seq) {
  const ctx = makeCtx();
  let i = 0;
  ctx.page.evaluate = async () => seq[Math.min(i++, seq.length - 1)];
  return ctx;
}
{
  const ok = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: `Account
Jackpot` }],
    dialogCtx(['ok', ['Account', 'JackpotAmount', 'Note'], null]));
  check('對話框有全部欄位 → pass', ok.pass === true, ok.notes)

  const miss = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: `Account
Jackpot` }],
    dialogCtx(['ok', ['Account', 'Note'], null]));
  check('對話框缺欄位 → FAIL 且指出缺哪個', miss.pass === false && /Jackpot/.test(miss.criticalFails.join('')), miss.criticalFails)

  const noBtn = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Account' }],
    dialogCtx(['no-button']));
  check('找不到按鈕 → FAIL', noBtn.pass === false && /Add/.test(noBtn.criticalFails.join('')), noBtn.criticalFails)

  const noOpen = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Account' }],
    dialogCtx(['ok', null, null]));
  check('點了但對話框沒開 → FAIL', noOpen.pass === false, noOpen.criticalFails)

  // 欄位標籤常帶 * 與冒號（Element UI 必填標記），比對前兩邊都要正規化
  const star = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Machine Type' }],
    dialogCtx(['ok', ['MachineType', 'ChannelId'], null]));
  check('標籤含必填星號/冒號也要比對得到', star.pass === true, star.notes)
}

// ── warn 級別 ─────────────────────────────────────────────────────────
// 這一組守的是兩個方向：warn 不能把 PASS 變成 FAIL，也不能把該 FAIL 的吃掉
{
  const ctx = makeCtx(); ctx.page.evaluate = async () => null   // 找不到 → 觸發 fail()
  const r = await runSteps([
    { action: 'assert_control_exists', text: 'Maintenance', onFail: 'warn' },
    { action: 'assert_control_exists', text: 'Batch', onFail: 'warn' },
  ], ctx)
  check('warn 不影響 pass 判定', r.pass === true, r)
  check('warn 收進 warnings 而不是 criticalFails', r.warnings.length === 2 && r.criticalFails.length === 0, { w: r.warnings, c: r.criticalFails })
  check('warn 會繼續跑後面的步驟（兩顆都執行到）', r.warnings.length === 2, r.warnings)
  check('warn 用 ⚠️ 不用 ❌', /⚠️/.test(r.notes) && !/❌/.test(r.notes), r.notes)

  // 同一筆裡 warn 跟真的 fail 並存時，fail 仍然要擋下來
  const mixed = makeCtx(); mixed.page.evaluate = async () => null
  const m = await runSteps([
    { action: 'assert_control_exists', text: 'A', onFail: 'warn' },
    { action: 'assert_control_exists', text: 'B', onFail: 'stop' },
  ], mixed)
  check('warn 不會讓同一筆裡真正的 fail 消失', m.pass === false && m.warnings.length === 1, { p: m.pass, w: m.warnings })

  // warn 跟 manual 是不同的東西：warn 不該把整筆標成需人工判讀
  const wm = makeCtx(); wm.page.evaluate = async () => null
  const w = await runSteps([{ action: 'assert_control_exists', text: 'A', onFail: 'warn' }], wm)
  check('warn 不會把整筆標成 manual', w.manual === false, w)

  // 沒有任何 warn 時 warnings 是空陣列，不是 undefined（呼叫端會直接 .length）
  const clean = makeCtx({ '.b': { X: '1' } })
  const c = await runSteps([{ action: 'read_block', selector: '.b', labels: 'X', as: 'b' }], clean)
  check('沒有 warn 時 warnings 是空陣列不是 undefined', Array.isArray(c.warnings) && c.warnings.length === 0, c.warnings)
}

// ── assert_dialog_fields 的兩檔嚴重度 ──────────────────────────────────
// 既有 verifier 就是這樣分的：對話框沒開 = criticalFail，欄位缺少 = 只寫 ⚠️。
// 少了這個區分，那兩筆 Add Dialog TC 就只能在「全都擋」跟「不拆」之間二選一。
{
  const miss = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: `Account
Jackpot`, onMissingFields: 'warn' }],
    dialogCtx(['ok', ['Account', 'Note'], null]));
  check('對話框開了但缺欄位 → warn 不擋', miss.pass === true && miss.warnings.length === 1, { p: miss.pass, w: miss.warnings })

  const notOpen = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Account', onMissingFields: 'warn' }],
    dialogCtx(['ok', null, null]));
  check('對話框根本沒開 → 仍然 FAIL（不吃 onMissingFields）', notOpen.pass === false, notOpen.criticalFails)

  const noBtn2 = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Account', onMissingFields: 'warn' }],
    dialogCtx(['no-button']));
  check('找不到按鈕 → 仍然 FAIL（不吃 onMissingFields）', noBtn2.pass === false, noBtn2.criticalFails)

  const inherit = await runSteps(
    [{ action: 'assert_dialog_fields', trigger: 'Add', fields: 'Account' }],
    dialogCtx(['ok', ['Note'], null]));
  check('沒設 onMissingFields 就沿用 onFail（預設 stop → FAIL）', inherit.pass === false, inherit.criticalFails)
}

// ── assert_labels_contain / assert_row_count ──────────────────────────
{
  const ctx = makeCtx(); ctx.page.evaluate = async () => ['Machine Name', 'Machine No', 'Date']
  check('表單標籤齊全 → pass',
    (await runSteps([{ action: 'assert_labels_contain', source: 'formLabel', expect: `Machine Name
Machine No` }], ctx)).pass === true)

  const m = makeCtx(); m.page.evaluate = async () => ['Machine Name']
  const r = await runSteps([{ action: 'assert_labels_contain', source: 'formLabel', expect: `Machine Name
Machine No` }], m)
  check('缺一項 → FAIL 且指出缺哪個', r.pass === false && /Machine No/.test(r.criticalFails.join('')), r.criticalFails)

  // 既有 verifier 用的是 labels.includes()（完全相等），預設不能悄悄放寬成 contains
  const partial = makeCtx(); partial.page.evaluate = async () => ['Machine Name Extra']
  check('預設完全相等：部分吻合不算數',
    (await runSteps([{ action: 'assert_labels_contain', source: 'formLabel', expect: 'Machine Name' }], partial)).pass === false)
  check('明確指定 contains 才放寬',
    (await runSteps([{ action: 'assert_labels_contain', source: 'formLabel', expect: 'Machine Name', match: 'contains' }], partial)).pass === true)

  const bad = makeCtx()
  check('不認得的控制項種類 → FAIL',
    (await runSteps([{ action: 'assert_labels_contain', source: 'nope', expect: 'X' }], bad)).pass === false)
}
{
  const has = makeCtx(); has.page.evaluate = async () => 12
  check('筆數足夠 → pass', (await runSteps([{ action: 'assert_row_count', min: 1 }], has)).pass === true)

  // 預設 warn：沒資料通常是環境沒樣本，不是功能壞了
  const none = makeCtx(); none.page.evaluate = async () => 0
  const z = await runSteps([{ action: 'assert_row_count', min: 1 }], none)
  check('沒資料預設 warn 不擋', z.pass === true && z.warnings.length === 1, { p: z.pass, w: z.warnings })
  check('要擋也可以明講 onFail: stop',
    (await runSteps([{ action: 'assert_row_count', min: 1, onFail: 'stop' }], none)).pass === false)
}

// ── assert_element_count ──────────────────────────────────────────────
{
  const two = makeCtx(); two.page.__counts['.el-date-editor'] = 2
  check('數量達標 → pass',
    (await runSteps([{ action: 'assert_element_count', selector: '.el-date-editor', min: 2 }], two)).pass === true)

  const one = makeCtx(); one.page.__counts['.el-date-editor'] = 1
  const r = await runSteps([{ action: 'assert_element_count', selector: '.el-date-editor', label: '日期篩選', min: 2 }], one)
  check('數量不足 → FAIL', r.pass === false)
  check('錯誤訊息用看得懂的名稱，不是丟選擇器', /日期篩選/.test(r.criticalFails.join('')), r.criticalFails)
  // 這顆驗的是 DOM 事實不是抽象功能——訊息要講清楚，不然頁面改版會被當成功能壞了
  check('錯誤訊息要說明這是 DOM 數量期待', /DOM|期待值/.test(r.criticalFails.join('')), r.criticalFails)

  const many = makeCtx(); many.page.__counts['x'] = 9
  check('超過上限 → FAIL',
    (await runSteps([{ action: 'assert_element_count', selector: 'x', min: 1, max: 3 }], many)).pass === false)
  const zero = makeCtx(); zero.page.__counts['x'] = 0
  check('一個都沒有 → FAIL', (await runSteps([{ action: 'assert_element_count', selector: 'x' }], zero)).pass === false)
}

// ── 單一目標強制唯一（v4.157.0）─────────────────────────
//
// 使用者 2026-09-17 拍板：選擇器命中多筆時不再安靜取第一個，一律失敗。
// 這些積木以前完全沒有測試——assert_text 的「必須唯一」從寫下來就沒生效過，
// 也是因為沒人驗過。
{
  const many = (sel) => { const c = makeCtx(); c.page.__counts[sel] = 3; return c };

  for (const [action, extra] of [
    ['set_checked', { checked: true }],
    ['select_option', { value: 'A' }],
    ['assert_text', { expect: 'x' }],
  ]) {
    const ctx = many('.dup');
    const r = await runSteps([{ action, selector: '.dup', ...extra }], ctx);
    check(`${action}：命中多筆 → FAIL`, r.pass === false, r.criticalFails);
    check(`${action}：錯誤要說出命中幾個`, /命中 3 個/.test(r.criticalFails.join('')), r.criticalFails);
    // ⚠️ 最要緊的一條：歧義時**不可以真的去動它**。
    //    只報錯但還是按下去，跟沒改一樣壞。
    check(`${action}：歧義時沒有真的去操作元素`,
      !ctx.calls.some(c => c.kind === 'setChecked' || c.kind === 'selectOption'), ctx.calls);
  }

  // 一個都沒有也要失敗，而且要跟「多筆」分開講（下一步不同）
  const none = makeCtx(); none.page.__counts['.gone'] = 0;
  const r0 = await runSteps([{ action: 'set_checked', selector: '.gone', checked: true }], none);
  check('單一目標：一個都沒有 → FAIL 且訊息是「找不到」',
    r0.pass === false && /找不到/.test(r0.criticalFails.join('')), r0.criticalFails);

  // 唯一命中時要照常做事，不能因為改嚴了就連正常情況都擋
  const okCtx = makeCtx(); okCtx.page.__counts['.only'] = 1;
  const r1 = await runSteps([{ action: 'set_checked', selector: '.only', checked: true }], okCtx);
  check('單一目標：唯一命中 → 照常執行',
    r1.pass === true && okCtx.calls.some(c => c.kind === 'setChecked'), { p: r1.pass, calls: okCtx.calls });
}

// ── 選擇器不再丟進瀏覽器原生 querySelector（v4.157.0）──────────
//
// 使用者回報：預檢寫「命中 1 個·可見」，執行卻 `SyntaxError: ... is not a valid selector`。
// 原因是預檢走 Playwright、讀取走原生 CSS，而 `:text-is()` 不是合法 CSS。
{
  // 錄製器產的表格錨點長這樣：原生 querySelector 完全剖不開
  const RECORDED = 'tr:has(:text-is("4186-DFDC-9999")) > td:nth-of-type(14) i';
  const ctx = makeCtx({ [RECORDED]: { 'Machine': '4186-DFDC-9999' } });
  const r = await runSteps([{ action: 'read_block', selector: RECORDED, as: 'blk' }], ctx);
  check('read_block：Playwright 選擇器語法讀得到（不再 SyntaxError）',
    r.pass === true, { p: r.pass, f: r.criticalFails });
  // 並且確實是透過 locator 讀的，不是走那條 page.evaluate 快路徑
  check('read_block：沒有回頭用 page.evaluate 解析選擇器',
    !ctx.calls.some(c => c.kind === 'evaluate' && c.args?.selector === RECORDED), ctx.calls);

  // 語法真的壞掉時要說是語法問題，不要跟「找不到」混在一起
  const broken = makeCtx();
  broken.page.locator = () => { throw new Error('Unexpected token "" while parsing css selector "tr:has("') };
  const rb = await runSteps([{ action: 'read_block', selector: 'tr:has(', as: 'b' }], broken);
  check('read_block：語法錯誤要講明是語法錯誤',
    rb.pass === false && /語法錯誤/.test(rb.criticalFails.join('')), rb.criticalFails);
}

// ── assert_api_called ─────────────────────────────────────────────────
// 很多成功／失敗不在 DOM，在 API 有沒有送出、回什麼碼。這一組守的是那一層。
function netCtx(calls) {
  const ctx = makeCtx();
  ctx.netCallsSince = () => calls;
  return ctx;
}
const CALLS = [
  { method: 'GET', url: 'http://x.org/api/egm/list?page=1', urlPattern: 'http://x.org/api/egm/list', status: 200 },
  { method: 'POST', url: 'http://x.org/api/egm/update/12345', urlPattern: 'http://x.org/api/egm/update/*', status: 200 },
  { method: 'POST', url: 'http://x.org/api/egm/save', urlPattern: 'http://x.org/api/egm/save', status: 500 },
];
{
  const hit = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/list' }], netCtx(CALLS))
  check('有打到而且 2xx → pass', hit.pass === true, hit.notes)

  const miss = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/nope' }], netCtx(CALLS))
  check('完全沒打到 → FAIL，並講出這一步打了幾支', miss.pass === false && /總共打了 3 支/.test(miss.criticalFails.join('')), miss.criticalFails)

  // 500 那筆：有打到但狀態碼不合格。錯誤訊息要分得出「沒打到」跟「打了但錯」
  const bad = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/save' }], netCtx(CALLS))
  check('打到了但回 500 → FAIL', bad.pass === false, bad.criticalFails)
  check('訊息要說是狀態碼不符、不是沒打到', /狀態碼不符/.test(bad.criticalFails.join('')) && /500/.test(bad.criticalFails.join('')), bad.criticalFails)

  const anyOk = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/save', expectStatus: 'any' }], netCtx(CALLS))
  check('expectStatus=any 時 500 也算過', anyOk.pass === true, anyOk.notes)

  const exact = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/save', expectStatus: 'exact', statusCode: 500 }], netCtx(CALLS))
  check('expectStatus=exact 指定 500 → pass', exact.pass === true, exact.notes)

  // 萬用字元是這顆的重點：錄下來的網址有 id，不能寫死
  const wild = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/update/*' }], netCtx(CALLS))
  check('* 對得到帶 id 的網址', wild.pass === true, wild.notes)

  const twice = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/egm/list', minCount: 2 }], netCtx(CALLS))
  check('要求兩次但只打了一次 → FAIL', twice.pass === false, twice.criticalFails)

  // 舊版 runner 沒有網路紀錄可查，不能默默當成通過
  const noNet = await runSteps([{ action: 'assert_api_called', urlPattern: 'http://x.org/api/x' }], makeCtx())
  check('執行環境沒有網路紀錄 → FAIL，不是靜默通過', noNet.pass === false, noNet.criticalFails)
}
{
  // 使用者填的是字面字串，不該被當成 regex——不然網址裡的 ? 和 . 會咬到自己
  check('只有 * 是萬用字元，. 照字面比對',
    wildcardToRegExp('http://x.org/a.b').test('http://x.org/a.b') === true
    && wildcardToRegExp('http://x.org/a.b').test('http://x.org/axb') === false)
  check('? 不是萬用字元', wildcardToRegExp('http://x.org/a?b').test('http://x.org/a?b') === true)
  check('要整段吻合，不是包含就算', wildcardToRegExp('http://x.org/api').test('http://x.org/api/extra') === false)
}

// ── assert_row_buttons ────────────────────────────────────────────────
{
  const has = makeCtx(); has.page.evaluate = async () => [['Edit', 'Delete', 'View']]
  check('列上按鈕齊全 → pass',
    (await runSteps([{ action: 'assert_row_buttons', buttons: `Edit${'\n'}Delete` }], has)).pass === true)

  const miss = makeCtx(); miss.page.evaluate = async () => [['Edit']]
  const r = await runSteps([{ action: 'assert_row_buttons', buttons: `Edit${'\n'}Delete` }], miss)
  check('缺按鈕 → FAIL 且指出缺哪個', r.pass === false && /Delete/.test(r.criticalFails.join('')), r.criticalFails)
  check('訊息要列出這一列實際有什麼', /實際有/.test(r.criticalFails.join('')), r.criticalFails)

  // 有些頁面是 Hidden／Show 二選一
  const hid = makeCtx(); hid.page.evaluate = async () => [['Edit', 'Delete', 'Show']]
  check('anyOf 有一個就算過',
    (await runSteps([{ action: 'assert_row_buttons', buttons: `Edit${'\n'}Delete`, anyOf: `Hidden${'\n'}Show` }], hid)).pass === true)
  const neither = makeCtx(); neither.page.evaluate = async () => [['Edit', 'Delete']]
  check('anyOf 一個都沒有 → FAIL',
    (await runSteps([{ action: 'assert_row_buttons', buttons: 'Edit', anyOf: `Hidden${'\n'}Show` }], neither)).pass === false)

  // 表格空的時候看不到列上的按鈕。既有 verifier 是直接跳過不擋
  const empty = makeCtx(); empty.page.evaluate = async () => []
  const e = await runSteps([{ action: 'assert_row_buttons', buttons: 'Edit' }], empty)
  check('表格沒資料 → 預設 warn 不擋', e.pass === true && e.warnings.length === 1, { p: e.pass, w: e.warnings })
  check('表格沒資料也可以選擇要擋',
    (await runSteps([{ action: 'assert_row_buttons', buttons: 'Edit', onEmptyTable: 'stop' }], empty)).pass === false)

  // rows=all：只看第一列會漏掉後面壞掉的列，這正是「每一列都可以編輯／刪除」要防的
  const mixed = makeCtx(); mixed.page.evaluate = async () => [['Edit', 'Delete'], ['Edit', 'Delete'], ['Edit']]
  check('第一列正常但第三列缺 → rows=first 會漏掉（這是預期行為）',
    (await runSteps([{ action: 'assert_row_buttons', buttons: `Edit
Delete`, rows: 'first' }], mixed)).pass === true)
  const allR = await runSteps([{ action: 'assert_row_buttons', buttons: `Edit
Delete`, rows: 'all' }], mixed)
  check('rows=all 抓得到後面那一列', allR.pass === false, allR.criticalFails)
  check('訊息要指出是第幾列', /第 3 列/.test(allR.criticalFails.join('')), allR.criticalFails)
}

// ── assert_row_count 的上限 ───────────────────────────────────────────
{
  const two = makeCtx(); two.page.evaluate = async () => 2
  check('超過上限 → FAIL（例如「只能新增一個廣告配置」）',
    (await runSteps([{ action: 'assert_row_count', min: 0, max: 1, onFail: 'stop' }], two)).pass === false)
  const one = makeCtx(); one.page.evaluate = async () => 1
  check('剛好在上限內 → pass',
    (await runSteps([{ action: 'assert_row_count', min: 0, max: 1 }], one)).pass === true)
  check('沒填上限就不限制',
    (await runSteps([{ action: 'assert_row_count', min: 0 }], two)).pass === true)
}

// ── 零斷言守門 ────────────────────────────────────────────────────────
// 守的是：驗證器跑完但什麼都沒驗到時，不准判定為通過。
// v4.36.1 就是踩到這個——接線傳錯，每條分支都不命中，結果一路綠燈。
{
  const ran = r => verifierRanAssertion(r)
  check('只有背景資訊（頁面/筆數）→ 沒跑到斷言',
    ran({ notes: '頁面:Meter | 表格10筆', criticalFails: [] }) === false)
  check('有 ✅ → 有跑', ran({ notes: '頁面:X | ✅欄位完整', criticalFails: [] }) === true)
  check('有 ❌ → 有跑', ran({ notes: '❌欄位缺失', criticalFails: ['欄位缺失'] }) === true)
  check('note-only 的 ⚠️ 也算有跑（它確實查了，只是查不到不擋）',
    ran({ notes: '表格0筆 | ⚠️目前無資料，無法驗證', criticalFails: [] }) === true)
  check('「沒有對應到已知的驗證規則」那句哨兵不算有跑（它的意思剛好相反）',
    ran({ notes: '頁面:X | ⚠️這筆TC文字沒有對應到已知的驗證規則，未執行任何斷言: abc', criticalFails: [] }) === false)
  check('manual 是正當結果，不算沒跑',
    ran({ notes: '⚠️ MANUAL: 需跨渠道比對', criticalFails: [], manual: true }) === true)
  check('完全空的 → 沒跑', ran({ notes: '', criticalFails: [] }) === false)
  check('undefined 也不能當成有跑', ran(undefined) === false)
}

// ── 17. 純函式 ─────────────────────────────────────────────────────────
check('toNumber 去掉貨幣與千分位', toNumber('PHP 15,024,840') === 15024840);
check('toNumber 處理負數', toNumber('-258') === -258);
check('toNumber 空值回 undefined（不是 0）', toNumber('') === undefined && toNumber(null) === undefined);
check('numbersEqual 絕對誤差至少容許 1', numbersEqual(0, 1, 0) === true);
check('numbersEqual undefined 一律不相等', numbersEqual(undefined, 5) === false);

// ── assert_column_unique ────────────────────────────────────────────────────
// 守的是「有重複卻報通過」這條線。表格沒資料跟有重複是兩回事，不能混成同一種結果。
{
  const mkCtx = (heads, values) => ({
    page: {
      evaluate: async (fn, arg) => {
        // 模擬瀏覽器端：直接照積木要的形狀回資料，不真的跑 DOM
        const idx = heads.findIndex(h => h.toLowerCase() === String(arg.colName).toLowerCase());
        if (idx < 0) return { missing: true, heads };
        return { missing: false, values };
      },
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
    },
    openPath: async () => {},
  });

  let r = await runSteps([{ action: 'assert_column_unique', column: 'Game ID' }],
    mkCtx(['Game ID', 'Name'], ['A', 'B', 'C']));
  check('沒有重複 → 通過', r.pass === true && r.criticalFails.length === 0);

  r = await runSteps([{ action: 'assert_column_unique', column: 'Game ID' }],
    mkCtx(['Game ID'], ['A', 'B', 'A']));
  check('有重複 → 失敗', r.pass === false);
  check('有重複 → 訊息要指出是哪個值', r.criticalFails.join('').includes('A'));

  r = await runSteps([{ action: 'assert_column_unique', column: 'Game ID' }],
    mkCtx(['Game ID'], []));
  check('表格沒資料 → 預設只警告不算失敗', r.pass === true && r.warnings.length === 1);

  r = await runSteps([{ action: 'assert_column_unique', column: 'Game ID', onEmptyTable: 'stop' }],
    mkCtx(['Game ID'], []));
  check('表格沒資料 → 明確設成 stop 時才算失敗', r.pass === false);

  r = await runSteps([{ action: 'assert_column_unique', column: '不存在的欄' }],
    mkCtx(['Game ID'], ['A']));
  check('欄位不存在 → 失敗（不是靜默跳過）', r.pass === false);

  r = await runSteps([{ action: 'assert_column_unique', column: 'Game ID', onFail: 'warn' }],
    mkCtx(['Game ID'], ['A', 'A']));
  check('有重複但設成 warn → 不影響判定但要留下警告', r.pass === true && r.warnings.length === 1);
}

// ── assert_export_matches_screen ────────────────────────────────────────────
// 守的是「匯出檔跟畫面不一致卻報通過」。另外三種情況要分得開：畫面沒資料（沒得驗）、
// 檔案沒下載（沒驗到）、真的對不上（驗了不過）——混成同一種就會有假通過。
{
  const mk = ({ screen, headers, rows, hasButton = true }) => ({
    page: {
      evaluate: async (fn, arg) => {
        if (arg && 'keyCol' in arg) return screen;
        return null;
      },
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
    },
    openPath: async () => {},
    runExport: async () => ({ hasButton, file: rows ? 'x.xlsx' : null, headers, rows }),
  });

  const step = { action: 'assert_export_matches_screen', keyColumn: 'Account', valueColumn: 'Jackpot Amount' };

  let r = await runSteps([step], mk({
    screen: { key: 'user01', value: '1,234.00' },
    headers: ['Account', 'Jackpot Amount'], rows: [['user01', '1234']],
  }));
  check('數值一致（畫面帶千分位）→ 通過', r.pass === true && r.criticalFails.length === 0);

  r = await runSteps([step], mk({
    screen: { key: 'user01', value: '1234' },
    headers: ['Account', 'Jackpot Amount'], rows: [['user01', '9999']],
  }));
  check('數值不一致 → 失敗', r.pass === false);

  r = await runSteps([step], mk({
    screen: { key: 'user01', value: '1234' },
    headers: ['Account', 'Jackpot Amount'], rows: [['other', '1234']],
  }));
  check('檔案裡找不到同一列 → 失敗（不是靜默通過）', r.pass === false);

  r = await runSteps([step], mk({ screen: { noRow: true }, headers: null, rows: null }));
  check('畫面沒資料 → 預設只警告', r.pass === true && r.warnings.length === 1);

  r = await runSteps([step], mk({
    screen: { key: 'user01', value: '1234' }, headers: null, rows: null,
  }));
  check('檔案沒解析出來 → 記成警告而不是通過', r.warnings.length === 1);

  r = await runSteps([step], mk({
    screen: { key: 'user01', value: '1234' }, headers: null, rows: null, hasButton: false,
  }));
  check('找不到匯出按鈕 → 失敗', r.pass === false);

  r = await runSteps([step], mk({
    screen: { missingCol: true, heads: ['A', 'B'] }, headers: null, rows: null,
  }));
  check('畫面上沒有那個欄位 → 失敗（不是當成沒資料）', r.pass === false);
}

// ── 自動收工截圖（v4.91.0）──────────────────────────────────────────────
// 補回積木化時掉掉的證據：builtin 路徑是無條件先截圖再判定，積木路徑原本
// 只有顯式加了「截圖」積木才會截，79 筆裡只有 3 筆有加。
{
  const ctx = makeCtx({ '.blue-block': { 'A': '1' } });
  const r = await runSteps([{ action: 'read_block', selector: '.blue-block', labels: 'A', as: 'b' }], ctx);
  check('沒有截圖積木時，收工自動截一張', r.allShotPaths.length === 1 && r.allShotPaths[0].includes('result'), r.allShotPaths);
}
{
  // 作者自己指定了證據點就不再補——否則會破壞「顯式截圖代表作者指定」這個語意
  const ctx = makeCtx({ '.blue-block': { 'A': '1' } });
  const r = await runSteps([
    { action: 'read_block', selector: '.blue-block', labels: 'A', as: 'b' },
    { action: 'screenshot', name: 'mine' },
  ], ctx);
  check('已有截圖積木時不重複自動截', r.allShotPaths.length === 1 && r.allShotPaths[0].includes('mine'), r.allShotPaths);
}
{
  // MANUAL 本來就不上傳截圖（2026-08-07 規則），不用白截
  const ctx = makeCtx();
  const r = await runSteps([{ action: 'mark_manual', reason: '要人看' }], ctx);
  check('MANUAL 不自動截圖', r.manual === true && r.allShotPaths.length === 0, r.allShotPaths);
}
{
  // 截圖失敗是證據問題，不能反過來把判定弄成失敗
  const ctx = makeCtx({ '.blue-block': { 'A': '1' } });
  ctx.takeScreenshot = async () => { throw new Error('disk full') };
  const r = await runSteps([{ action: 'read_block', selector: '.blue-block', labels: 'A', as: 'b' }], ctx);
  check('截圖失敗不影響判定', r.pass === true && r.allShotPaths.length === 0, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
