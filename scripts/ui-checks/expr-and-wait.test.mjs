/**
 * 「算式必須相等」與「等到…出現／消失」的測試。
 *
 *   node scripts/ui-checks/expr-and-wait.test.mjs
 *
 * 算式那一顆守的是：**使用者填的字串不能變成可以執行的程式碼**，而且
 * 「算式寫錯」要跟「算出來不相等」分得開——混在一起的話，看報告的人會以為數據有問題。
 *
 * 等待那一顆守的是：**等不到不可以當成過了**。固定秒數的等待之所以危險，
 * 就是因為它「等完就往下跑」，把「頁面沒反應」偽裝成「跑完了」。
 */
import assert from 'node:assert/strict';
import { evaluateExpr } from '../../server/uat-runner/expr.js';
import { toNumber, runSteps, expandRepeats } from '../../server/uat-runner/block-engine.js';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};

const VARS = {
  before: { Balance: 'PHP 10,000.00' },
  bet: { Amount: '1,408' },
  after: { Balance: 'PHP 8,592.00' },
  ratio: { Value: '14.06%' },
  bad: { Name: 'Phoenix-132' },
};
const lookup = (name) => name.split('.').reduce((cur, part) => (cur == null ? cur : cur[part]), VARS);
const ev = (src) => evaluateExpr(src, lookup, toNumber);
const throws = (fn) => { try { fn(); return '' } catch (e) { return e.message } };

console.log('算式（assert_expr 的核心）');
check('四則運算', ev('1 + 2 * 3') === 7);
check('括號', ev('(1 + 2) * 3') === 9);
check('負號', ev('-3 + 5') === 2);
check('變數：幣別與千分位會被正規化', ev('before.Balance') === 10000);
check('金流形狀：扣款前 − 下注 = 扣款後', ev('before.Balance - bet.Amount') === ev('after.Balance'));
check('百分比也讀得到（14.06% → 14.06）', ev('ratio.Value') === 14.06);
check('千分位數字字面值', ev('1,408 + 0') === 1408);

// ⚠️ 這幾條是「不能做到」的事，比能做到的更重要
check('不能執行程式碼', !!throws(() => ev('process.exit(1)')));
check('不能用比較／邏輯運算子', !!throws(() => ev('1 && 2')));
check('看不懂的字元要明確報錯', /看不懂的字元/.test(throws(() => ev('1 ; 2'))));
check('括號沒關要報錯', /括號/.test(throws(() => ev('(1 + 2'))));
check('除以 0 要明講', /除以 0/.test(throws(() => ev('1 / 0'))));
check('取不到值要指名是哪個變數', /取不到「nope.x」/.test(throws(() => ev('nope.x + 1'))));
check('值不是數字要指名', /不是數字/.test(throws(() => ev('bad.Name + 1'))));
check('空算式要報錯', !!throws(() => ev('')));

console.log('\n積木層：算式必須相等');
const ctxWith = (rows) => ({
  page: {
    evaluate: async (fn, arg) => {
      void fn;
      // read_table 用；wait_for 會另外覆寫
      void arg;
      return rows;
    },
    waitForTimeout: async () => {},
    locator: () => ({ count: async () => 1, first: () => ({}), elementHandle: async () => ({}) }),
  },
});
{
  const r = await runSteps([
    { action: 'read_table', name: '讀畫面', as: 'row', selector: 'table', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'assert_expr', name: '加總要對', left: 'row.In - row.Out', right: 'row.Net', tolerancePct: 0, absoluteTolerance: 0 },
  ], ctxWith([{ Date: '2026-09-18', In: '10,000', Out: '1,408', Net: '8,592' }]), {});
  check('算式對得上 → 通過', r.criticalFails.length === 0, r.criticalFails[0] ?? r.notes);
}
{
  const r = await runSteps([
    { action: 'read_table', name: '讀畫面', as: 'row', selector: 'table', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'assert_expr', name: '加總要對', left: 'row.In - row.Out', right: 'row.Net', tolerancePct: 0, absoluteTolerance: 0 },
  ], ctxWith([{ Date: '2026-09-18', In: '10,000', Out: '1,408', Net: '9,000' }]), {});
  check('算錯 → 紅，而且訊息帶得出兩邊的值', r.criticalFails.length > 0 && /8592/.test(r.notes), r.notes);
}
{
  const r = await runSteps([
    { action: 'read_table', name: '讀畫面', as: 'row', selector: 'table', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'assert_expr', name: '算式寫錯', left: 'row.In ;; row.Out', right: 'row.Net' },
  ], ctxWith([{ Date: '2026-09-18', In: '1', Out: '1', Net: '0' }]), {});
  check('算式寫錯 → 訊息說「沒辦法求值」而不是說數據不符', /沒辦法求值/.test(r.notes), r.notes);
}

