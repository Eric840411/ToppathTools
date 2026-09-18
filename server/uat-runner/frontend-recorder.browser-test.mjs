/**
 * H5/PC 錄製器的瀏覽器測試：真的開一顆 Chrome、真的用原始 CDP 注入錄製器、
 * 真的在頁面上點下去，然後看收到什麼積木。
 *
 * ## 為什麼一定要真的跑
 * 這支東西是**注入頁面的字串**。字串裡的轉義、事件順序、shadow DOM 的重新指向、
 * canvas 的 hit target——猜錯的話單元測試照樣全綠，而錄製時只會安靜地錄出垃圾選擇器。
 * 這次就靠它抓到三件事：引擎前綴用 `includes` 誤判 `[aria-label=…]`、
 * shadow 來源被標成已驗證、以及**宣告式 shadow root 在頁面裡根本偵測不到**。
 *
 * ## 刻意用原始 CDP 當錄製端，不用 Playwright
 * 產品就是這樣連的（`agent-runner.ts` 的 connectUatRecorder、
 * `frontend-auto.ts` 的 connectRecorder 都自己開 WebSocket）。用 Playwright 測
 * 等於測了一條產品不會走的路——而這次的整個設計前提正是「錄製端沒有 page 物件」。
 * **重播端**才是 Playwright，所以 ⑧ 那段刻意用 Playwright。
 *
 * ## 三個 fixture 各有用途
 *   `/`             沒有任何 shadow DOM —— 驗正常情況「驗得過就標 ok」
 *   `/shadow-js`    載入時就用 attachShadow 建好 —— 給 ⑧ 的重播用
 *   `/shadow-decl`  `<template shadowrootmode="closed">` —— 頁面端偵測不到，靠 host 查
 *   `/shadow-decl-slow`  同上再加一張 3 秒才回的圖 —— 測「可以點了但還沒 load」那個窗口
 *
 * 跑法：node server/uat-runner/frontend-recorder.browser-test.mjs
 */
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { frontendRecorderScript, FRONTEND_RECORDER_MARKER, flagShadowCompleteness } from './frontend-recorder.js';
import { nativeSelectorCheckSource } from './selector-ladder.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// 兩顆按鈕，第一顆刻意很寬：host 的**中心**落在它身上。
// 「重播只能點 host」實際會點到誰，⑧ 就看得出來。
const MAKE_SHADOW = `
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="inner" style="width:300px">影子按鈕一</button>'
    + '<button id="inner2" style="width:40px">二</button>';
  root.addEventListener('click', e => { window.__lastShadowClick = (e.target && e.target.id) || '' }, true);
  window.__shadowBtn2 = root.getElementById('inner2');
  const closedRoot = document.getElementById('host-closed').attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<button id="c2">閉合二</button>';
  window.__closedBtn2 = closedRoot.getElementById('c2');
`;

// Vue 3 的樣子：scoped 雜湊屬性、編譯出來的 class；外加 canvas 與兩個空的 host 容器
const BODY = `<!doctype html><meta charset="utf-8"><title>h5 recorder fixture</title>
<style>body{margin:0}#game{display:block}#host,#host-closed{display:inline-block}</style>
<div id="app" data-v-7f3a91c>
  <button data-v-7f3a91c class="btn btn--primary is-1a2b">開始遊戲</button>
  <button data-v-7f3a91c class="btn btn--ghost is-9z8y" aria-label="設定">gear</button>
  <input data-v-7f3a91c class="field is-3c4d" name="nickname">
  <div class="row is-x1"><span class="cell">同名</span></div>
  <div class="row is-x2"><span class="cell">同名</span></div>
  <div id="host"></div>
  <div id="host-closed"></div>
  <canvas id="game" width="200" height="150"></canvas>
</div>`;

