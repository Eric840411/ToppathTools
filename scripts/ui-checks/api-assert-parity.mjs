/**
 * `assert_api_called` 在三個引擎上的一致性與接線。
 *
 * 這顆積木在三個地方被執行：Backend（`block-engine.js`）、H5/PC 的 agent 模式
 * （`agent-runner.ts`）、H5/PC 的伺服器模式（`frontend-auto.ts`）。
 *
 * 壞法全是安靜的：
 *   ① 判定規則各寫一份 → 「同一條斷言，Backend 判過、H5 判不過」，兩邊都不報錯
 *   ② H5/PC 少接一個引擎 → 那個引擎落到 `⏭ 不支援的動作` 分支，**skipped 不是 failed**，
 *      腳本照樣 PASS。這正是「零斷言不得通過、假通過比報錯更糟」
 *   ③ 拿不到網路紀錄時 skip 而不是 fail → 同上
 *   ④ `netMark` 沒在 goto 之後推進 → 第一次 goto 之前的請求永遠留在集合裡，
 *      斷言變成幾乎不可能失敗
 *   ⑤ `cleanStep` 漏掉新欄位 → 步驟在畫面上編得好好的，存檔後參數消失且不報錯
 *   ⑥ 只有一邊存 `urlPattern` → 「錄的時候明明有，跑起來永遠對不上」
 *
 * 跑法：node scripts/ui-checks/api-assert-parity.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './lib/strip-comments.mjs';
import { evaluateApiAssertion, wildcardToRegExp } from '../../server/uat-runner/api-assert.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// ⚠️ 剝註解**不能用純正則**。XPath 字串 "//*[...]" 裡的 /* 會被當成區塊註解開頭，
//    一路吃到下一個 */——實測在 agent-runner.ts 上刪掉了 31% 的真實程式碼，
//    而被刪掉的部分會讓斷言誤報、更糟的是讓「不得出現某模式」那類斷言假通過。
const strip = stripComments;

