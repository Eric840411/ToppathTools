/**
 * `require_precondition` → **受阻（blocked）** 的判定測試。
 *
 *   node scripts/ui-checks/precondition-blocked.test.mjs
 *
 * 這一態存在的理由：像「Lucky Hour Bonus 活動要開著」這種條件，環境沒備好時
 * 腳本一定過不了。判 FAIL 是**對著 Lark 謊報一個不存在的 bug**；判 PASS 更糟；
 * 判「待確認」會混進一堆真的需要人看的項目裡。所以要分出第三態。
 *
 * 釘住四件事（後兩件是 CodeX 2026-09-20 指出的邊界）：
 *   ① 條件不成立 → blocked，而且**不是** fail
 *   ② 條件成立 → 照常往下跑
 *   ③ **前置檢查自己設定錯（沒填說明、兩個欄位都填）→ FAIL**，不可以吞成 blocked
 *   ④ 同一筆 TC 裡既有真失敗又有受阻 → **報 FAIL**（受阻＝沒測到，硬失敗＝測到而且壞了）
 */
import assert from 'node:assert/strict';
import { createFrontendTcEngine } from '../../server/uat-runner/frontend-tc-engine.js';
import { runMultiTcSteps } from '../../server/uat-runner/multi-tc.js';

/** 假的 page：只要能回答「這個選擇器有沒有命中」就夠了 */
const fakePage = (present) => {
  const node = (sel) => ({
    count: async () => (present.includes(sel) ? 1 : 0),
    first: () => node(sel),
    isVisible: async () => present.includes(sel),
    // assert_visible 走 waitFor：沒命中就丟，跟真的 Playwright 一樣
    waitFor: async () => { if (!present.includes(sel)) throw new Error(`Timeout waiting for ${sel}`); },
  });
  return { locator: node, waitForTimeout: async () => {} };
};

const hostCtx = (present) => ({
  page: fakePage(present),
  log: () => {},
  startUrl: 'https://example.invalid',
  recordedLocator: async () => { throw new Error('這個測試不該點東西'); },
});

async function runCase(steps, present) {
  const engine = createFrontendTcEngine(hostCtx(present));
  const { results } = await runMultiTcSteps(steps, { engine }, [{ recordId: 'rec1', text: 'TC 一' }]);
  return results[0];
}

const P = (over = {}) => ({
  action: 'require_precondition', name: '活動要開著', tcId: 'rec1',
  selector: '.lucky-bonus-entry', reason: 'Lucky Hour Bonus 時段沒開，這條沒東西可測', ...over,
});
/** 一顆一定會過的檢查（讓「條件成立」那case 有 assertion 可算） */
const OK_CHECK = { action: 'assert_visible', name: '入口在', tcId: 'rec1', selector: '.lucky-bonus-entry' };
const BAD_CHECK = { action: 'assert_visible', name: '不存在的東西', tcId: 'rec1', selector: '.nope' };

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};

console.log('require_precondition → blocked');

// ① 條件不成立
{
  const row = await runCase([P(), OK_CHECK], []);
  check('① 條件不成立 → outcome=blocked', row.outcome === 'blocked', `實際 ${row.outcome}`);
  check('① 不可以變成 fail', row.outcome !== 'fail');
  check('① 報告要帶原因', /時段沒開/.test(row.error ?? '') || /時段沒開/.test(row.notes ?? ''), row.error ?? row.notes);
}

// ② 條件成立 → 照常跑完
{
  const row = await runCase([P(), OK_CHECK], ['.lucky-bonus-entry']);
  check('② 條件成立 → outcome=pass', row.outcome === 'pass', `實際 ${row.outcome}（${row.error ?? row.notes}）`);
}

// ③ 前置檢查自己設定錯 → FAIL，不可以吞成 blocked
{
  const noReason = await runCase([P({ reason: '' }), OK_CHECK], ['.lucky-bonus-entry']);
  check('③ 沒填說明 → fail（不是 blocked）', noReason.outcome === 'fail', `實際 ${noReason.outcome}`);
  const both = await runCase([P({ value: 'btn-activity' }), OK_CHECK], ['.lucky-bonus-entry']);
  check('③ 兩個欄位都填 → fail（不是 blocked）', both.outcome === 'fail', `實際 ${both.outcome}`);
}

// ④ 真失敗與受阻同時存在 → 報 FAIL
{
  const row = await runCase([BAD_CHECK, P(), OK_CHECK], []);
  check('④ 同時有硬失敗與受阻 → fail 優先', row.outcome === 'fail', `實際 ${row.outcome}`);
}

// ⑤ 綁了 TC 卻沒有任何有效斷言 → **不可以判綠**（CodeX 2026-09-20）
{
  const row = await runCase([{ action: 'wait', name: '等一下', tcId: 'rec1', value: '10' }], ['.lucky-bonus-entry']);
  check('⑤ 零有效斷言不可判綠', row.outcome !== 'pass', `實際 ${row.outcome}`);
  check('⑤ 而且要講得出原因', /檢查|確認/.test(row.notes ?? ''), row.notes);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '受阻判定測試有失敗項');