const DECL = `<!doctype html><meta charset="utf-8"><title>declarative shadow fixture</title>
<style>body{margin:0}#host-decl{display:inline-block}</style>
<button id="plain" aria-label="普通按鈕">普通</button>
<div id="host-decl"><template shadowrootmode="closed"><button id="d1" style="width:300px">宣告一</button><button id="d2" style="width:40px">二</button></template></div>`;

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  // 刻意很慢的圖：讓 load 晚很久才發生，才測得到「可以點了但還沒 load」那個窗口
  if (req.url === '/slow.png') {
    return setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_1PX); }, 3000);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url === '/shadow-js') return res.end(BODY + `<script>${MAKE_SHADOW}</script>`);
  if (req.url === '/shadow-decl') return res.end(DECL);
  if (req.url === '/shadow-decl-slow') return res.end(DECL + '<img src="/slow.png">');
  // 分段輸出：前半段先到（此時 readyState 還是 loading、而且還沒有任何 shadow root），
  // 1.5 秒後才送出含宣告式 closed root 的後半段。
  // 用來重現「掃到半份 DOM 就宣告乾淨」那個時序。
  if (req.url === '/shadow-decl-streamed') {
    res.write('<!doctype html><meta charset="utf-8"><title>streamed</title>'
      + '<button id="plain" aria-label="普通按鈕">普通</button>');
    return setTimeout(() => {
      res.end('<div id="host-decl" style="display:inline-block">'
        + '<template shadowrootmode="closed"><button id="d1">宣告一</button></template></div>');
    }, 1500);
  }
  res.end(BODY);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const sitePort = server.address().port;

// ⚠️ 不要用亂數挑 CDP port——連續跑會撞到上一顆還沒收乾淨的 Chrome，
//    測試莫名紅一次又莫名好，那種紅會訓練人忽略紅燈。
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const cdpPort = await freePort();
const profileDir = `${process.env.TEMP || '/tmp'}/h5-recorder-test-${Date.now()}`;
const chrome = spawn(chromium.executablePath(), [
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--window-size=800,600',
  'about:blank',
], { stdio: 'ignore' });

const waitJson = async (url, timeoutMs = 20000) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`CDP 沒起來：${last?.message ?? 'timeout'}`);
};

/** 開一條 CDP 連線，收步驟的方式跟產品端的 host 一樣（比對 marker 前綴） */
const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  const steps = [];
  const send = (method, params) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)({ result: msg.result }); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.args?.[0]?.value === FRONTEND_RECORDER_MARKER) {
          try { steps.push(JSON.parse(msg.params.args[1]?.value)); } catch { steps.push({ action: '<parse failed>' }); }
        }
      } catch { /* ignore */ }
    });
    ws.on('open', resolve);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { ws, send, steps, evaluate };
};

