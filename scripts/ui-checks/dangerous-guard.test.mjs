/**
 * 危險操作守衛的測試。
 *
 *   node scripts/ui-checks/dangerous-guard.test.mjs
 *
 * 守的是「按下去就回不來」的那幾種操作（預約鎖機 24 小時、帶入額度、充值）。
 * 這支釘住四件事，其中兩件是 CodeX 2026-09-20 特別交代的：
 *   ① **擋在動作之前**——不是點完才報警。測法：假的 page 會記錄「有沒有被點」，
 *      擋下來的那一輪**一次都不能被點到**。
 *   ② **不只看按鈕文字**——文字會翻譯、會改版。只有文字命中時算 weak，不用來擋。
 *   ③ 放行是**這一顆積木**的事，不是整輪的開關。
 *   ④ **正式環境連放行都不接受。**
 */
import assert from 'node:assert/strict';
import { classifyDanger, guardDangerousStep, isProdLike } from '../../server/uat-runner/dangerous-actions.js';
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js';
import { runSteps } from '../../server/uat-runner/block-engine.js';

const QAT = 'https://osm-redirect.osmslot.org/?token=x&studioid=cp&gameid=osmbwjl';
const PROD = 'https://osm-h5-prod.osmslot.org/?token=x';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

console.log('危險操作守衛');

// ── ② 依副作用辨識，不是只看字 ──────────────────────────────────────────────
check('② 選擇器命中＝strong', classifyDanger({ selector: '.reserve-btn-long' })?.strength === 'strong');
check('② 節點名命中＝strong', classifyDanger({ node: 'play_btn1' })?.strength === 'strong');
check('② 路徑形式也認得', classifyDanger({ node: 'Canvas>panel>play_btn1' })?.strength === 'strong');
check('② 只有文字命中＝weak（不用來擋）', classifyDanger({ selector: '.whatever', text: 'Reserve Now' })?.strength === 'weak');
check('② 無關的東西不誤判', classifyDanger({ selector: '.btn-close', text: 'Close' }) === null);

// ── ③④ 放行與環境 ──────────────────────────────────────────────────────────
const reserveStep = { action: 'click', name: '預約', selector: '.reserve-btn-long' };
check('③ 沒放行就擋下來', !!throws(() => guardDangerousStep({ step: reserveStep, what: { selector: reserveStep.selector }, startUrl: QAT })));
check('③ 放行之後可以過', !throws(() => guardDangerousStep({ step: { ...reserveStep, allowDangerous: true }, what: { selector: reserveStep.selector }, startUrl: QAT })));
check('③ 放行不會外溢到別顆', !!throws(() => guardDangerousStep({ step: reserveStep, what: { selector: reserveStep.selector }, startUrl: QAT })));
const prodWhy = throws(() => guardDangerousStep({ step: { ...reserveStep, allowDangerous: true }, what: { selector: reserveStep.selector }, startUrl: PROD }));
check('④ 正式環境連放行都不接受', !!prodWhy && /正式環境/.test(prodWhy), prodWhy);
check('④ 認得出正式網域', isProdLike(PROD) === true && isProdLike('https://qat-cp.osmslot.org') === false);
check('④ 認不出來的網址當成正式（寧可嚴）', isProdLike('https://example.com') === true && isProdLike('') === true);
check('弱訊號不擋人', !throws(() => guardDangerousStep({ step: { action: 'click', name: 'Reserve Now 說明', selector: '.tip' }, what: { selector: '.tip', text: 'Reserve Now' }, startUrl: QAT })));

// ── ① 擋在動作之前 ─────────────────────────────────────────────────────────
{
  let clicks = 0;
  const fakePage = {
    locator: () => ({ count: async () => 1, first: () => ({ isVisible: async () => true }), click: async () => { clicks++; } }),
    mouse: { click: async () => { clicks++; } },
    waitForTimeout: async () => {},
  };
  const run = (step) => runFrontendStep(step, {
    idx: '', label: step.name, log: () => {}, page: fakePage, startUrl: QAT, state: {},
    recordedLocator: async () => { clicks++; return fakePage.locator(); },
  }).then(() => '', (e) => e.message);

  const why = await run({ action: 'click', name: '按 Reserve Now', selector: '.reserve-btn-long' });
  check('① 危險的 click 被擋下來', !!why, why);
  check('① 而且**一次都沒點到**（擋在動作之前）', clicks === 0, `實際點了 ${clicks} 次`);

  clicks = 0;
  const why2 = await run({ action: 'pc_click_node', name: '帶入額度', value: 'play_btn1' });
  check('① 危險的 pc_click_node 也擋', !!why2, why2);
  check('① PC 這條也沒點到', clicks === 0, `實際點了 ${clicks} 次`);
}


// ── 後台（CP／NC 管理站）：破壞性操作也要擋 ────────────────────────────
{
  const UAT = 'http://uat-cp.osmslot.org';
  const del = { action: 'click', name: '刪除這筆設定', selector: '.el-button--danger' };
  check('後台：刪除鈕沒放行要擋', !!throws(() => guardDangerousStep({ step: del, what: { selector: del.selector }, startUrl: UAT })));
  check('後台：放行值用字串 yes 也算數（後台表單只有下拉）',
    !throws(() => guardDangerousStep({ step: { ...del, allowDangerous: 'yes' }, what: { selector: del.selector }, startUrl: UAT })));
  check('後台：一般 Save 不擋（全擋會讓人養成閉眼按確定的習慣）',
    !throws(() => guardDangerousStep({ step: { action: 'click', name: '儲存', selector: '.btn-save' }, what: { selector: '.btn-save', text: 'Save' }, startUrl: UAT })));
  check('後台：只有文字像補發＝弱訊號，不擋人',
    !throws(() => guardDangerousStep({ step: { action: 'click', name: '看補發紀錄', selector: '.link' }, what: { selector: '.link', text: 'Resend Record' }, startUrl: UAT })));

  // 積木層：擋下來的那一輪不可以真的點下去
  let clicked = 0;
  const ctx = {
    page: { evaluate: async () => ({}), waitForTimeout: async () => {} },
    clickSelector: async () => { clicked++; return 'selector' },
    backendUrl: UAT,
  };
  const r = await runSteps([{ action: 'click', name: '刪除', selector: '.el-button--danger' }], ctx, {});
  check('後台積木：被擋時一次都沒點到（擋在動作之前）', clicked === 0 && r.criticalFails.length > 0, `點了 ${clicked} 次`);
  const r2 = await runSteps([{ action: 'click', name: '刪除', selector: '.el-button--danger', allowDangerous: 'yes' }], ctx, {});
  check('後台積木：放行之後點得下去', clicked === 1 && r2.criticalFails.length === 0, `點了 ${clicked} 次｜${r2.notes}`);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '危險操作守衛測試有失敗項');
