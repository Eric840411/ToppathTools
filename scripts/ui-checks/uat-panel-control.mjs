/**
 * scripts/ui-checks/uat-panel-control.mjs
 *
 * 驗 H5/PC 錄製視窗裡那個控制面板的**接線**（v4.183.0）。
 * 面板本身的行為由 `server/uat-runner/frontend-recorder.browser-test.mjs` 用真瀏覽器驗，
 * 這支驗的是瀏覽器測試碰不到的另一半：**產品的兩個 host 有沒有真的接上去**。
 *
 * 為什麼要分兩支：瀏覽器測試自己扮演 host（它有自己的 connect()），
 * 所以它證明得了「面板在正確的 host 行為下是對的」，**證明不了產品的 host 真的那樣做**。
 * 少了這一支，`agent-runner.ts` 或 `frontend-auto.ts` 忘了在重注入後同步狀態，
 * 瀏覽器測試照樣全綠，而實際症狀是「導頁之後面板卡在同步中、而且一步都不錄」。
 *
 * ## 分成三段，可信度不同，不要混為一談
 *   ①②③ **真的執行**：把產出的運算式丟進去跑，看它到底做了什麼
 *   ④    **真的執行**：把 router 掛進 express，真的打那個端點，看 agent 收到什麼
 *   ⑤    **只是接線檢查**：讀原始碼比對呼叫有沒有在該在的地方
 *        ——它證明不了行為，只證明那一行還在。⚠️ 回報時不可以講成「已驗證行為」。
 *
 * 跑法：node scripts/ui-checks/uat-panel-control.mjs
 * ⚠️ 需要先 `npm run build`（④ 吃的是 dist-server 的編譯結果）。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** 1x1 PNG（base64）。給截圖 stub 用——只要是合法的 PNG 就好 */
const PNG_1PX_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const { syncRecorderPanel, setRecorderPanelVisible, frontendRecorderScript, FRONTEND_RECORDER_CONTROL_MARKER } =
  await import(pathToFileURL(path.join(root, 'server/uat-runner/frontend-recorder.js')).href);

/** 收下 host 送出去的 CDP 訊息，並把 Runtime.evaluate 的運算式真的跑一次 */
function fakeCdp() {
  const sent = [];
  const sandbox = { window: {}, result: undefined };
  vm.createContext(sandbox);
  const send = async (method, params) => {
    sent.push({ method, params });
    if (method === 'Runtime.evaluate') {
      // ⚠️ 這裡刻意**真的執行**，不比對字串。比對字串只證明「我寫了那個運算式」，
      //    證明不了它在瀏覽器裡跑得起來——括號拼錯、引號轉義錯，字串斷言照樣綠。
      //    （CodeX 2026-09-18 對 v4.169.0 提過同一件事。）
      sandbox.result = vm.runInContext(params.expression, sandbox);
    }
    return { result: {} };
  };
  return { send, sent, sandbox };
}

console.log('① syncRecorderPanel 產出的運算式真的跑得起來，而且帶對值');
{
  const cdp = fakeCdp();
  const seen = [];
  cdp.sandbox.window.__toppathRecSync = (raw) => { seen.push(raw); return true; };
  await syncRecorderPanel(cdp.send, { paused: true, steps: 7 });
  check('① 真的呼叫到頁面端的 __toppathRecSync', seen.length === 1, JSON.stringify(seen));
  let parsed = null;
  try { parsed = JSON.parse(seen[0]); } catch { /* 下面那條會紅 */ }
  check('① 送過去的是可解析的 JSON（轉義沒壞）', !!parsed, String(seen[0]));
  check('① paused 帶對', parsed?.paused === true, JSON.stringify(parsed));
  check('① 步數帶對（host 的清單長度）', parsed?.steps === 7, JSON.stringify(parsed));
}

console.log('② 頁面端還沒裝好時不能炸（`&&` 短路）');
{
  const cdp = fakeCdp();       // sandbox.window 上沒有 __toppathRecSync
  let threw = false;
  try { await syncRecorderPanel(cdp.send, { paused: false, steps: 1 }); } catch { threw = true; }
  check('② 面板還沒掛上去時同步不會拋例外', !threw);
  check('② 而且回的是 falsy，不是假裝成功', !cdp.sandbox.result);
}

console.log('③ setRecorderPanelVisible 真的傳對布林值');
{
  const cdp = fakeCdp();
  const seen = [];
  cdp.sandbox.window.__toppathRecPanelVisible = (v) => { seen.push(v); return true; };
  await setRecorderPanelVisible(cdp.send, false);
  await setRecorderPanelVisible(cdp.send, true);
  check('③ 藏／顯各傳一次，而且是布林不是字串',
    seen.length === 2 && seen[0] === false && seen[1] === true, JSON.stringify(seen));
}

