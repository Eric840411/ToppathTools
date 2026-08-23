/**
 * block-engine 的行為測試。用假的 ctx（不開瀏覽器）驗執行器本身的語意——
 * 這裡要守的是「失敗不能變成通過」這條線，那是積木化最容易出事的地方。
 *
 * 跑法：node server/uat-runner/block-engine.test.mjs
 */
import { runSteps, toNumber, numbersEqual } from './block-engine.js';
import { verifierRanAssertion } from './verifier-params.js';

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
      async waitForTimeout() {},
      locator() { return { first: () => ({ click: async () => {} }) } },
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

// ── 14. 新動作積木（錄製會產生的那幾顆）───────────────────────────────
{
  const ctx = makeCtx();
  ctx.clickSelector = async (sel, wait) => { ctx.calls.push({ kind: 'click', sel, wait }) };
  ctx.typeInto = async (sel, val) => { ctx.calls.push({ kind: 'type', sel, val }) };
  ctx.applyFilter = async (f, v, sub, wait) => { ctx.calls.push({ kind: 'filter', f, v, sub, wait }) };
  const r = await runSteps([
    { action: 'click', selector: 'text=查詢', selectorStrategy: 'text' },
    { action: 'type_text', selector: '#kw', value: 'abc' },
    { action: 'apply_filter', field: 'Date', value: '2026-08-22' },
  ], ctx);
  check('新動作積木可執行且 pass', r.pass === true, r);
  check('click 有帶到 selector', ctx.calls.some(c => c.kind === 'click' && c.sel === 'text=查詢'), ctx.calls);
  check('type 有帶到值', ctx.calls.some(c => c.kind === 'type' && c.val === 'abc'), ctx.calls);
  check('filter 有帶到欄位', ctx.calls.some(c => c.kind === 'filter' && c.f === 'Date'), ctx.calls);
}

// ── 15. assert_absent（反向斷言）───────────────────────────────────────
{
  // 頁面上有錯誤提示 → 應該 FAIL
  const shown = makeCtx();
  shown.page.evaluate = async () => ({ by: 'selector', shown: '查詢失敗' });
  const bad = await runSteps([{ action: 'assert_absent', selector: '.el-message--error' }], shown);
  check('不該出現的元素出現了 → FAIL', bad.pass === false && bad.criticalFails.length === 1, bad.criticalFails);

  // 沒出現 → pass
  const clean = makeCtx();
  clean.page.evaluate = async () => null;
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
  const two = makeCtx(); two.page.evaluate = async () => 2
  check('數量達標 → pass',
    (await runSteps([{ action: 'assert_element_count', selector: '.el-date-editor', min: 2 }], two)).pass === true)

  const one = makeCtx(); one.page.evaluate = async () => 1
  const r = await runSteps([{ action: 'assert_element_count', selector: '.el-date-editor', label: '日期篩選', min: 2 }], one)
  check('數量不足 → FAIL', r.pass === false)
  check('錯誤訊息用看得懂的名稱，不是丟選擇器', /日期篩選/.test(r.criticalFails.join('')), r.criticalFails)
  // 這顆驗的是 DOM 事實不是抽象功能——訊息要講清楚，不然頁面改版會被當成功能壞了
  check('錯誤訊息要說明這是 DOM 數量期待', /DOM|期待值/.test(r.criticalFails.join('')), r.criticalFails)

  const many = makeCtx(); many.page.evaluate = async () => 9
  check('超過上限 → FAIL',
    (await runSteps([{ action: 'assert_element_count', selector: 'x', min: 1, max: 3 }], many)).pass === false)
  const zero = makeCtx(); zero.page.evaluate = async () => 0
  check('一個都沒有 → FAIL', (await runSteps([{ action: 'assert_element_count', selector: 'x' }], zero)).pass === false)
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
