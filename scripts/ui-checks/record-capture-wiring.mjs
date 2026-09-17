/**
 * 錄製時的 console／network／pinus 攔截——接線有沒有接齊。
 *
 * 這個功能的所有壞法都是**安靜的**：面板空白、數字對不起來、或是錄製結束後
 * 計時器永遠跑下去。沒有一種會報錯，所以每一條都要有斷言釘住。
 *
 * 六條：
 *   ① 規則只有一份
 *      分類／門檻／統計來自 net-capture.js 的 createNetCollector()，
 *      pinus route 統計來自 pinus-probe.js 的 pinusSummaryOf()。
 *      cdp-capture.js 自己重寫一份的話，症狀是「同一個請求，執行時算慢、
 *      錄製時算不慢」——兩邊都不會報錯。
 *
 *   ② 兩個 host 都要接
 *      H5/PC 錄製有 agent 模式（agent-runner.ts）與本機模式（frontend-auto.ts），
 *      兩支各自跑自己的 CDP 迴圈。只接一邊的話另一種模式的面板永遠空白。
 *
 *   ③ 計時器一定要收
 *      錄製結束後沒 clearInterval 的話，它會對著已經關掉的 CDP 連線每 3 秒送一次，
 *      而且 session 被移除後沒人再持有它——agent 不重啟就**永遠跑下去**。
 *
 *   ④ 上限一定要有
 *      遊戲畫面一次上百個請求、console 也會被洗版，而這整包每 2 秒被
 *      /record/status 回傳給前端。沒上限就是同時吃掉記憶體與頻寬。
 *
 *   ⑤ 停止要把最後一份量測帶回去
 *      stop 之後 session 就被移除，再打 /record/status 只會拿到 found:false。
 *      不回的話畫面會在按下停止的瞬間清空，而且不像出錯。
 *
 *   ⑥ 新檔案要進 agent 白名單與需重啟清單
 *      agent-runner.ts 靜態 import cdp-capture.js——漏了的話 agent 會在
 *      import 當下整支炸掉，錯誤只出現在 agent 的 stderr。
 *
 * 跑法：node scripts/ui-checks/record-capture-wiring.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// 註解裡寫著「我有做喔」不算做了。行註解要用 [^\r\n]，不能用 .*$（沒有 m 旗標時行為不同）
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');

const capture = strip(read('server/uat-runner/cdp-capture.js'));
const agentRunner = strip(read('server/agent-runner.ts'));
const frontendAuto = strip(read('server/routes/frontend-auto.ts'));
const worker = strip(read('server/worker.ts'));
const machineTest = strip(read('server/routes/machine-test.ts'));
const hashSrc = strip(read('server/agent-source-hash.ts'));
const studio = strip(read('src/features/uat/FrontendAutomationStudio.tsx'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

// ── ① 規則只有一份 ────────────────────────────────────────────────────────
check('① cdp-capture 用 createNetCollector，不自己算',
  /createNetCollector\s*\(/.test(capture), '需要 import 並呼叫 createNetCollector');
check('① cdp-capture 用 pinusSummaryOf，不自己算 route 統計',
  /pinusSummaryOf\s*\(/.test(capture), '需要呼叫 pinusSummaryOf');
// 自己重寫門檻判定的痕跡：出現 thresholds[...] 比較就是又算了一次
check('① cdp-capture 沒有自己做門檻判定',
  !/thresholds\s*\[/.test(capture) && !/overThresholdMs\s*=/.test(capture),
  '門檻判定應該只存在 createNetCollector 裡');
check('① 分類吃得下 CDP 的大寫 type',
  /toLowerCase\(\)/.test(strip(read('server/uat-runner/net-capture.js'))),
  'classifyResourceType 一定要先轉小寫，否則 CDP 的 XHR/Image 會全掉進 other');

// ── ② 兩個 host 都要接 ────────────────────────────────────────────────────
for (const [label, src] of [['agent-runner', agentRunner], ['frontend-auto', frontendAuto]]) {
  check(`② ${label} 有掛 attachCdpCapture`, /attachCdpCapture\s*\(/.test(src));
  check(`② ${label} 有把 CDP 訊息餵進 handle()`, /capture\?\.handle\s*\(/.test(src));
  check(`② ${label} 換頁有補打探針（reinject）`, /capture\?\.reinject\s*\(/.test(src));
  check(`② ${label} 有定期 drain`, /drainPinus\s*\(/.test(src));
}

// ── ③ 計時器一定要收 ──────────────────────────────────────────────────────
check('③ agent-runner 的 killUatSession 會 clearInterval',
  /function killUatSession[\s\S]{0,400}?clearInterval\(sess\.captureTimer\)/.test(agentRunner),
  '錄製結束後計時器會永遠跑下去');
check('③ agent-runner 的瀏覽器被關掉那條也會 clearInterval',
  (agentRunner.match(/clearInterval\(sess\.captureTimer\)/g) ?? []).length >= 2,
  '至少要兩處：killUatSession 與 proc close');
check('③ frontend-auto 的 killRecSession 會 clearInterval',
  /function killRecSession[\s\S]{0,300}?clearInterval\(sess\.captureTimer\)/.test(frontendAuto));

// ── ④ 上限 ────────────────────────────────────────────────────────────────
check('④ cdp-capture 有 console 上限', /CONSOLE_MAX\s*=\s*\d+/.test(capture));
check('④ cdp-capture 有 pinus 上限', /PINUS_MAX\s*=\s*\d+/.test(capture));
check('④ cdp-capture 有單行長度上限', /TEXT_MAX\s*=\s*\d+/.test(capture));
check('④ server 端也有上限（agent 送過來的要再裁一次）',
  /UAT_CONSOLE_KEEP/.test(worker) && /slice\(-UAT_CONSOLE_KEEP\)/.test(worker),
  'agent 端有上限不代表 server 端安全——console 是逐次 append 的');

// ── ⑤ 停止要帶回最後一份 ──────────────────────────────────────────────────
const stopBlock = frontendAuto.slice(frontendAuto.indexOf("record/stop/:sessionId"));
const stopBody = stopBlock.slice(0, stopBlock.indexOf('\n})'));
// ⚠️ 要檢查的是「**真的放進回應裡**」，不是「有把物件建出來」。
//    第一版數的是 `stats:` 出現幾次——那只證明 captured 物件被組好了，
//    把 `...captured` 從 res.json 拿掉照樣全綠（注入測試抓到）。
check('⑤ stop 兩個分支都把 captured 放進回應',
  (stopBody.match(/\.\.\.captured/g) ?? []).length >= 2,
  'agent 模式與本機模式都要 res.json({ …, ...captured })，少一邊那個模式停止後畫面會清空');
check('⑤ stop 的本機分支會先 flush 再 kill',
  stopBody.indexOf('flushLocalCapture') >= 0
  && stopBody.indexOf('flushLocalCapture') < stopBody.indexOf('killRecSession'),
  'kill 之後 CDP 就斷了，最後那幾秒會整段消失');

// ── status 兩個分支都要回同一組欄位 ───────────────────────────────────────
const statusBlock = frontendAuto.slice(frontendAuto.indexOf("record/status/:sessionId"));
const statusBody = statusBlock.slice(0, statusBlock.indexOf('\n})'));
for (const field of ['stats', 'consoleLogs', 'pinusPatched']) {
  check(`⑤ status 兩個分支都回 ${field}`,
    (statusBody.match(new RegExp(`${field}:`, 'g')) ?? []).length >= 2,
    'agent 模式與本機模式少一邊，那個模式的面板會永遠空白');
}

// ── ⑥ agent 白名單與需重啟 ────────────────────────────────────────────────
check('⑥ cdp-capture.js 在 AGENT_SOURCE_WHITELIST 裡',
  /'uat-runner\/cdp-capture\.js'\s*:/.test(machineTest),
  '漏了的話 agent 會在 import 當下整支炸掉');
check('⑥ cdp-capture.js 列為需重啟',
  /'uat-runner\/cdp-capture\.js'/.test(hashSrc),
  'agent-runner.ts 靜態 import 它，不重啟會繼續跑舊的攔截規則');

// ── 前端有接 ──────────────────────────────────────────────────────────────
check('前端錄製輪詢有吃 stats', /setNetStats\(status\.stats\)/.test(studio));
check('前端停止時有吃最後一份 stats', /setNetStats\(data\.stats\)/.test(studio));
check('前端有渲染錄製 console', /recConsole\.map/.test(studio));

// ── 輸出 ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