console.log('④ 主畫面的暫停端點：真的打，看 agent 收到什麼');
{
  const express = (await import('express')).default;
  const hub = await import(pathToFileURL(path.join(root, 'dist-server/server/agent-hub.js')).href);
  const fa = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/frontend-auto.js')).href);

  const outbox = [];
  const agentId = 'panel-check-agent';
  hub.agentConnections.set(agentId, {
    agentId, ws: { readyState: 1, OPEN: 1, send: (raw) => outbox.push(JSON.parse(raw)) },
    capabilities: ['uat-record'], busy: false, hostname: 'PANEL-PC',
  });
  hub.uatAgentSessions.set('rec-panel', { agentId, steps: [{ action: 'goto' }], cropPending: false, done: false, paused: false });

  const app = express();
  app.use(express.json());
  app.use(fa.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const r1 = await fetch(`${base}/api/frontend-auto/record/pause/rec-panel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
  });
  check('④ 端點存在而且回 200', r1.ok, `HTTP ${r1.status}`);
  check('④ 真的把指令送到 agent',
    outbox.some(m => m.type === 'uat_record_pause' && m.sessionId === 'rec-panel' && m.paused === true),
    JSON.stringify(outbox));

  // ⚠️ 這條是重點：**不可以樂觀更新**。權威狀態在 agent（擋事件的是它），
  //    這邊先改的話主畫面會顯示已暫停、而錄製其實還在繼續。
  const statusBefore = await (await fetch(`${base}/api/frontend-auto/record/status/rec-panel`)).json();
  check('④ ⚠️ agent 還沒回報之前，狀態不得先變成已暫停',
    statusBefore.paused === false,
    `狀態是 ${JSON.stringify(statusBefore.paused)}——樂觀更新會讓畫面說暫停了但其實還在錄`);

  // agent 回報之後才算數（worker 收到 kind:'paused' 時做的就是這件事）
  hub.uatAgentSessions.get('rec-panel').paused = true;
  const statusAfter = await (await fetch(`${base}/api/frontend-auto/record/status/rec-panel`)).json();
  check('④ agent 回報之後 /record/status 帶得回暫停狀態', statusAfter.paused === true, JSON.stringify(statusAfter.paused));

  // ⚠️ 暫停 = 不新增積木，**截圖積木也算**（CodeX 2026-09-18 覆核指出）。
  //    而且要明確回 409——靜默 ok 的話畫面會進入框選模式，框完卻什麼都沒發生。
  const rCrop = await fetch(`${base}/api/frontend-auto/record/crop/rec-panel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'h5', scriptId: 's1', name: 'x', threshold: 0.08, createdBy: 'me' }),
  });
  check('④ ⚠️ 暫停中框選截圖要被擋（409），不是靜默 ok', rCrop.status === 409, `HTTP ${rCrop.status}`);
  const cropBody = await rCrop.json();
  check('④ 而且要講得出原因（不是空的錯誤）', typeof cropBody.message === 'string' && cropBody.message.includes('暫停'),
    JSON.stringify(cropBody));
  check('④ 被擋下來時不會送 crop 指令給 agent',
    !outbox.some(m => m.type === 'uat_record_crop'), JSON.stringify(outbox));

  const r2 = await fetch(`${base}/api/frontend-auto/record/pause/rec-unknown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
  });
  check('④ 不存在的 session 要明確 404，不是靜默 ok', r2.status === 404, `HTTP ${r2.status}`);

  server.close();
  hub.agentConnections.delete(agentId);
  hub.uatAgentSessions.delete('rec-panel');
}

console.log('④b 競態：等截圖那段 await 之間才按暫停');
{
  // ⚠️ **真的跑 saveCropFromRecorder**，不是讀原始碼。要測的正是「入口擋過、
  //    但 await 期間狀態變了」——這種只有把時序造出來才看得到。
  const fa = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/frontend-auto.js')).href);
  const inserted = [];
  const sess = {
    paused: false,
    steps: [{ action: 'goto' }],
    cropRequest: { scriptId: 's1', platform: 'h5', name: '截圖', threshold: 0.08, createdBy: 'me' },
    cdpSend: async (method) => {
      if (method === 'Page.captureScreenshot') {
        // 截圖進行中，使用者按下暫停——這正是 CodeX 指出的窗口
        sess.paused = true;
        return { result: { data: PNG_1PX_B64 } };
      }
      return { result: {} };
    },
  };
  const before = sess.steps.length;
  await fa.saveCropFromRecorder(sess, { x: 0, y: 0, w: 10, h: 10 });
  check('④b ⚠️ 等截圖期間才暫停 → 不得新增截圖積木',
    sess.steps.length === before,
    `多了 ${sess.steps.length - before} 顆——判斷貼在入口而不是貼在副作用前面`);
  check('④b 而且要把 cropRequest 收掉（不然下一次框選會沿用這一份）',
    sess.cropRequest === undefined);
  void inserted;
}

console.log('⑤ 兩個 host 的接線（⚠️ 只是原始碼比對，證明不了行為）');
{
  const hosts = [
    ['agent 模式', 'server/agent-runner.ts', 'syncUatPanel'],
    ['伺服器模式', 'server/routes/frontend-auto.ts', 'syncLocalPanel'],
  ];
  for (const [label, file, fn] of hosts) {
    // ⚠️ 剝註解不能用純正則——字串裡的 /* 會被當成區塊註解開頭吃掉整段程式碼，
    //    而那會讓「不得出現某模式」那類斷言假通過。
    const src = stripComments(read(file));

    // 換頁重注入之後一定要再推一次狀態，否則導頁後面板卡在「同步中」而且一步都不收。
    // ⚠️ **一定要限定在 loadEventFired 那一段裡找。** 整份檔案搜的話，初始注入那一處
    //    （它也是 recorderScript(sess) 後面接同步）會頂上來，於是把換頁那一處整個拿掉
    //    也照樣綠——注入測試抓到過。
    const loadAt = src.indexOf('Page.loadEventFired');
    const loadBlock = loadAt < 0 ? '' : src.slice(loadAt, loadAt + 900);
    check(`⑤ ${label}：換頁重注入錄製器之後有再同步一次`,
      loadBlock.includes('recorderScript(sess)') && loadBlock.includes(`${fn}(sess)`),
      '少了這一行，導頁之後面板會停在「同步中」而且完全不收錄');

    // 初始注入那一處也要有——否則要等到 DOMContentLoaded 才會離開「同步中」
    const openAt = src.indexOf('addScriptToEvaluateOnNewDocument');
    const openBlock = openAt < 0 ? '' : src.slice(openAt, openAt + 700);
    check(`⑤ ${label}：初始注入之後也有同步一次`, openBlock.includes(`${fn}(sess)`));

    // 收事件的入口也要擋暫停——頁面在收到狀態之前不知道自己是暫停的
    check(`⑤ ${label}：收步驟的入口有擋 paused`,
      /__TOPPATH_RECORDER__[^\n]*!sess\.paused/.test(src),
      '只靠頁面自己不送的話，重注入後那段空窗期的操作會被錄進去');

    // 控制指令要有人接，否則面板上的按鈕按了完全沒反應
    check(`⑤ ${label}：有接控制指令的 marker`,
      src.includes('FRONTEND_RECORDER_CONTROL_MARKER'), '面板的按鈕會變成按了沒反應');

    // 控制 marker 一定要排除在 console 收集之外，否則會洗版錄製日誌
    check(`⑤ ${label}：控制 marker 有排除在 console 收集之外`,
      /consoleMarkers:[^\n]*FRONTEND_RECORDER_CONTROL_MARKER/.test(src),
      '不排除的話每按一次暫停都會多一行「使用者的 console」');
  }

  // ⚠️ 主題漏傳 sess 的話，注入的是預設主題，而且 __toppathRecorderInstalled 那道
  //    防重複會讓後面帶 sess 的重注入變成 no-op——修仙版的面板永遠不會出現，
  //    而且不會有任何錯誤。（CodeX 2026-09-18 覆核指出，agent 端當時就是這樣。）
  for (const [label, file] of [['agent 模式', 'server/agent-runner.ts'], ['伺服器模式', 'server/routes/frontend-auto.ts']]) {
    const src = stripComments(read(file));
    const bare = src.match(/recorderScript\(\)/g) ?? [];
    check(`⑤ ${label}：沒有任何一處 recorderScript() 漏傳 sess`,
      bare.length === 0, `還有 ${bare.length} 處——那些會注入預設主題，而且會把後面的重注入擋掉`);
  }

  // crop 的完成回呼也要看 paused：框選是一段持續的操作，使用者可能框到一半才暫停
  for (const [label, file, fn] of [
    ['agent 模式', 'server/agent-runner.ts', 'handleAgentCrop'],
    ['伺服器模式', 'server/routes/frontend-auto.ts', 'saveCropFromRecorder'],
  ]) {
    const src = stripComments(read(file));
    const start = src.indexOf(`function ${fn}`);
    const body = src.slice(start, start + 1800);
    check(`⑤ ${label}：截圖入口有擋 paused`, /if \(sess\.paused\)/.test(body));
    // ⚠️ **重點在「截圖那段 await 之後」那一道。**只看整個函式裡有沒有
    //    `if (sess.paused)` 的話，入口那一道會頂上來——把競態那一道拿掉也照樣綠。
    //    （注入測試抳到的：第一版就是這樣。）
    const shotAt = body.indexOf('captureScreenshot');
    const afterShot = shotAt < 0 ? '' : body.slice(shotAt);
    check(`⑤ ${label}：**截圖完成之後、寫入之前**再擋一次 paused`,
      /if \(sess\.paused\)/.test(afterShot),
      '只擋入口的話，等截圖那幾百毫秒之間按暫停，積木照樣會長出來');
  }

  const studio = stripComments(read('src/features/uat/FrontendAutomationStudio.tsx'));
  check('⑤ 主畫面：agent 模式的暫停有「等待確認」狀態（禁用＋顯示同步中）',
    /pausePending/.test(studio) && /disabled=\{pausePending\}/.test(studio),
    '沒有的話按鈕看起來像沒反應');
  check('⑤ 主畫面：等待確認有逾時，不會永遠卡在同步中',
    /pauseTimer\.current = setTimeout/.test(studio));
  // ⚠️ 逾時要**在送出之前**就起跑。起在回應之後的話，fetch 被拒絕／回的不是 JSON／
  //    請求根本沒回來時，pausePending 已經是 true 而計時器從來沒開始——按鈕永久卡住。
  //    （CodeX 2026-09-18 複驗指出，記憶體實測三種情境都卡。）
  const toggle = studio.slice(studio.indexOf('const togglePause'), studio.indexOf('const stopRecording'));
  const timerAt = toggle.indexOf('pauseTimer.current = setTimeout');
  const fetchAt = toggle.indexOf('await fetch');
  check('⑤ 主畫面：逾時計時器在送出請求**之前**就起跑',
    timerAt >= 0 && fetchAt >= 0 && timerAt < fetchAt,
    '起在回應之後的話，連線失敗時按鈕會永久卡在「同步中…」');
  check('⑤ 主畫面：送出失敗有 catch 收尾（不是只靠逾時）',
    /catch\s*\{[^}]*clearPauseWait\(\)/.test(toggle),
    '沒有的話連線中斷要等滿 8 秒才會有反應，而且沒有錯誤訊息');
  check('⑤ 主畫面：回應不是 JSON 也要有結論',
    /response\.json\(\)\.catch\(/.test(toggle),
    '502 那種 HTML 錯誤頁會讓 .json() 直接拋');
  check('⑤ 主畫面：只有收到「我們要求的那個狀態」才算確認',
    /status\.paused === pauseWait\.current/.test(studio),
    '收到相反的狀態就清掉等待，等於把「agent 還沒處理」誤報成已完成');

  check('⑤ worker：加完截圖積木要通知 agent，面板的步數才跟得上',
    /'uat_record_extra_step'/.test(stripComments(read('server/worker.ts'))),
    '截圖積木是 server 那側加的，agent 自己的清單看不到');
  check('⑤ agent：步數有把 server 那側加的積木算進去',
    /steps: sess\.steps\.length \+ \(sess\.extraSteps/.test(stripComments(read('server/agent-runner.ts'))));

  const worker = stripComments(read('server/worker.ts'));
  check('⑤ worker 有處理 agent 回報的 paused 事件',
    /kind === 'paused'[^]{0,200}sess\.paused/.test(worker),
    '沒接的話主畫面永遠看不到暫停狀態（面板顯示暫停、主畫面顯示錄製中）');
}

console.log('⑥ 修仙版的用詞不會漏到普通版，反之亦然');
{
  const normal = frontendRecorderScript();
  const xianxia = frontendRecorderScript({ theme: 'xianxia' });
  const xianxiaOnly = ['收陣', '暫歇', '觀照中', 'c8a24a', '4fd6c9'];
  const normalOnly = ['停止錄製', '暫停錄製', '繼續錄製', '3fbe8b', '42566f'];
  check('⑥ 普通版裡找不到修仙版的字串／配色',
    !xianxiaOnly.some(t => normal.includes(t)), xianxiaOnly.filter(t => normal.includes(t)).join('、'));
  check('⑥ 修仙版裡找不到普通版的字串／配色',
    !normalOnly.some(t => xianxia.includes(t)), normalOnly.filter(t => xianxia.includes(t)).join('、'));
  check('⑥ 控制 marker 跟步驟 marker 不同（收指令跟收步驟不能混在一起）',
    FRONTEND_RECORDER_CONTROL_MARKER !== '__TOPPATH_RECORDER__');
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