try {
  const targets = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 page target');
  const { ws, send, steps, evaluate } = await connect(target.webSocketDebuggerUrl);

  await send('Runtime.enable');
  await send('Page.enable');
  // ⚠️ 產品端也是這個順序：先註冊 init script，再導頁。
  //    反過來（Chrome 直接開目標網址）的話「注入早於頁面程式碼」不成立，
  //    注入前建立的 shadow root 永遠追蹤不到。
  await send('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
  await send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
  await new Promise(r => setTimeout(r, 1200));

  check('錄製器真的注入了', await evaluate('!!window.__toppathRecorderInstalled'));

  // ── ⓿ 沒有 shadow DOM 的頁面不能被誤判成「無法確認」───────────────────────
  // ⚠️ 這條是整個功能的前提：host 端的保守檢查如果連普通頁面都設旗標，
  //    所有步驟都會變 unknown，驗證等於關掉。
  await flagShadowCompleteness(send);
  check('⓿ 普通頁面（沒有 shadow root）查完之後可以宣稱驗過',
    await evaluate('window.__toppathShadowChecked') === true,
    '這裡沒設成 true 的話下面每一條 ok 都會變 unknown，功能等於關掉');

  // ── ① 有穩定屬性的元素 ───────────────────────────────────────────────
  await evaluate(`document.querySelector('[aria-label="設定"]').click()`);
  await new Promise(r => setTimeout(r, 250));
  const gear = steps.at(-1);
  check('① 點擊錄成 click（不是座標）', gear?.action === 'click', JSON.stringify(gear));
  check('① 用 aria-label 定位', gear?.selector === '[aria-label="設定"]', gear?.selector);
  check('① 記下用了哪一階', gear?.selectorStrategy === 'dataAttr', gear?.selectorStrategy);
  check('① 錄製當下驗過，而且是 ok', gear?.selectorCheck === 'ok', JSON.stringify(gear));

  // ── ② 沒有穩定屬性 → 退到文字，而**不是**結構路徑 ──────────────────────
  // 這正是這次改動的重點：舊的 H5 錄製器只有 cssPath，
  // 而 Vue 3 的 class（is-1a2b 這種編譯產物）一改版就全變。
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('開始遊戲')).click()`);
  await new Promise(r => setTimeout(r, 250));
  const start = steps.at(-1);
  check('② 沒有穩定屬性時退到可見文字', start?.selector === 'text=開始遊戲', start?.selector);
  check('② **不是**結構路徑（舊錄製器只有這一階）', start?.selectorStrategy !== 'cssPath', start?.selectorStrategy);
  check('② 非原生 CSS → 驗不了就標 unknown，不猜',
    start?.selectorCheck === 'unknown' && start?.selectorCheckReason === 'unsupported', JSON.stringify(start));

  // ── ③ 輸入錄成 type，不是 fill ────────────────────────────────────────
  await evaluate(`(() => { const el = document.querySelector('[name="nickname"]'); el.value = 'osmel002';
    el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise(r => setTimeout(r, 250));
  const typed = steps.at(-1);
  check('③ 輸入錄成 type', typed?.action === 'type', JSON.stringify(typed));
  check('③ 值有帶上', typed?.value === 'osmel002', typed?.value);
  check('③ 用 name 定位並驗過', typed?.selector === '[name="nickname"]' && typed?.selectorCheck === 'ok', JSON.stringify(typed));

  // ── ④ canvas 上的點擊 → 座標，因為 canvas 裡沒有 DOM 可以指 ─────────────
  const rect = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('game').getBoundingClientRect())`));
  const cx = Math.round(rect.left + 40);
  const cy = Math.round(rect.top + 30);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 300));
  const canvasStep = steps.at(-1);
  check('④ canvas 上的點擊錄成 click_viewport', canvasStep?.action === 'click_viewport', JSON.stringify(canvasStep));
  check('④ 座標是 viewport 座標（兩個引擎的 click_viewport 都是 page.mouse.click）',
    Math.abs((canvasStep?.x ?? -999) - cx) <= 1 && Math.abs((canvasStep?.y ?? -999) - cy) <= 1,
    `期望 ${cx},${cy} 收到 ${canvasStep?.x},${canvasStep?.y}`);
  check('④ canvas 的步驟不帶 selector', !canvasStep?.selector, canvasStep?.selector);

  // ── ⑤ 去重只擋「同一下被送兩次」，不能吃掉真的按兩次 ──────────────────
  const before = steps.length;
  await evaluate(`document.querySelector('[aria-label="設定"]').click(); document.querySelector('[aria-label="設定"]').click();`);
  await new Promise(r => setTimeout(r, 250));
  check('⑤ 200ms 內的重複事件只錄一次', steps.length === before + 1, `多了 ${steps.length - before} 筆`);
  await new Promise(r => setTimeout(r, 300));
  await evaluate(`document.querySelector('[aria-label="設定"]').click()`);
  await new Promise(r => setTimeout(r, 250));
  check('⑤ ⚠️ 隔一段時間真的再按一次**要錄到**（舊的伺服器模式會安靜丟掉）',
    steps.length === before + 2, `總共 ${steps.length - before} 筆`);

  // ── ⑥ 載入後才建的 shadow root（SPA 常態）靠頁面端追蹤 ────────────────────
  // host 端只在載入完成查一次，查不到「之後才建的」；這一段正是它涵蓋不到的範圍。
  await evaluate(`(() => { ${MAKE_SHADOW} })()`);
  await evaluate('window.__shadowBtn2.click()');
  await new Promise(r => setTimeout(r, 250));
  const shadowOpen = steps.at(-1);
  check('⑥ open shadow 裡的點擊仍然描述 host（事件重新指向，拿不到裡面那顆）',
    shadowOpen?.selector === '#host', JSON.stringify(shadowOpen));
  check('⑥ ⚠️ 但**不能**標成已驗證',
    shadowOpen?.selectorCheck === 'unknown' && shadowOpen?.selectorCheckReason === 'shadow',
    '標成 ok 等於把「不確定」包裝成「已驗證」，而重播點錯不會報錯');

  await evaluate('window.__closedBtn2.click()');
  await new Promise(r => setTimeout(r, 250));
  const shadowClosed = steps.at(-1);
  check('⑥b closed shadow 也標 unknown（composedPath 看不到裡面，靠包住 attachShadow）',
    shadowClosed?.selector === '#host-closed'
    && shadowClosed?.selectorCheck === 'unknown' && shadowClosed?.selectorCheckReason === 'shadow',
    JSON.stringify(shadowClosed));

  // ── ⑦ 驗證函式本身：把同一份原始碼單獨注入頁面直接叫 ────────────────────
  await evaluate(`(() => { ${nativeSelectorCheckSource()} ; window.__checkForTest = nativeSelectorCheck; })()`);
  const probe = async (selector, elExpr) =>
    JSON.parse(await evaluate(`JSON.stringify(window.__checkForTest(${JSON.stringify(selector)}, ${elExpr}))`));

  check('⑦ 唯一命中且就是那一顆 → ok',
    (await probe('#game', `document.getElementById('game')`)).status === 'ok');
  check('⑦ 命中多筆 → many（重播會被「定位必須唯一」擋下來）',
    (await probe('.row', `document.querySelector('.row')`)).status === 'many');
  check('⑦ 元素還在、卻找不到 → none（錄的當下就是壞的）',
    (await probe('#does-not-exist', `document.getElementById('game')`)).status === 'none');
  // ⚠️ mismatch 比 none 更危險：重播會**安靜地點到別的東西**。
  check('⑦ 唯一命中但不是那一顆 → mismatch',
    (await probe('#game', `document.querySelector('[name="nickname"]')`)).status === 'mismatch');
  check('⑦ 語法錯誤 → invalid',
    (await probe('div:::bad', `document.getElementById('game')`)).status === 'invalid');
  check('⑦ shadow 裡的元素 → unknown/shadow（兩端範圍本來就不等價）',
    (await probe('#inner2', 'window.__shadowBtn2')).reason === 'shadow');
  check('⑦ ⚠️ 屬性裡出現 label= 不算引擎前綴（[aria-label=…] 必須驗得到）',
    (await probe('[aria-label="設定"]', `document.querySelector('[aria-label="設定"]')`)).status === 'ok');
  check('⑦ 元素已從畫面移除 → unknown/gone，不是失敗',
    (await probe('#gone-el', `(() => { const d = document.createElement('div'); d.id = 'gone-el'; return d })()`)).reason === 'gone');
  for (const sel of ['text=開始', 'label=暱稱', 'tr:has(:text-is("x"))', '.a:visible', 'div >> span']) {
    check(`⑦ 非原生 CSS 一律 unknown/unsupported：${sel}`,
      (await probe(sel, `document.getElementById('game')`)).reason === 'unsupported');
  }

  // ── ⑧ 用真的重播證明 ⑥ 為什麼不能標 ok ────────────────────────────────
  // 錄的是「影子按鈕二」，重播只拿得到 #host。用 Playwright（重播端真正的技術）
  // 點下去看落在誰身上——落在第一顆，就是**安靜點錯**。
  {
    const pwBrowser = await chromium.launch();
    try {
      const pwPage = await pwBrowser.newPage();
      await pwPage.goto(`http://127.0.0.1:${sitePort}/shadow-js`);
      await pwPage.click('#host');
      const landed = await pwPage.evaluate(() => window.__lastShadowClick);
      check('⑧ ⚠️ 重播點 #host 落在**另一顆**按鈕上（錄的是 inner2）',
        landed === 'inner',
        `落在 ${JSON.stringify(landed)}——若這裡剛好等於 inner2，代表版面變了，要換 fixture 而不是放寬斷言`);
      check('⑧ 所以那一步標 unknown 是對的，標 ok 會把安靜點錯包裝成已驗證',
        landed !== 'inner2');
    } finally {
      await pwBrowser.close();
    }
  }

  // ── ⑥c 宣告式 closed root：頁面端偵測不到，只有 host 端的 CDP 看得到 ──────
  await send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/shadow-decl` });
  await new Promise(r => setTimeout(r, 900));
  check('⑥c fixture 的宣告式 root 真的存在，而且從頁面裡看不到',
    await evaluate(`document.getElementById('host-decl').shadowRoot === null`) === true
    && await evaluate(`document.getElementById('host-decl').childNodes.length`) === 0
    && await evaluate(`document.getElementById('host-decl').getBoundingClientRect().width`) > 300,
    'template 沒被消化成 shadow root 的話這條測不到東西');
  await flagShadowCompleteness(send);
  check('⑥c host 端查得出這一頁有追蹤不到的 shadow root（維持不可宣稱驗過）',
    await evaluate('window.__toppathShadowChecked') === false,
    '頁面端三條路都試過都偵測不到（見 frontend-recorder.js 的說明），只有 CDP 看得到');
  const declSteps = steps.length;
  await evaluate(`document.getElementById('plain').click()`);
  await new Promise(r => setTimeout(r, 300));
  const declPlain = steps.at(-1);
  check('⑥c ⚠️ 這一頁連普通元素都不宣稱驗過（無法證明追蹤完整就一律 unknown）',
    steps.length === declSteps + 1
    && declPlain?.selectorCheck === 'unknown' && declPlain?.selectorCheckReason === 'shadow',
    JSON.stringify(declPlain));

  // ── ⑥d 查完之前不能宣稱驗過（load 前的那個窗口）────────────────────────
  // ⚠️ 這是 CodeX 第四輪抓到的：host 是等 load 才查的，而「頁面可以點了」跟 load
  //    在規範上是不同階段。原本的寫法是「查到問題才擋」，所以**查完之前一律放行**——
  //    使用者在那個窗口點了宣告式 closed 元件就被標成已驗證，而且事後不會回頭修正。
  //    現在反過來：每份新文件預設「尚未確認」。
  {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const slowId = created.result?.targetId;
    const list = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const fresh = list.find(t => t.id === slowId && t.webSocketDebuggerUrl);
    if (!fresh) throw new Error('開不出慢速分頁');
    const slow = await connect(fresh.webSocketDebuggerUrl);
    await slow.send('Runtime.enable');
    await slow.send('Page.enable');
    await slow.send('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
    await slow.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/shadow-decl-slow` });
    // DOM 已經可以互動，但 3 秒的圖還沒載完 → load 還沒發生
    await new Promise(r => setTimeout(r, 800));
    // ⚠️ 要精確是 interactive：HTML 解析完了（所以宣告式 root 已經在）、
    //    但 3 秒的圖還沒回來所以 load 沒發生。這正是那個窗口。
    //    接受 loading 的話就分不出「窗口」跟「還在解析」——CodeX 指出過。
    const slowState = await slow.evaluate('document.readyState');
    check('⑥d fixture 精確停在 interactive（解析完、load 未發生）',
      slowState === 'interactive',
      `readyState 是 ${slowState}——complete 或 loading 都測不到這個窗口`);
    // ⚠️ 刻意**不先呼叫 flagShadowCompleteness**：要測的就是「還沒查」的狀態。
    //    兩種元素都點：宣告式 host（真正危險的那個）與普通按鈕（證明是整頁不宣稱）。
    const declRect = JSON.parse(await slow.evaluate(
      `JSON.stringify(document.getElementById('host-decl').getBoundingClientRect())`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await slow.send('Input.dispatchMouseEvent', {
        type, button: 'left', clickCount: 1,
        x: Math.round(declRect.left + declRect.width - 10),
        y: Math.round(declRect.top + declRect.height / 2),
      });
    }
    await new Promise(r => setTimeout(r, 300));
    const earlyDecl = slow.steps.at(-1);
    check('⑥d ⚠️ 窗口裡點宣告式 closed 元件 → 不宣稱驗過',
      earlyDecl?.selector === '#host-decl'
      && earlyDecl?.selectorCheck === 'unknown' && earlyDecl?.selectorCheckReason === 'shadow',
      JSON.stringify(earlyDecl));
    await slow.evaluate(`document.getElementById('plain').click()`);
    await new Promise(r => setTimeout(r, 300));
    const early = slow.steps.at(-1);
    check('⑥d ⚠️ 窗口裡連普通元素也不宣稱驗過',
      early?.selector === '[aria-label="普通按鈕"]'
      && early?.selectorCheck === 'unknown' && early?.selectorCheckReason === 'shadow',
      JSON.stringify(early));
    slow.ws.close();
    if (slowId) await send('Target.closeTarget', { targetId: slowId });
  }

  // ── ⑥e 解析中（loading）查到的結果不能當結論 ─────────────────────────────
  // ⚠️ CodeX 第五輪指出的時序：載入事件是上一頁的，但 evaluate 執行時已經導到新頁、
  //    而新頁還在解析。掃一份**半成品 DOM** 當然找不到 shadow root，
  //    於是把它標成「已確認乾淨」——它後面才解析出來的宣告式 closed root
  //    就會被錯標成已驗證。docId 比對擋不到（兩邊讀到的都是新頁）。
  {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const streamId = created.result?.targetId;
    const list = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const fresh = list.find(t => t.id === streamId && t.webSocketDebuggerUrl);
    if (!fresh) throw new Error('開不出分段輸出的分頁');
    const stream = await connect(fresh.webSocketDebuggerUrl);
    await stream.send('Runtime.enable');
    await stream.send('Page.enable');
    await stream.send('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
    await stream.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/shadow-decl-streamed` });
    await new Promise(r => setTimeout(r, 500));   // 前半段到了，後半段還沒
    check('⑥e fixture 真的還在解析中（而且此刻沒有任何 shadow root）',
      await stream.evaluate('document.readyState') === 'loading'
      && await stream.evaluate('!document.getElementById("host-decl")') === true,
      `readyState 是 ${await stream.evaluate('document.readyState')}`);
    await flagShadowCompleteness(stream.send);
    check('⑥e ⚠️ 解析中查詢**不得**把文件標成已確認',
      await stream.evaluate('window.__toppathShadowChecked') === false,
      '掃半份 DOM 找不到 shadow root 是理所當然的，不能當成「這頁乾淨」');
    // 等後半段送完，再查一次——這時才看得到宣告式 root，而結論必須是「不乾淨」
    await new Promise(r => setTimeout(r, 1600));
    check('⑥e 解析完成後才有結論的依據', await stream.evaluate('document.readyState') !== 'loading');
    await flagShadowCompleteness(stream.send);
    check('⑥e 解析完後查得出這一頁有追蹤不到的 shadow root',
      await stream.evaluate('window.__toppathShadowChecked') === false
      && await stream.evaluate('!!document.getElementById("host-decl")') === true);
    stream.ws.close();
    if (streamId) await send('Target.closeTarget', { targetId: streamId });
  }

  // ── ⑥f 用 CDP stub 釘住「解析中不查、不寫」的契約 ────────────────────────
  // ⚠️ 為什麼用 stub 不用真瀏覽器：要驗的是「**解析完成前不去掃、也不寫回**」。
  //    真實時序裡「掃描中途解析剛好完成」那一瞬間造不出來（也不該用睡眠去賭），
  //    但契約本身是確定的：readyState 還是 loading 就連 DOM.getDocument 都不該送。
  //    這一段也順便說明了為什麼兩道關卡都要有——只留寫回那一道的話，
  //    「掃到半份 DOM、寫回前剛好解析完」就會寫出一個基於半成品的「已確認」。
  {
    const calls = [];
    const stub = (rs, roots) => async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('readyState')) {
        return { result: { result: { value: JSON.stringify({ id: 'doc-1', rs }) } } };
      }
      if (method === 'DOM.getDocument') return { result: { root: roots } };
      return { result: { result: { value: true } } };
    };
    const clean = { children: [] };
    const dirty = { children: [{ shadowRoots: [{ shadowRootType: 'closed' }], children: [] }] };

    calls.length = 0;
    await flagShadowCompleteness(stub('loading', dirty));
    check('⑥f 解析中：連 DOM.getDocument 都不送',
      !calls.some(c => c.method === 'DOM.getDocument'),
      '掃半份 DOM 得到的「沒有 shadow root」沒有任何意義');
    check('⑥f 解析中：也不寫回任何結論',
      !calls.some(c => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('__toppathShadowChecked')));

    calls.length = 0;
    await flagShadowCompleteness(stub('interactive', clean));
    const writeClean = calls.find(c => String(c.params?.expression).includes('__toppathShadowChecked'));
    check('⑥f 解析完＋乾淨 → 寫入已確認', String(writeClean?.params?.expression).includes('= true'));
    check('⑥f 寫回時同時比 docId 與 readyState',
      String(writeClean?.params?.expression).includes('__toppathDocId === "doc-1"')
      && String(writeClean?.params?.expression).includes('readyState !== "loading"'),
      '掃描期間又導頁、或文件退回 loading 的話，這份結論不屬於現在這份文件');

    calls.length = 0;
    await flagShadowCompleteness(stub('complete', dirty));
    const writeDirty = calls.find(c => String(c.params?.expression).includes('__toppathShadowChecked'));
    check('⑥f 解析完＋有作者 root → 明確寫入「不可宣稱」',
      String(writeDirty?.params?.expression).includes('= false'),
      '同一份文件後來才多出追蹤不到的 root 時，要能把先前的確認收回');

    // ── ⑥g 上面那幾條是**字串斷言**，這裡把同一段運算式真的跑起來 ────────────
    // ⚠️ CodeX 2026-09-18 的提醒：比對字串只證明「我寫了那個條件」，
    //    證明不了「那個條件在瀏覽器裡真的擋得住」。運算式拼錯一個括號、
    //    或 docId 的引號轉義錯了，字串斷言照樣綠。
    const writeBack = String(writeClean?.params?.expression);
    const runWrite = async (page, docId) => {
      await page.evaluate(`window.__toppathDocId = ${JSON.stringify(docId)}; window.__toppathShadowChecked = false;`);
      await page.evaluate(writeBack);
      return await page.evaluate('window.__toppathShadowChecked');
    };
    check('⑥g 真的跑：docId 相符＋解析完 → 寫入成功',
      await runWrite({ evaluate }, 'doc-1') === true, writeBack);
    check('⑥g 真的跑：⚠️ docId 不符 → 不寫（那份結論屬於上一份文件）',
      await runWrite({ evaluate }, 'another-doc') === false);

    // readyState 那道要在真的還在解析的文件上跑才算數
    const createdLoading = await send('Target.createTarget', { url: 'about:blank' });
    const loadingId = createdLoading.result?.targetId;
    const list2 = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const freshLoading = list2.find(t => t.id === loadingId && t.webSocketDebuggerUrl);
    if (!freshLoading) throw new Error('開不出解析中的分頁');
    const loadingPage = await connect(freshLoading.webSocketDebuggerUrl);
    await loadingPage.send('Runtime.enable');
    await loadingPage.send('Page.enable');
    await loadingPage.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/shadow-decl-streamed` });
    await new Promise(r => setTimeout(r, 500));
    check('⑥g fixture 真的還在解析中', await loadingPage.evaluate('document.readyState') === 'loading');
    check('⑥g 真的跑：⚠️ 文件還在解析 → 不寫（掃到的是半成品）',
      await runWrite(loadingPage, 'doc-1') === false);
    loadingPage.ws.close();
    if (loadingId) await send('Target.closeTarget', { targetId: loadingId });
  }

  // ── ⑨ 追蹤不到 shadow 時要**退回 unknown**，不能當成沒有 shadow ───────────
  // ⚠️ 這條驗的是退路本身。注入的腳本不是嚴格模式，屬性被設成唯讀時指派會
  //    **安靜失敗**——如果只是「指派完就當成功」，我們會以為在追蹤、其實沒有，
  //    然後把每一步都標成已驗證。退路壞掉比沒有退路更危險。
  {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const newTargetId = created.result?.targetId;
    const list = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const fresh = list.find(t => t.id === newTargetId && t.webSocketDebuggerUrl);
    if (!fresh) throw new Error('開不出第二個分頁');
    const second = await connect(fresh.webSocketDebuggerUrl);
    await second.send('Runtime.enable');
    await second.send('Page.enable');
    // 先把 attachShadow 鎖成唯讀，錄製器就包不住它了（init script 依註冊順序執行）
    await second.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(Element.prototype, 'attachShadow', "
        + "{ value: Element.prototype.attachShadow, writable: false, configurable: false });",
    });
    await second.send('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
    await second.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
    await new Promise(r => setTimeout(r, 1200));
    // ⚠️ 一定要先讓 host 確認過（這一頁沒有作者建立的 shadow root），
    //    否則下面那條會因為「還沒確認」而 unknown——**測到的是別的機制**，
    //    把 attachShadow 的追蹤整段拿掉也照樣綠。（注入測試抓到過。）
    await flagShadowCompleteness(second.send);
    check('⑨ host 已經確認過這一頁乾淨（所以下面的 unknown 只能來自追蹤失敗）',
      await second.evaluate('window.__toppathShadowChecked') === true);
    check('⑨ fixture 真的讓錄製器包不住 attachShadow',
      await second.evaluate("(() => { const d = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow'); return !d.writable })()") === true,
      '前提不成立的話下面那條等於沒測');
    await second.evaluate(`document.querySelector('[aria-label="設定"]').click()`);
    await new Promise(r => setTimeout(r, 300));
    const blind = second.steps.at(-1);
    check('⑨ ⚠️ 追蹤不到 shadow 時一律 unknown（連普通元素也不宣稱驗過）',
      blind?.selectorCheck === 'unknown' && blind?.selectorCheckReason === 'shadow',
      JSON.stringify(blind));
    second.ws.close();
    if (newTargetId) await send('Target.closeTarget', { targetId: newTargetId });
  }

  // ── ⑨b 注入晚於解析（就是「Chrome 直接開目標網址」那種順序）─────────────
  // ⚠️ 這條守的是**別人把啟動順序改回去**的情況：那時我們比頁面晚進場，
  //    之前建立的 shadow root 全部沒看到。症狀必須是「全部 unknown」，
  //    **不能**是「照樣宣稱驗過」——後者才是安靜錯標。
  {
    const created = await send('Target.createTarget', { url: `http://127.0.0.1:${sitePort}/` });
    const lateId = created.result?.targetId;
    const list = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const fresh = list.find(t => t.id === lateId && t.webSocketDebuggerUrl);
    if (!fresh) throw new Error('開不出第三個分頁');
    const late = await connect(fresh.webSocketDebuggerUrl);
    await late.send('Runtime.enable');
    await new Promise(r => setTimeout(r, 800));
    check('⑨b fixture 真的是「載入完才注入」', await late.evaluate('document.readyState') === 'complete');
    // 沒有 init script，直接在已經載好的頁面上注入——舊的啟動順序就是這樣
    await late.evaluate(frontendRecorderScript());
    // 同 ⑨：先讓 host 確認過，否則測到的是「還沒確認」而不是 readyState 守門
    await late.send('Page.enable');
    await flagShadowCompleteness(late.send);
    check('⑨b host 已經確認過這一頁乾淨（所以下面的 unknown 只能來自 readyState 守門）',
      await late.evaluate('window.__toppathShadowChecked') === true);
    await late.evaluate(`document.querySelector('[aria-label="設定"]').click()`);
    await new Promise(r => setTimeout(r, 300));
    const lateStep = late.steps.at(-1);
    check('⑨b ⚠️ 注入晚於解析時一律 unknown（追蹤不完整就不宣稱驗過）',
      lateStep?.selectorCheck === 'unknown' && lateStep?.selectorCheckReason === 'shadow',
      JSON.stringify(lateStep));
    late.ws.close();
    if (lateId) await send('Target.closeTarget', { targetId: lateId });
  }

  ws.close();
} finally {
  chrome.kill();
  server.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
