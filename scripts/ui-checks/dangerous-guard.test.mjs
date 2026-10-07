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
  // 1007 CodeX（c752535 審查 P2）：原本的假頁面沒有 url()、也沒有 ctx.pc——H5 其實是 TypeError 停下、PC 根本沒走到護欄，
  // 「被擋」是假綠燈。現在假頁面補齊，**斷言錯誤是護欄自己的訊息**，並加「放行後真的點得下去」當對照組。
  let clicks = 0;
  let curUrl = QAT;
  const fakeLocator = () => ({ count: async () => 1, first: () => ({ isVisible: async () => true, click: async () => { clicks++; } }), click: async () => { clicks++; }, nth: () => fakeLocator(), evaluate: async () => {}, elementHandle: async () => null, isVisible: async () => true, boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }), scrollIntoViewIfNeeded: async () => {} });
  const fakePage = {
    url: () => curUrl,
    locator: fakeLocator,
    mouse: { click: async () => { clicks++; } },
    waitForTimeout: async () => {},
    evaluate: async () => ({}),
  };
  const fakePc = {
    sceneName: async () => 'lobby',
    closePopups: async () => 0,
    clickNode: async (_page, want) => { clicks++; return { ok: true, name: want, at: { x: 1, y: 1 } }; },
  };
  const run = (step) => runFrontendStep(step, {
    idx: '', label: step.name, log: () => {}, page: fakePage, startUrl: QAT, state: {}, pc: fakePc,
    recordedLocator: async () => fakeLocator(),
  }).then(() => '', (e) => e.message);
  const GUARD = /允許這個危險操作|任何放行都不接受/;

  const why = await run({ action: 'click', name: '按 Reserve Now', selector: '.reserve-btn-long' });
  check('① 危險的 click 被**護欄**擋下來', GUARD.test(why), why);
  check('① 而且**一次都沒點到**（擋在動作之前）', clicks === 0, `實際點了 ${clicks} 次`);

  clicks = 0;
  const why2 = await run({ action: 'pc_click_node', name: '帶入額度', value: 'play_btn1' });
  check('① 危險的 pc_click_node 也被**護欄**擋', GUARD.test(why2), why2);
  check('① PC 這條也沒點到', clicks === 0, `實際點了 ${clicks} 次`);

  // 對照組：QAT 上放行 → 真的點得下去（證明上面的「沒點到」是護欄造成的，不是假頁面不會點）
  clicks = 0;
  const ok1 = await run({ action: 'pc_click_node', name: '帶入額度', value: 'play_btn1', allowDangerous: true });
  check('① 對照：QAT 放行之後 PC 真的點了', ok1 === '' && clicks === 1, `${ok1}｜點了 ${clicks} 次`);
  clicks = 0;
  const ok2 = await run({ action: 'click', name: '按 Reserve Now', selector: '.reserve-btn-long', allowDangerous: true });
  check('① 對照：QAT 放行之後 H5 click 真的點了', ok2 === '' && clicks >= 1, `${ok2}｜點了 ${clicks} 次`);

  // 起始 QAT、目前頁面已經是正式站 → 放行也擋、零點擊
  curUrl = 'https://osm-h5.osmslot.com/game';
  clicks = 0;
  const why3 = await run({ action: 'pc_click_node', name: '帶入額度', value: 'play_btn1', allowDangerous: true });
  check('① 導到正式站後：PC 放行也擋、零點擊', /任何放行都不接受/.test(why3) && clicks === 0, `${why3}｜點了 ${clicks} 次`);
  const why4 = await run({ action: 'click', name: '按 Reserve Now', selector: '.reserve-btn-long', allowDangerous: true });
  check('① 導到正式站後：H5 放行也擋、零點擊', /任何放行都不接受/.test(why4) && clicks === 0, `${why4}｜點了 ${clicks} 次`);
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
  let backendCur = UAT + '/#/machine';
  const ctx = {
    page: { url: () => backendCur, evaluate: async () => ({}), waitForTimeout: async () => {} },
    clickSelector: async () => { clicked++; return 'selector' },
    backendUrl: UAT,
  };
  const r = await runSteps([{ action: 'click', name: '刪除', selector: '.el-button--danger' }], ctx, {});
  check('後台積木：被擋時一次都沒點到（擋在動作之前）', clicked === 0 && r.criticalFails.length > 0, `點了 ${clicked} 次`);
  const r2 = await runSteps([{ action: 'click', name: '刪除', selector: '.el-button--danger', allowDangerous: 'yes' }], ctx, {});
  check('後台積木：放行之後點得下去', clicked === 1 && r2.criticalFails.length === 0, `點了 ${clicked} 次｜${r2.notes}`);
  // 1007 CodeX（c752535 審查 P1）：起始 UAT、目前頁面已導到正式後台 → 放行 yes 也擋、零點擊
  backendCur = 'https://cp.osmslot.com/#/machine';
  clicked = 0;
  const r3 = await runSteps([{ action: 'click', name: '刪除', selector: '.el-button--danger', allowDangerous: 'yes' }], ctx, {});
  check('後台積木：導到正式站後放行也擋、零點擊', clicked === 0 && r3.criticalFails.length > 0 && /任何放行都不接受/.test(JSON.stringify(r3.criticalFails)), `點了 ${clicked} 次｜${JSON.stringify(r3.criticalFails).slice(0, 160)}`);
}

// 1007 CodeX（af25442 審查 P1）：正式／測試只看 hostname，未知一律當正式；操作當下的網址也要是測試環境
check('⑤ 正式網址帶 ?note=uat 不能被當成測試環境', isProdLike('https://osm-h5.osmslot.com/?note=uat') === true && isProdLike('https://osm-h5-prod.osmslot.org/?env=qat') === true);
check('⑤ 路徑裡有 test 也不算', isProdLike('https://osm-h5.osmslot.com/test/page') === true);
check('⑤ 認得的測試 hostname 照舊', isProdLike('https://uat-osm-redirect.osmslot.org/x') === false && isProdLike('https://qat-cp.osmslot.org') === false && isProdLike(QAT) === false);
check('⑤ 別人的網域帶 uat 字樣也當正式', isProdLike('https://uat.evil.com') === true && isProdLike('not a url') === true);
check('⑤ 起始是 QAT、操作當下已導到正式站 → 擋（放行也不接受）', !!throws(() => guardDangerousStep({ step: { ...reserveStep, allowDangerous: true }, what: { selector: reserveStep.selector }, startUrl: QAT, currentUrl: 'https://osm-h5.osmslot.com/game' })));
check('⑤ 起始與當下都是 QAT → 放行可以過', !throws(() => guardDangerousStep({ step: { ...reserveStep, allowDangerous: true }, what: { selector: reserveStep.selector }, startUrl: QAT, currentUrl: 'https://uat-h5.osmslot.org/game' })));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '危險操作守衛測試有失敗項');