const blockEngine = strip(read('server/uat-runner/block-engine.js'));
const agentRunner = strip(read('server/agent-runner.ts'));
const frontendAuto = strip(read('server/routes/frontend-auto.ts'));
const stepModel = strip(read('src/features/uat/step-model.ts'));
const netCapture = strip(read('server/uat-runner/net-capture.js'));
const cdpCapture = strip(read('server/uat-runner/cdp-capture.js'));
const studio = strip(read('src/features/uat/FrontendAutomationStudio.tsx'));
const machineTest = strip(read('server/routes/machine-test.ts'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

// ── ① 規則只有一份 ────────────────────────────────────────────────────────
for (const [label, src] of [['block-engine', blockEngine], ['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`① ${label} 用共用的 evaluateApiAssertion`, /evaluateApiAssertion\s*\(/.test(src));
}
// 自己重寫判定的痕跡：出現 2xx 的範圍比較就是又算了一次
for (const [label, src] of [['block-engine', blockEngine], ['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`① ${label} 沒有自己做狀態碼判定`,
    !/>=\s*200\s*&&[\s\S]{0,40}<\s*300/.test(src),
    '狀態碼判定應該只存在 api-assert.js 裡');
}

// ── ②③ 兩個 H5/PC 引擎都要接，而且拿不到紀錄要 fail ──────────────────────
for (const [label, src] of [['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`② ${label} 有 assert_api_called 分支`,
    /step\.action === 'assert_api_called'/.test(src),
    '少一個引擎，那個模式會把斷言當成不支援的動作跳過，腳本照樣 PASS');
  // 「拿不到就 throw」而不是落到下面的 skip
  const blockStart = src.indexOf("step.action === 'assert_api_called'");
  const body = blockStart >= 0 ? src.slice(blockStart, blockStart + 1200) : '';
  check(`③ ${label} 拿不到網路紀錄時 throw（不是 skip）`,
    /if \(!netCapture\) throw new Error/.test(body),
    '被跳過的斷言比報錯更糟——腳本會綠著');
  check(`③ ${label} 沒填 urlPattern 時 throw`,
    /if \(!step\.urlPattern\) throw new Error/.test(body));
  check(`④ ${label} 只看 netMark 之後的紀錄`,
    /\.ts\) >= netMark/.test(body),
    '不篩的話整輪跑下來打過就算數，斷言幾乎不可能失敗');
}

// ── ④ netMark 要在 goto 之後推進 ──────────────────────────────────────────
for (const [label, src] of [['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`④ ${label} goto 之後會推進 netMark`,
    (src.match(/netMark = Date\.now\(\)/g) ?? []).length >= 2,
    '至少兩處：宣告與 goto 之後');
}

// ── ⑤ 新欄位要進 serialize ────────────────────────────────────────────────
check('⑤ cleanStep 會存 urlPattern', /'baselineId', 'urlPattern'/.test(stepModel),
  '漏了的話存檔後參數消失，而且不報錯');
check('⑤ cleanStep 會存 statusCode／minCount', /'statusCode', 'minCount'/.test(stepModel));
check('⑤ cleanStep 會存 expectStatus', /row\.expectStatus = step\.expectStatus/.test(stepModel));
check('⑤ 積木清單裡有 assert_api_called', /action: 'assert_api_called'/.test(stepModel));

// ── ⑥ 兩個 transport 都要存 urlPattern ────────────────────────────────────
check('⑥ Playwright adapter 存 urlPattern', /urlPattern: toUrlPattern\(request\.url\(\)\)/.test(netCapture),
  '執行端不存的話，「錄的時候明明有，跑起來永遠對不上」');
check('⑥ CDP adapter 存 urlPattern', /urlPattern: toUrlPattern\(info\.url\)/.test(cdpCapture));

// ── 前端入口 ──────────────────────────────────────────────────────────────
check('前端有「加入檢查」的入口', /createStep\('assert_api_called'\)/.test(studio));
check('前端存的是 urlPattern 不是原始網址',
  /step\.urlPattern = call\.urlPattern \|\| call\.url/.test(studio),
  '存原始網址的話，id／token／時間戳會讓它換一筆資料就全紅');
check('前端在輪詢與停止兩條路都更新 API 清單',
  (studio.match(/setRecApiCalls\(/g) ?? []).length >= 2,
  '少一邊的話「停止之後才想加斷言」會拿到舊清單');

// ── 三個地方各自宣告同一個步驟形狀，欄位要對齊 ────────────────────────────
// ⚠️ 前端 AutoStep、agent-runner 的 StepObj、frontend-auto 的 StepObj 是**三份
//    各自維護的型別**。漏掉一份的話 server 端讀得到值但 TS 說欄位不存在——
//    build 不會擋（server 型別錯誤只記進 log），所以會安靜地累積。
//    實測：這次漏了兩份，型別錯誤從 61 一口氣跳到 73。
const typesTs = strip(read('src/features/uat/types.ts'));
for (const field of ['urlPattern', 'expectStatus', 'statusCode', 'minCount']) {
  check(`欄位 ${field} 三個型別都有宣告`,
    // 用 includes 不用 RegExp：`?` 在正則裡是量詞，要寫成 `\?`，
    // 而這段是經過工具產生的——多一層跳脫就會變成「永遠比不到」的假紅。
    [typesTs, agentRunner, frontendAuto].every(src => src.includes(`${field}?:`)),
    '三份型別各自維護，漏一份 server 端就會出現「讀得到值但欄位不存在」的型別錯誤');
}

// ── agent 白名單 ──────────────────────────────────────────────────────────
check('api-assert.js 在 AGENT_SOURCE_WHITELIST 裡',
  /'uat-runner\/api-assert\.js'\s*:/.test(machineTest),
  'agent-runner.ts 靜態 import 它，漏了 agent 會在 import 當下炸掉');

// ── 判定規則本身（純函式，直接驗行為）────────────────────────────────────
const call = (url, status, urlPattern) => ({ url, status, urlPattern, method: 'GET' });
const P = 'https://g/api/spin/*';
check('規則：命中 + 2xx → 過',
  evaluateApiAssertion([call('https://g/api/spin/123', 200)], { urlPattern: P }).ok);
check('規則：命中但 500 → 不過，且說得出是狀態碼問題',
  (() => { const v = evaluateApiAssertion([call('https://g/api/spin/1', 500)], { urlPattern: P });
    return !v.ok && v.why.includes('狀態碼不符'); })());
check('規則：完全沒打到 → 不過，且說得出總共打了幾支',
  (() => { const v = evaluateApiAssertion([call('https://g/api/other', 200)], { urlPattern: P });
    return !v.ok && v.why.includes('完全沒有打到') && v.why.includes('1 支'); })());
// ⚠️ 這條的 fixture 要挑「**url 比不到、只有 urlPattern 比得到**」的情況，
//    否則拿掉那個分支照樣全綠（注入測試抓到過）。
//    真實情境就是這個：toUrlPattern 會把 query 整段拿掉，而畫面上顯示、
//    使用者點進來存成斷言的就是那個沒有 query 的 pattern。
check('規則：url 有 query 比不到時，靠 urlPattern 欄位比得到',
  (() => {
    const rec = call('https://g/api/spin?id=1', 200, 'https://g/api/spin');
    const onlyUrl = wildcardToRegExp('https://g/api/spin').test(rec.url);
    return onlyUrl === false
      && evaluateApiAssertion([rec], { urlPattern: 'https://g/api/spin' }).ok;
  })(),
  '前提是「只比 url 會失敗」，否則這條測不到那個分支');
check('規則：expectStatus=any 時 500 也算',
  evaluateApiAssertion([call('https://g/api/spin/1', 500)], { urlPattern: P, expectStatus: 'any' }).ok);
check('規則：expectStatus=exact 只認指定碼',
  evaluateApiAssertion([call('https://g/api/spin/1', 201)], { urlPattern: P, expectStatus: 'exact', statusCode: 201 }).ok
  && !evaluateApiAssertion([call('https://g/api/spin/1', 200)], { urlPattern: P, expectStatus: 'exact', statusCode: 201 }).ok);
check('規則：minCount 沒滿足 → 不過',
  !evaluateApiAssertion([call('https://g/api/spin/1', 200)], { urlPattern: P, minCount: 2 }).ok
  && evaluateApiAssertion([call('https://g/api/spin/1', 200), call('https://g/api/spin/2', 200)], { urlPattern: P, minCount: 2 }).ok);
// ⚠️ 要證明錨定，fixture 必須是「**把 ^$ 拿掉就會誤中**」的形狀。
//    原本用的是完全不相干的網址——有沒有錨定都不會中，等於沒測（注入測試抓到過）。
check('規則：尾端要錨定（spin 不可以命中 spinner）',
  !evaluateApiAssertion([call('https://g/api/spinner', 200)], { urlPattern: 'https://g/api/spin' }).ok,
  '少了 $ 的話 spin 會命中 spinner');
check('規則：開頭要錨定（不可以只比子字串）',
  !evaluateApiAssertion([call('https://g/api/spin/1', 200)], { urlPattern: 'api/spin/*' }).ok,
  '少了 ^ 的話任何網址只要「包含」樣式就會中，等於斷言形同虛設');
check('規則：`.` 當字面值不當萬用',
  !wildcardToRegExp('https://a.b/x').test('https://aXb/x'));
check('規則：空清單不會過',
  !evaluateApiAssertion([], { urlPattern: P }).ok);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