console.log('\n積木層：等到…出現／消失');
const waitCtx = (states) => {
  let i = 0;
  return {
    page: {
      evaluate: async () => states[Math.min(i++, states.length - 1)],
      waitForTimeout: async () => {},
      locator: () => ({ count: async () => 1, first: () => ({}) }),
    },
  };
};
{
  const r = await runSteps([{ action: 'wait_for', name: '等表格有資料', until: 'rows', selector: 'tr', minRows: 1, timeoutMs: 3000 }],
    waitCtx([{ ok: false, count: 0 }, { ok: false, count: 0 }, { ok: true, count: 3 }]), {});
  check('條件成立就往下走', r.criticalFails.length === 0, r.criticalFails[0] ?? r.notes);
}
{
  const r = await runSteps([{ action: 'wait_for', name: '等表格有資料', until: 'rows', selector: 'tr', minRows: 1, timeoutMs: 1200 }],
    waitCtx([{ ok: false, count: 0 }]), {});
  check('等不到＝失敗（不是默默往下跑）', r.criticalFails.length > 0, r.notes);
  check('而且要講出等了多久、現在看到幾個', /等了 1200ms/.test(r.notes) && /命中 0 個/.test(r.notes), r.notes);
}
{
  const r = await runSteps([{ action: 'wait_for', name: '選擇器壞了', until: 'visible', selector: 'tr:text-is(x)', timeoutMs: 1200 }],
    waitCtx([{ bad: 'not a valid selector' }]), {});
  check('選擇器不合法要明講（不是等到逾時）', /選擇器不合法/.test(r.notes), r.notes);
}


console.log('迴圈：重複接下來幾步（執行前展開）');
{
  const plan = expandRepeats([
    { action: 'click', name: '下一頁', selector: '.next' },
    { action: 'repeat', count: 3, span: 2 },
    { action: 'click', name: '捲一下', selector: '.more' },
    { action: 'wait', name: '等一下', waitMs: 100 },
    { action: 'screenshot', name: '收尾' },
  ]);
  check('展開後步數正確（1 + 3×2 + 1）', plan.length === 8, `實際 ${plan.length}`);
  check('每一輪都標得出輪次（日誌才看得出第幾輪掛的）', /第 2\/3 輪/.test(plan.map(s => s.name).join('｜')), plan.map(s => s.name).join('｜'));
  check('重複之後的步驟照樣保留', plan[plan.length - 1].name === '收尾');
  check('次數超出上限要明確報錯', /1～20/.test(throws(() => expandRepeats([{ action: 'repeat', count: 99, span: 1 }, { action: 'wait' }]))));
  check('跨度大於剩下的步數要報錯', /不足/.test(throws(() => expandRepeats([{ action: 'repeat', count: 2, span: 5 }, { action: 'wait' }]))));
  check('展開後超過 300 步要報錯（不可以偷偷截斷）',
    /300 步/.test(throws(() => expandRepeats([{ action: 'repeat', count: 20, span: 20 }, ...Array.from({ length: 20 }, () => ({ action: 'wait' }))]))));
}

console.log('逐列檢查：每一列都要符合');
{
  const rowsCtx = (rows) => ({
    page: { evaluate: async () => rows, waitForTimeout: async () => {}, locator: () => ({ count: async () => 1, first: () => ({}), elementHandle: async () => ({}) }) },
  });
  const ok = await runSteps([
    { action: 'read_table', name: '讀表格', as: 'rows', selector: 'table' },
    { action: 'assert_each_row', name: '每列加總要對', from: 'rows', mode: 'expr', left: 'row.In - row.Out', right: 'row.Net' },
  ], rowsCtx([{ In: '10', Out: '3', Net: '7' }, { In: '5', Out: '1', Net: '4' }]), {});
  check('每列都符合 → 通過', ok.criticalFails.length === 0, ok.criticalFails[0] ?? ok.notes);

  const bad = await runSteps([
    { action: 'read_table', name: '讀表格', as: 'rows', selector: 'table' },
    { action: 'assert_each_row', name: '每列加總要對', from: 'rows', mode: 'expr', left: 'row.In - row.Out', right: 'row.Net' },
  ], rowsCtx([{ In: '10', Out: '3', Net: '7' }, { In: '5', Out: '1', Net: '9' }]), {});
  check('有一列不符 → 紅，而且指得出是第幾列', bad.criticalFails.length > 0 && /第 2 列/.test(bad.notes), bad.notes);

  const empty = await runSteps([
    { action: 'read_table', name: '讀表格', as: 'rows', selector: 'table' },
    { action: 'assert_each_row', name: '每列都要有日期', from: 'rows', mode: 'notEmpty', column: 'Date' },
  ], rowsCtx([]), {});
  check('一列都沒有 → 不可以算通過', /一列都沒有/.test(empty.notes), empty.notes);

  const blank = await runSteps([
    { action: 'read_table', name: '讀表格', as: 'rows', selector: 'table' },
    { action: 'assert_each_row', name: '每列都要有日期', from: 'rows', mode: 'notEmpty', column: 'Date' },
  ], rowsCtx([{ Date: '2026-09-18' }, { Date: '' }]), {});
  check('欄位空值抓得到', blank.criticalFails.length > 0 && /第 2 列/.test(blank.notes), blank.notes);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '算式／等待測試有失敗項');
