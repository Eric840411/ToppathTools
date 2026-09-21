/**
 * `assert_text`（驗文字／數字）的測試。
 *
 *   node scripts/ui-checks/assert-text.test.mjs
 *
 * 這顆的存在理由：**PC 不需要 OCR**——畫面雖然是 canvas，文字還是 Cocos label 上的
 * 字串，直接讀比截圖辨識準。所以這裡釘住的是「讀到什麼就比什麼」，以及幾個
 * 很容易出錯而且錯了看不出來的地方：
 *   ① **數值模式要正規化**：畫面上是「31,568,677,510.61」，字串比對永遠對不上
 *   ② **找不到節點 ≠ 節點上沒字**——後者若被當成空字串比對，「驗到空的也算過」
 *   ③ 比對失敗的訊息要寫出**讀到什麼**，不然只知道「不符」完全沒得查
 */
import assert from 'node:assert/strict';
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};

/** 假的 page：DOM 那條線只要能回答 innerText */
const fakePage = (texts) => ({
  locator: (sel) => ({
    count: async () => (sel in texts ? 1 : 0),
    first: () => ({ innerText: async () => texts[sel], textContent: async () => texts[sel] }),
  }),
  waitForTimeout: async () => {},
  /** PC 那條線走注入的反查器，這裡把 evaluate 攔下來自己回答 */
  evaluate: async (fn, arg) => {
    void fn;
    return texts['@node:' + arg] ?? null;
  },
});

const run = (step, texts) => runFrontendStep({ action: 'assert_text', name: 'text', ...step }, {
  idx: '', label: 'text', log: () => {}, page: fakePage(texts), state: {}, startUrl: 'https://qat.example',
}).then(() => '', (e) => e.message);

console.log('assert_text 驗文字／數字');

const DOM = { '.balance': '31,568,677,510.61', '.title': ' Good   Fortune ' };

// 基本比對
check('包含（預設）', !(await run({ selector: '.title', value: 'Good Fortune' }, DOM)));
check('空白會正規化（連續空白變一個）', !(await run({ selector: '.title', value: 'Good Fortune', matchMode: 'equals' }, DOM)));
check('完全相等對不上要紅', !!(await run({ selector: '.title', value: 'Good', matchMode: 'equals' }, DOM)));
check('正則', !(await run({ selector: '.balance', value: '^[0-9,.]+$', matchMode: 'regex' }, DOM)));

// ① 數值：千分位要吃得下
check('① 數值比較吃得下千分位', !(await run({ selector: '.balance', value: '>=1000', matchMode: 'number' }, DOM)));
check('① 數值比較會擋下不符的', !!(await run({ selector: '.balance', value: '<100', matchMode: 'number' }, DOM)));
check('① 等於也能用', !(await run({ selector: '.balance', value: '=31568677510.61', matchMode: 'number' }, DOM)));
check('① 期望值不是數字要報錯', /不是數字/.test(await run({ selector: '.balance', value: '>=abc', matchMode: 'number' }, DOM)));

// ② 找不到 vs 沒有字
const missing = await run({ nodeName: 'lb_nope', value: 'x' }, {});
check('② 找不到節點要明講', /找不到/.test(missing), missing);
const empty = await run({ nodeName: 'lb_empty', value: 'x' }, { '@node:lb_empty': '' });
check('② 節點上沒字 → 比對失敗（不是通過）', !!empty && !/找不到/.test(empty), empty);

// ③ 訊息要帶讀到的內容
const why = await run({ selector: '.title', value: 'Dragon' }, DOM);
check('③ 失敗訊息帶得出讀到什麼', /Good/.test(why), why);

// 設定錯誤
check('兩個目標都填要報錯', /擇一/.test(await run({ selector: '.title', nodeName: 'lb_coin', value: 'x' }, DOM)));
check('兩個都不填要報錯', /擇一/.test(await run({ value: 'x' }, DOM)));
check('沒填期望值要報錯', /期望/.test(await run({ selector: '.title' }, DOM)));

// PC 那條線讀得到就算過
check('PC：讀 Cocos label', !(await run({ nodeName: 'lb_coin', value: '31,568', matchMode: 'contains' }, { '@node:lb_coin': '31,568,677,510.61' })));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, 'assert_text 測試有失敗項');
