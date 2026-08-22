/**
 * block-engine 的行為測試。用假的 ctx（不開瀏覽器）驗執行器本身的語意——
 * 這裡要守的是「失敗不能變成通過」這條線，那是積木化最容易出事的地方。
 *
 * 跑法：node server/uat-runner/block-engine.test.mjs
 */
import { runSteps, toNumber, numbersEqual } from './block-engine.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (extra !== undefined) console.log('        ', JSON.stringify(extra)); }
}

/** 假的 ctx：page.evaluate 直接回預先塞好的資料 */
function makeCtx(pageData = {}, builtin = null) {
  const calls = [];
  return {
    calls,
    page: {
      async evaluate(fn, args) {
        calls.push({ kind: 'evaluate', args });
        if (args?.selector in pageData) return pageData[args.selector];
        return null;
      },
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
  check('stop 之後不再執行', r.allShotPaths.length === 0, r.allShotPaths);
}

// ── 4. manual 不是失敗 ─────────────────────────────────────────────────
{
  const ctx = makeCtx();
  const r = await runSteps([{ action: 'mark_manual', reason: '需等 5 分鐘觀察' }], ctx);
  check('manual 不算 pass', r.pass === false, r);
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
  check('同時有 fail 與 manual 時 pass=false', r.pass === false, r);
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
  check('引用不存在變數 → 中止', r.allShotPaths.length === 0, r.allShotPaths);
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
}

// ── 13. builtin_verifier 相容層 ────────────────────────────────────────
{
  const ctx = makeCtx({}, { notes: 'verifyDashboard ok', criticalFails: [], manual: false });
  const r = await runSteps([{ action: 'builtin_verifier', name: 'verifyDashboard', options: '{"tolerancePct":2}' }], ctx);
  check('內建驗證器可呼叫且 pass', r.pass === true, r);
  check('參數有原封不動傳下去', ctx.calls.at(-1)?.options?.tolerancePct === 2, ctx.calls.at(-1));

  const bad = makeCtx({}, { notes: 'boom', criticalFails: ['色塊缺失'], manual: false });
  const r2 = await runSteps([{ action: 'builtin_verifier', name: 'verifyDashboard' }], bad);
  check('內建驗證器回 criticalFails 要傳遞出來', r2.pass === false && r2.criticalFails.length === 1, r2.criticalFails);

  const badJson = makeCtx({}, { notes: 'ok', criticalFails: [], manual: false });
  const r3 = await runSteps([{ action: 'builtin_verifier', name: 'v', options: '{壞掉的 json' }], badJson);
  check('參數 JSON 壞掉不中斷，改用預設值', r3.pass === true && /不是合法 JSON/.test(r3.notes), r3.notes);
}

// ── 14. 純函式 ─────────────────────────────────────────────────────────
check('toNumber 去掉貨幣與千分位', toNumber('PHP 15,024,840') === 15024840);
check('toNumber 處理負數', toNumber('-258') === -258);
check('toNumber 空值回 undefined（不是 0）', toNumber('') === undefined && toNumber(null) === undefined);
check('numbersEqual 絕對誤差至少容許 1', numbersEqual(0, 1, 0) === true);
check('numbersEqual undefined 一律不相等', numbersEqual(undefined, 5) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
