/**
 * 錄製器注入 PC 反查器之後的**靜態檢查**。
 *
 *   node scripts/ui-checks/recorder-pc-node.test.mjs
 *
 * 這支擋的是兩個「不會有人發現」的破壞：
 *   ① 反查器的原始碼裡出現**反引號或 ${}** → 注入字串被提前結束。
 *      症狀是整個錄製器掛掉（連 DOM 那條線一起），錯誤訊息指不到真正的位置。
 *      ⚠️ `node --check pc-node-hittest.js` **檢查不到**——那個檔案本身是合法的，
 *      壞掉的是它被塞進別人的樣板字串之後。
 *   ② 注入腳本整段語法錯 → 同上，而且 lint 與 tsc 都照樣過。
 */
import assert from 'node:assert/strict';
import { PC_HITTEST_SOURCE } from '../../server/uat-runner/pc-node-hittest.js';
import { frontendRecorderScript } from '../../server/uat-runner/frontend-recorder.js';
import { backendRecorderScript } from '../../server/uat-runner/backend-recorder.js';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};

console.log('錄製器 × PC 節點反查');

check('反查器原始碼沒有反引號', !PC_HITTEST_SOURCE.includes('`'));
check('反查器原始碼沒有 ${}', !PC_HITTEST_SOURCE.includes('${'));

const src = frontendRecorderScript();
check('注入腳本含反查器', src.includes('__uatPcHit'));
check('注入腳本會錄 pc_click_node', src.includes('pc_click_node'));
check('反查不到時仍退回座標', src.includes('click_viewport'));

// 語法：能被解析就好，不要執行（裡面碰 document／window）
let syntaxError = '';
try { new Function(src); } catch (e) { syntaxError = e.message; }
check('注入腳本語法正確', !syntaxError, syntaxError);

// 反查器本身也要能單獨解析
let hitError = '';
try { new Function(PC_HITTEST_SOURCE); } catch (e) { hitError = e.message; }
check('反查器語法正確', !hitError, hitError);


// ── 後台錄製器也要有危險操作守衛（2026-09-20 補）──────────────────────
{
  const beSrc = backendRecorderScript({ sessionId: 'test', bindings: [] });
  check('後台注入腳本含危險規則', beSrc.includes('__uatDanger'));
  check('後台守衛用 stopImmediatePropagation（否則擋得住人擋不住腳本）', beSrc.includes('stopImmediatePropagation'));
  let beErr = '';
  try { new Function(beSrc); } catch (e) { beErr = e.message; }
  check('後台注入腳本語法正確', !beErr, beErr);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, '錄製器 PC 節點檢查有失敗項');
