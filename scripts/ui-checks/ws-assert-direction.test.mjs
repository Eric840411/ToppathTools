/**
 * `assert_ws_called` 的**方向對應**測試。
 *
 *   node scripts/ui-checks/ws-assert-direction.test.mjs
 *
 * 🚨 這支在守的不是「功能有沒有做」，是**一個假綠**：
 *    擷取器用的字是 `request` / `response` / `push`，不是 send / recv。
 *    第一版用開頭字母去對（send→'s'、recv→'r'），結果
 *      - `send:` 永遠 0 筆（'request' 開頭是 r）→ 每次都紅，看起來像「遊戲沒送出去」
 *      - `recv:` 對到了 **request**（自己送出去的）→ **綠燈，但驗的是反方向**
 *    兩個症狀都不會有人發現。所以這裡逐一釘死四種方向的對應。
 */
import assert from 'node:assert/strict';
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js';

const T0 = Date.now() - 1000;
/** 一輪 SPIN 的典型訊息：自己送一筆、server 回一筆、再推一筆 */
const MESSAGES = [
  { direction: 'request', route: 'gm.gmHandler.dealGMActionReq', payload: { isspin: 1, actionid: 7 }, ts: T0 + 10 },
  { direction: 'response', route: 'gm.gmHandler.dealGMActionReq', payload: { code: 0, win: 0 }, ts: T0 + 20 },
  { direction: 'push', route: 'onGMStatus', payload: { status: 'spinning' }, ts: T0 + 30 },
];

const fakePinus = () => ({ drain: async () => {}, messages: () => MESSAGES });
const fakePage = { waitForTimeout: async () => {} };

async function run(step) {
  const lines = [];
  return runFrontendStep(step, {
    idx: '[1/1]', label: step.name ?? step.action,
    log: (l) => { lines.push(l); },
    page: fakePage,
    pinus: fakePinus(),
    state: { wsMark: T0 },
  }).then(() => ({ ok: true, lines }), (e) => ({ ok: false, why: e.message }));
}

const base = { action: 'assert_ws_called', name: 'ws' };
let pass = 0, fail = 0;
const check = async (title, step, want) => {
  const got = await run({ ...base, ...step });
  const ok = got.ok === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok ? '' : `  ← 期望 ${want ? '通過' : '失敗'}，實際 ${got.ok ? '通過' : `失敗：${got.why}`}`}`);
  ok ? pass++ : fail++;
};

console.log('assert_ws_called 方向對應');
// send: 只算我們送出去的 request
await check('send: 對到 request', { value: 'send:dealGMActionReq' }, true);
// recv: 只算收回來的（response 與 push），**不可以**對到 request
await check('recv: 對到 response', { value: 'recv:dealGMActionReq' }, true);
await check('recv: 對到 push', { value: 'recv:onGMStatus' }, true);
await check('send: 不可對到只有 push 的 route', { value: 'send:onGMStatus' }, false);
// 沒寫方向＝兩邊都算
await check('不寫方向＝不限方向', { value: 'dealGMActionReq' }, true);
// payload 比對：使用者寫 isspin:1，實際是 {"isspin":1}
await check('payload 寬鬆比對（引號／空白不影響）', { value: 'send:dealGMActionReq', selector: 'isspin:1' }, true);
await check('payload 對不上要紅', { value: 'send:dealGMActionReq', selector: 'isspin:9' }, false);
// 界線之前的訊息不算
{
  const got = await runFrontendStep({ ...base, value: 'send:dealGMActionReq' }, {
    idx: '', label: '', log: () => {}, page: fakePage, pinus: fakePinus(),
    state: { wsMark: Date.now() + 5000 },   // 界線推到未來＝這一步之後什麼都沒有
  }).then(() => ({ ok: true }), (e) => ({ ok: false, why: e.message }));
  const ok = !got.ok;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  界線之前的舊訊息不算`);
  ok ? pass++ : fail++;
  // 失敗訊息要帶診斷（不然三種原因長得一樣）
  const hasDetail = !got.ok && /route|一筆都沒有/.test(got.why ?? '');
  console.log(`  ${hasDetail ? 'PASS' : 'FAIL'}  失敗訊息有帶「實際看到什麼」`);
  hasDetail ? pass++ : fail++;
}
// minCount
await check('minCount 不足要紅', { value: 'send:dealGMActionReq', minCount: 2 }, false);

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '方向對應測試有失敗項');
