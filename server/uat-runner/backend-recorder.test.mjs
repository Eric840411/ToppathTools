/**
 * 錄製器的轉換測試：錄到的事件 → 積木。不開瀏覽器。
 * 這裡守的是「沒有斷言的錄製要偵測得出來」——沒有斷言的腳本永遠 PASS，
 * 那不是測試是重播，安靜存下來比報錯更糟。
 *
 * 跑法：node server/uat-runner/backend-recorder.test.mjs
 */
import { eventsToSteps, hasAssertion, backendRecorderScript } from './backend-recorder.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (extra !== undefined) console.log('        ', JSON.stringify(extra)); }
};

const acts = eventsToSteps([
  { action: 'click', selector: 'text=查詢', selectorStrategy: 'text' },
  { action: 'type_text', selector: 'label=帳號', value: 'admin', selectorStrategy: 'label' },
]);
check('動作事件原樣變積木', acts.length === 2 && acts[0].action === 'click', acts);

const filled = eventsToSteps([{ assertion: { kind: 'filled' }, selector: '.el-card', label: 'Total Available EGM', currentValue: '5' }]);
check('必須有值展開成 read_block + assert_filled', filled.length === 2 && filled[0].action === 'read_block' && filled[1].action === 'assert_filled', filled);
check('read_block 帶到標籤', filled[0].labels[0] === 'Total Available EGM', filled[0]);
check('assert_filled 引用同一個變數', filled[0].as === filled[1].from, filled);

const eq = eventsToSteps([{ assertion: { kind: 'equals', expect: '100' }, selector: '.x', label: 'Bet', currentValue: '99' }]);
check('等於某數：期望值有帶進去', eq.length === 2 && eq[1].action === 'assert_equals' && eq[1].right === '100', eq);

const ab = eventsToSteps([{ assertion: { kind: 'absent' }, selector: '.el-message--error', currentValue: '查詢失敗' }]);
check('不能出現 → assert_absent', ab.length === 1 && ab[0].action === 'assert_absent', ab);

const mn = eventsToSteps([{ assertion: { kind: 'manual', reason: '要等5分鐘' }, selector: '.y' }]);
check('需人工 → mark_manual', mn[0].action === 'mark_manual' && mn[0].reason === '要等5分鐘', mn);

const st = eventsToSteps([{ assertion: { kind: 'sorted' }, selector: 'td', column: 'Bet' }]);
check('排序 → read_table + assert_sorted', st.length === 2 && st[1].column === 'Bet', st);

const two = eventsToSteps([
  { assertion: { kind: 'filled' }, selector: '.a', label: 'A' },
  { assertion: { kind: 'filled' }, selector: '.b', label: 'B' },
]);
check('多個斷言的變數名不重複（重名引擎會 FAIL）', two[0].as !== two[2].as, two.map(s => s.as));

check('只有動作沒有斷言要偵測得出來', hasAssertion(acts) === false);
check('有斷言 → true', hasAssertion(filled) === true);
check('mark_manual 也算斷言', hasAssertion(mn) === true);

const src = backendRecorderScript();
let syntaxOk = true;
try { new Function(src); } catch { syntaxOk = false; }
check('注入腳本語法合法', syntaxOk);
check('注入腳本有處理 Alt', src.includes('event.altKey'));
check('注入腳本含完整選擇器階梯', ['dataAttr', 'label', 'text', 'tableCell', 'cssPath'].every(s => src.includes(s)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
