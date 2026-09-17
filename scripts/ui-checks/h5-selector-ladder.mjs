/**
 * scripts/ui-checks/h5-selector-ladder.mjs
 *
 * H5/PC 錄製器改用共用選擇器階梯之後的**接線**檢查。
 *
 * 行為本身由 `server/uat-runner/frontend-recorder.browser-test.mjs` 驗（真的開 Chrome、
 * 真的點下去）。這一支只驗「有沒有接上」——因為這次的失敗方式全是安靜的：
 *
 *   ① 只有一個 host 換掉 → 兩種模式錄出不同的腳本，沒有任何錯誤
 *   ② 重播沒走共用解析 → `label=` 被當成未知引擎、`text=` 的語意跟重播不同
 *   ③ 舊腳本的 `fill` 在伺服器模式沒對應 → 「不支援的動作 → **skipped**」，腳本照樣 PASS
 *   ④ 新欄位沒進 cleanStep → 畫面上編得好好的，存檔後參數消失
 *   ⑤ 新檔案沒進 agent 白名單 → agent 在 **import 當下**整支炸掉
 *
 * 跑法：node scripts/ui-checks/h5-selector-ladder.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './lib/strip-comments.mjs';
import { selectorLadderSource, genericAdapterSource, elementUiAdapterSource } from '../../server/uat-runner/selector-ladder.js';
import { frontendRecorderScript } from '../../server/uat-runner/frontend-recorder.js';
import { backendRecorderScript } from '../../server/uat-runner/backend-recorder.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = stripComments;

const agentRunner = strip(read('server/agent-runner.ts'));
const frontendAuto = strip(read('server/routes/frontend-auto.ts'));
const machineTest = strip(read('server/routes/machine-test.ts'));
const hashSrc = strip(read('server/agent-source-hash.ts'));
const stepModel = strip(read('src/features/uat/step-model.ts'));
const studio = strip(read('src/features/uat/FrontendAutomationStudio.tsx'));
const typesTs = strip(read('src/features/uat/types.ts'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

// ── ① 兩個 host 共用同一份錄製器 ──────────────────────────────────────────
check('① agent 模式用共用錄製器', /frontendRecorderScript\s*\(\s*\)/.test(agentRunner));
check('① 伺服器模式用共用錄製器', /frontendRecorderScript\s*\(\s*\)/.test(frontendAuto));
for (const [label, src] of [['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  // 自己又長出一支錄製器的痕跡：直接印 marker、或自己寫一份 cssPath
  check(`① ${label} 沒有自己再寫一份錄製器`,
    !/console\.info\('__TOPPATH_RECORDER__'/.test(src) && !/const cssPath = \(el\)/.test(src),
    '兩邊各一份已經漂過一次：click/fill vs click_viewport/type');
}

// ── ② 階梯只有一份，Element 規則留在 adapter ──────────────────────────────
const ladder = selectorLadderSource(genericAdapterSource());
const backendScript = backendRecorderScript({ sessionId: 's' });
const h5Script = frontendRecorderScript();
for (const fn of ['stableAttr', 'byLabel', 'byTableCell', 'byStableRegion', 'byText', 'cssPath', 'describe']) {
  check(`② 階梯含 ${fn}`, ladder.includes(`function ${fn}(`) || ladder.includes(`${fn} = (`));
  check(`② Backend 注入的腳本也含 ${fn}（同一份）`, backendScript.includes(fn));
  check(`② H5 注入的腳本也含 ${fn}（同一份）`, h5Script.includes(fn));
}
// ⚠️ 這條是負面斷言：H5 拿到 Element 的規則等於階梯沒有按框架切開。
check('② ⚠️ H5 的腳本裡沒有 Element UI 專用規則',
  !h5Script.includes('el-form-item') && !h5Script.includes('el-select-dropdown') && !h5Script.includes('el-menu-item'),
  'H5 是 Vue 3，吃不到 Element 的 class；混進去只會產生永遠命中 0 的選擇器');
check('② Backend 仍然拿得到 Element 專用規則',
  backendScript.includes('el-form-item__label') && backendScript.includes('el-select-dropdown'));
check('② Element adapter 提供 actionable / byLabelExtra / strategies 三樣',
  ['actionable', 'byLabelExtra', 'strategies'].every(k => elementUiAdapterSource().includes(k)));
// ⚠️ 注入的原始碼是 template literal 產的，單槓的 \s 會被吃成字母 s。
// ⚠️ 負面斷言要先剝註解——註解裡就寫著壞掉的那個形狀，不剝的話它會匹配到
//    「說明文字」而不是程式碼。第一次跑就中了這一槍。
check('② ⚠️ 注入後的正則沒被轉義吃掉（\\s 還是 \\s）',
  backendScript.includes('[:：*]\\s*$') && !/\[:：\*\]s\*\$/.test(strip(backendScript)),
  '單槓的 \\s 在 template literal 裡會變成 s，變成「去掉結尾字母 s」而不是去空白');

// ── ③ H5 錄的東西 ────────────────────────────────────────────────────────
// ⚠️ 只驗「字串裡有 nativeSelectorCheck」是假的——那支函式的**定義**本來就在裡面，
//    把呼叫拿掉照樣全綠（注入測試抓到過）。要驗的是它真的被拿來驗剛產出的那條。
check('③ 錄製時就驗選擇器', /nativeSelectorCheck\(d\.selector/.test(h5Script),
  '只檢查函式存不存在的話，把呼叫拿掉也不會紅');
check('③ 積木帶 selectorStrategy 與 selectorCheck',
  h5Script.includes('selectorStrategy') && h5Script.includes('selectorCheck'));
check('③ canvas 上的點擊走座標', h5Script.includes("action: 'click_viewport'"),
  'canvas 裡沒有 DOM 可以指，硬產選擇器只會是假的');
check('③ ⚠️ 輸入錄成 type 不是 fill', h5Script.includes("action: 'type'") && !h5Script.includes("action: 'fill'"),
  'fill 在伺服器模式的引擎裡不存在，會被當成不支援的動作**跳過**而腳本照樣 PASS');

// ── ④ 重播走共用解析 ──────────────────────────────────────────────────────
for (const [label, src] of [['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`④ ${label} 建立共用定位器`, /createRecordedLocators\(page,\s*\{\s*requireUnique:\s*true/.test(src),
    'requireUnique：命中多筆要大聲失敗，不能安靜取第一個');
  // ⚠️ 少了這個，接上共用解析反而比舊寫法**更早失敗**：命中 0 當下就拋，
  //    Playwright 那 10 秒等待（在拿到 locator 之後才開始）根本走不到。
  //    H5/PC 的按鈕與輸入框幾乎都是非同步渲染的。（CodeX 2026-09-18 指出）
  check(`④ ${label} 解析要在期限內重試`, /resolveTimeoutMs:\s*\d+/.test(src),
    '不重試等於把「等一下就會出現」變成「立刻失敗」');
  check(`④ ${label} 不再直接 page.locator(step.selector)`,
    !/page\.locator\(step\.selector/.test(src),
    'label= 會被 Playwright 當成未知引擎而拋錯，text= 的語意也跟重播不同');
}
check('④ 伺服器模式認得舊腳本的 fill', /step\.action === 'type' \|\| step\.action === 'fill'/.test(frontendAuto),
  '沒有的話舊腳本會落到 skipped，而 skipped 不算失敗');

// ── ⑤ agent 白名單與重啟清單 ─────────────────────────────────────────────
for (const file of ['selector-ladder.js', 'frontend-recorder.js']) {
  check(`⑤ ${file} 在 AGENT_SOURCE_WHITELIST 裡`,
    new RegExp(`'uat-runner/${file.replace('.', '\\.')}'\\s*:`).test(machineTest),
    'agent-runner.ts 靜態 import 它，漏了 agent 會在 import 當下炸掉');
  check(`⑤ ${file} 在 RESTART_REQUIRED_SOURCES 裡`,
    hashSrc.includes(`'uat-runner/${file}'`),
    '不重啟的話 agent 會繼續注入舊的腳本，而畫面上看起來已經更新了');
}

// ── ⑥ 新欄位存得下來、畫得出來 ────────────────────────────────────────────
for (const field of ['selectorStrategy', 'selectorCheck', 'selectorCheckReason']) {
  check(`⑥ AutoStep 有 ${field}`, typesTs.includes(`${field}?:`));
  check(`⑥ parseSteps 讀得到 ${field}`, stepModel.includes(`row.${field}`));
  check(`⑥ cleanStep 存得下 ${field}`, new RegExp(`'${field}'`).test(stepModel),
    '漏了的話步驟在畫面上編得好好的，存檔後參數消失且不報錯');
}
// ⚠️ 同上：只檢查 import 有沒有那個名字是假的，把用到的地方換掉也不會紅。
check('⑥ 前端用共用的措辭表把 selectorCheck 翻成人話',
  /SELECTOR_CHECK_LABEL\[String\(step\.selectorCheck\)\]/.test(studio),
  '各寫一份的下場是「Backend 說壞了、H5 說沒事」');
check('⑥ 前端會標出最脆的那一階', /selectorStrategy === 'cssPath'/.test(studio));

// ── ⑦ CDP port 不能是亂數 ────────────────────────────────────────────────
check('⑦ 本機錄製的 Chrome 由它自己挑 port', frontendAuto.includes('DEBUG_PORT_ARG'),
  '亂數撞號時不會失敗，會安靜地接到別人的瀏覽器');
check('⑦ ⚠️ 沒有殘留的亂數 port', !/9300 \+ Math\.floor\(Math\.random/.test(frontendAuto));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
