/**
 * H5/PC 錄製器的瀏覽器測試：真的開一顆 Chrome、真的用原始 CDP 注入錄製器、
 * 真的在頁面上點下去，然後看收到什麼積木。
 *
 * ## 為什麼一定要真的跑
 * 這支東西是**注入頁面的字串**。字串裡的轉義、事件順序、`closest()` 在 shadow root
 * 的行為、canvas 的 hit target——猜錯的話單元測試照樣全綠，而錄製時只會安靜地
 * 錄出垃圾選擇器。
 *
 * ## 刻意用原始 CDP，不用 Playwright
 * 產品就是這樣連的（`agent-runner.ts` 的 connectUatRecorder、
 * `frontend-auto.ts` 的 connectRecorder 都自己開 WebSocket）。用 Playwright 測
 * 等於測了一條產品不會走的路——而這次的整個設計前提正是「錄製端沒有 page 物件」。
 *
 * 跑法：node server/uat-runner/frontend-recorder.browser-test.mjs
 */
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { frontendRecorderScript, FRONTEND_RECORDER_MARKER } from './frontend-recorder.js';
import { nativeSelectorCheckSource } from './selector-ladder.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── 受測頁面：Vue 3 的樣子（scoped 雜湊屬性、編譯出來的 class）＋ canvas ＋ shadow DOM ──
const PAGE = `<!doctype html><meta charset="utf-8"><title>h5 recorder fixture</title>
<style>body{margin:0}#game{display:block}#host{display:inline-block}</style>
<div id="app" data-v-7f3a91c>
  <button data-v-7f3a91c class="btn btn--primary is-1a2b">開始遊戲</button>
  <button data-v-7f3a91c class="btn btn--ghost is-9z8y" aria-label="設定">gear</button>
  <input data-v-7f3a91c class="field is-3c4d" name="nickname">
  <div class="row is-x1"><span class="cell">同名</span></div>
  <div class="row is-x2"><span class="cell">同名</span></div>
  <div id="host"></div>
  <div id="host-closed"></div>
  <canvas id="game" width="200" height="150"></canvas>
</div>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  // 兩顆按鈕，第一顆刻意很寬：host 的**中心**落在它身上。
  // 「重播點 host」實際會點到誰，這裡就看得出來。
  root.innerHTML = '<button id="inner" style="width:300px">影子按鈕一</button>'
    + '<button id="inner2" style="width:40px">二</button>';
  root.addEventListener('click', e => { window.__lastShadowClick = (e.target && e.target.id) || '' }, true);
  window.__shadowBtn = root.getElementById('inner');
  window.__shadowBtn2 = root.getElementById('inner2');
  // closed：從 document 這一側取 composedPath() 看不到裡面，第一項仍是 host。
  // 只靠 composedPath 判斷的話，這個情況會走回「host 唯一命中 → ok」的老路。
  const closedRoot = document.getElementById('host-closed').attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<button id="c1" style="width:300px">閉合一</button>'
    + '<button id="c2" style="width:40px">二</button>';
  window.__closedBtn2 = closedRoot.getElementById('c2');
</script>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
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

try {
  const targets = await waitJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('找不到 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const send = (method, params) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** 收到的積木，跟 host 端一樣用 startsWith(marker) 攔 */
  const steps = [];
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
  await send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
  await new Promise(r => setTimeout(r, 1200));

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  check('錄製器真的注入了', await evaluate('!!window.__toppathRecorderInstalled'));

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
  const box = await evaluate(`JSON.stringify(document.getElementById('game').getBoundingClientRect())`);
  const rect = JSON.parse(box);
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

  // ── ⑥ shadow DOM：事件跨出邊界時 target 被重新指向 host ──────────────────
  // document 上的監聽器**看不到裡面那顆按鈕**，只看得到 host。
  // ⚠️ host 本身通常真的唯一命中，所以「只看 target」會把這一步標成 **ok（已驗證）**——
  //    而 host 裡有兩顆按鈕時，重播點 host 的中心不保證落在原本那一顆。
  //    下面 ⑧ 用真的重播證明它會點到**另一顆**。
  await evaluate('window.__shadowBtn2.click()');
  await new Promise(r => setTimeout(r, 250));
  const shadow = steps.at(-1);
  check('⑥ shadow 裡的點擊仍然描述 host（事件重新指向，拿不到裡面那顆）',
    shadow?.selector === '#host', JSON.stringify(shadow));
  check('⑥ ⚠️ 但**不能**標成已驗證——來源在 shadow 裡就標 unknown',
    shadow?.selectorCheck === 'unknown' && shadow?.selectorCheckReason === 'shadow',
    '標成 ok 等於把「不確定」包裝成「已驗證」，而重播點錯不會報錯');

  // ── ⑥b closed shadow：composedPath() 也看不到，要靠 attachShadow 追蹤 ────────
  await evaluate('window.__closedBtn2.click()');
  await new Promise(r => setTimeout(r, 250));
  const closed = steps.at(-1);
  check('⑥b closed shadow 的點擊描述到 host', closed?.selector === '#host-closed', JSON.stringify(closed));
  check('⑥b ⚠️ closed 也不能標成已驗證（composedPath 看不到裡面）',
    closed?.selectorCheck === 'unknown' && closed?.selectorCheckReason === 'shadow',
    'closed 樹的內部節點不會出現在 document 端的 composedPath()，只靠它判斷會走回老路');

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
  // ⚠️ Playwright 的 CSS 會穿透 open shadow DOM、原生 querySelectorAll 不會。
  //    拿原生查不到當成「選擇器壞了」就是用錯的尺去量。
  check('⑦ shadow 裡的元素 → unknown/shadow（兩端範圍本來就不等價）',
    (await probe('#inner', 'window.__shadowBtn')).reason === 'shadow');
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
      await pwPage.goto(`http://127.0.0.1:${sitePort}/`);
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
    const ws2 = new WebSocket(fresh.webSocketDebuggerUrl);
    let id2 = 0;
    const pending2 = new Map();
    const send2 = (method, params) => new Promise(resolve => {
      const id = ++id2;
      pending2.set(id, resolve);
      ws2.send(JSON.stringify({ id, method, params }));
    });
    const steps2 = [];
    await new Promise((resolve, reject) => {
      ws2.on('error', reject);
      ws2.on('message', raw => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.id && pending2.has(msg.id)) { pending2.get(msg.id)({ result: msg.result }); pending2.delete(msg.id); return; }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.args?.[0]?.value === FRONTEND_RECORDER_MARKER) {
            try { steps2.push(JSON.parse(msg.params.args[1]?.value)); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      });
      ws2.on('open', resolve);
    });
    await send2('Runtime.enable');
    await send2('Page.enable');
    // 先把 attachShadow 鎖成唯讀，錄製器就包不住它了（init script 依註冊順序執行）
    await send2('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(Element.prototype, 'attachShadow', "
        + "{ value: Element.prototype.attachShadow, writable: false, configurable: false });",
    });
    await send2('Page.addScriptToEvaluateOnNewDocument', { source: frontendRecorderScript() });
    await send2('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
    await new Promise(r => setTimeout(r, 1200));
    const locked = await send2('Runtime.evaluate', {
      expression: "(() => { const d = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow'); return !d.writable })()",
      returnByValue: true,
    });
    check('⑨ fixture 真的讓錄製器包不住 attachShadow', locked.result?.result?.value === true,
      '前提不成立的話下面那條等於沒測');
    await send2('Runtime.evaluate', { expression: `document.querySelector('[aria-label="設定"]').click()` });
    await new Promise(r => setTimeout(r, 300));
    const blind = steps2.at(-1);
    check('⑨ ⚠️ 追蹤不到 shadow 時一律 unknown（連普通元素也不宣稱驗過）',
      blind?.selectorCheck === 'unknown' && blind?.selectorCheckReason === 'shadow',
      JSON.stringify(blind));
    ws2.close();
    if (newTargetId) await send('Target.closeTarget', { targetId: newTargetId });
  }

  ws.close();
} finally {
  chrome.kill();
  server.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
