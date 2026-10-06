/**
 * `read_value` 的擷取規則 pattern（v5.27.5，claude-osm-2 T-008 要的）。
 *
 *   node scripts/ui-checks/read-value-pattern.test.mjs
 *
 * 守的是：只取一段要取對；**對不到／取到空的一定失敗、訊息寫出讀到的整句**——存成空字串的話，
 * 後面跟後台比對會變成「空＝空」假通過。
 */
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`); ok ? pass++ : fail++; };
const fakePage = (texts) => ({
  locator: (sel) => ({ count: async () => (sel in texts ? 1 : 0), first: () => ({ innerText: async () => texts[sel], textContent: async () => texts[sel] }) }),
  waitForTimeout: async () => {},
  evaluate: async (_fn, arg) => texts['@node:' + arg] ?? null,
});
const TIP = 'If the cumulative betting amount this day is less than 300, the VIP level will be downgraded.';
const DOM = { '.down-tips-text': TIP, '.big': 'Need   1,000   more', '@node:lb_tip': 'less than 2,500 today' };
async function run(step) {
  const state = {};
  const err = await runFrontendStep({ action: 'read_value', name: 'read', as: 'tip', ...step }, { idx: '', label: 'read', log: () => {}, page: fakePage(DOM), state, startUrl: 'https://qat.example' })
    .then(() => '', (e) => e.message);
  return { err, val: state.vars?.tip };
}

console.log('read_value 擷取規則');
// ⚠️ 原本提議的 `less than ([\d,]+)` 會連後面的逗號一起吃進去（「300, the VIP…」→「300,」），跟後台的 300 比會對不上
let r = await run({ selector: '.down-tips-text', pattern: String.raw`less than ([\d,]+)` });
check('寫法陷阱：數字加逗號的寫法會吃到句中的逗號 → 存成「300,」', r.val === '300,', JSON.stringify(r));
r = await run({ selector: '.down-tips-text', pattern: String.raw`less than ([\d,]*\d)` });
check('T-008：結尾限定是數字的寫法 → 只存 300', r.val === '300', JSON.stringify(r));
r = await run({ selector: '.big', pattern: String.raw`Need ([\d,]+) more` });
check('先正規化空白再比對（連續空白變一個）', r.val === '1,000', JSON.stringify(r));
r = await run({ nodeName: 'lb_tip', pattern: String.raw`than ([\d,]+)` });
check('PC 節點也吃 pattern', r.val === '2,500', JSON.stringify(r));
r = await run({ selector: '.down-tips-text' });
check('沒填 pattern → 存整句（原本的行為不變）', r.val === TIP, JSON.stringify(r));
r = await run({ selector: '.down-tips-text', pattern: String.raw`more than ([\d,]+)` });
check('對不到 → 失敗、不存值、訊息有讀到的整句', !!r.err && r.val === undefined && r.err.includes('is less than 300'), JSON.stringify(r));
r = await run({ selector: '.down-tips-text', pattern: String.raw`less than (x*)` });
check('對到但第 1 組是空的 → 失敗、不存空字串', !!r.err && r.val === undefined, JSON.stringify(r));
r = await run({ selector: '.down-tips-text', pattern: String.raw`less than \d+` });
check('沒有擷取群組 → 失敗並教怎麼寫', !!r.err && r.err.includes('擷取群組') && r.val === undefined, JSON.stringify(r));
r = await run({ selector: '.down-tips-text', pattern: String.raw`less than ([` });
check('正規式寫壞 → 失敗、講清楚是規則壞了', !!r.err && r.err.includes('不是合法的正規式'), JSON.stringify(r));

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
