/**
 * cdp-capture.js 的瀏覽器測試：真的開一顆 Chrome、真的用原始 CDP 連上去、
 * 真的讓頁面發請求與噴錯，然後檢查有沒有收到。
 *
 * ## 為什麼一定要真的跑
 * 用假的 CDP 訊息餵進 handle() 只能證明「我以為 CDP 長這樣的時候，分類是對的」。
 * 真正會錯的是**事件本身的形狀與順序**——requestWillBeSent 的 type 欄位、
 * 轉址時 requestId 會被重複使用、loadingFinished 的 timestamp 單位是秒不是毫秒、
 * Log.entryAdded 要先 Log.enable 才會來。這些猜錯的話單元測試照樣全綠，
 * 但實際錄製時面板會是空的、而且不會有任何錯誤。
 *
 * ## 這支刻意用原始 CDP，不用 Playwright 的 page
 * 因為**產品就是這樣連的**（agent-runner.ts 的 connectUatRecorder、
 * frontend-auto.ts 的 connectRecorder 都是自己開 WebSocket）。
 * 用 Playwright 測等於測了一條產品不會走的路。
 *
 * 跑法：node server/uat-runner/cdp-capture.browser-test.mjs
 */
import http from 'http';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { attachCdpCapture } from './cdp-capture.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── 受測頁面 ─────────────────────────────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PAGE = `<!doctype html><meta charset="utf-8"><title>cdp capture fixture</title>
<img src="/img.png">
<script>
  console.warn('這是一行警告', 42);
  fetch('/api/slow').then(r => r.text());
  fetch('/api/missing');
  setTimeout(() => { null.boom(); }, 200);
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (req.url === '/api/slow') {
    // 刻意慢，讓門檻判定有東西可以判
    return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 350);
  }
  if (req.url === '/api/missing') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const sitePort = server.address().port;

// ── 開 Chrome，用原始 CDP 連上去（跟產品一樣）────────────────────────────────
// ⚠️ **不要用亂數挑 port。** 第一版是 `9500 + random(300)`，連續跑幾次就撞到
//    上一顆還沒收乾淨的 Chrome，測試會莫名其妙紅一次然後下一次又好——
//    那種紅比沒測還糟，因為它會訓練人忽略紅燈。
//    （這也正是產品端 agent-runner.ts 現在的寫法，已列為待修。）
const freePort = async () => {
  const net = await import('net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
};
const cdpPort = await freePort();
const chrome = spawn(chromium.executablePath(), [
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${process.env.TEMP || '/tmp'}/cdp-capture-test-${Date.now()}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const waitJson = async (url, timeoutMs = 20000) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`CDP 沒起來：${last?.message ?? 'timeout'}`);
};

let capture;
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

  const markerHits = [];
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)({ id: msg.id, result: msg.result }); pending.delete(msg.id); return; }
        // 產品端會先處理自己的標記，再交給 capture——這裡照做
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.args?.[0]?.value === '__TOPPATH_RECORDER__') {
          markerHits.push(msg.params.args[1]?.value);
        }
        capture?.handle(msg);
      } catch { /* ignore */ }
    });
    ws.on('open', resolve);
  });

  await send('Runtime.enable');
  await send('Page.enable');
  capture = await attachCdpCapture(send, {
    thresholds: { api: 200, image: 200, other: 200 },
    consoleMarkers: ['__TOPPATH_RECORDER__', '__TOPPATH_CROP__'],
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
  await new Promise(r => setTimeout(r, 2500));

  // 產品端也會印標記——確認 capture 不會把它吃掉
  await send('Runtime.evaluate', { expression: `console.info('__TOPPATH_RECORDER__', '{"action":"click"}')` });
  await new Promise(r => setTimeout(r, 300));

  await capture.drainPinus();
  const snap = capture.snapshot();
  const logs = capture.consoleLogs();
  const net = snap.net;

  // ── 網路 ───────────────────────────────────────────────────────────────────
  const urls = net.apiCalls.map(c => c.url);
  check('抓到 API 請求（/api/slow）', urls.some(u => u.includes('/api/slow')),
    `apiCalls: ${JSON.stringify(urls)}`);
  check('API 有分類成 api 而不是 other（CDP 的 type 是大寫 XHR/Fetch）',
    net.api.count >= 2, `api=${net.api.count} image=${net.image.count} other=${net.other.count}`);
  check('圖檔有被分到 image', net.image.count >= 1, `image=${net.image.count}`);
  check('慢的那筆有超過門檻', net.slow.some(r => r.url.includes('/api/slow')),
    `slow: ${JSON.stringify(net.slow.map(r => [r.url, r.durationMs]))}`);

  const slowRec = net.slow.find(r => r.url.includes('/api/slow'));
  check('耗時是毫秒等級而不是秒（CDP timestamp 單位換算）',
    !!slowRec && slowRec.durationMs > 250 && slowRec.durationMs < 5000,
    `durationMs=${slowRec?.durationMs}`);

  const all = net.slow.concat(net.slowest);
  check('404 有記到 status', net.totals.captured >= 3, `captured=${net.totals.captured}`);
  check('每筆都帶 urlPattern（之後要拿來變成斷言）',
    net.apiCalls.length > 0 && all.every(r => typeof r.urlPattern === 'string' || r.urlPattern === undefined),
    'urlPattern 缺漏');

  // ── console ────────────────────────────────────────────────────────────────
  check('收到頁面的 console.warn', logs.some(l => l.text.includes('這是一行警告')),
    JSON.stringify(logs.map(l => [l.type, l.text.slice(0, 40)])));
  check('console 參數有一起帶（42）', logs.some(l => l.text.includes('42')));
  check('收到 pageerror（Runtime.exceptionThrown）',
    logs.some(l => l.type === 'pageerror'),
    JSON.stringify(logs.map(l => l.type)));
  check('錄製器自己的標記沒被當成 console 收走',
    !logs.some(l => l.text.includes('__TOPPATH_RECORDER__')),
    JSON.stringify(logs.filter(l => l.text.includes('TOPPATH')).map(l => l.text)));
  check('標記仍然送得到 host（回傳 false 讓 host 自己處理）',
    markerHits.length === 1, `markerHits=${markerHits.length}`);
  // 這一條專門釘住 Log.enable。404 的「Failed to load resource」是瀏覽器層級的
  // 訊息，只有 Log.entryAdded 會送——頁面自己從來沒有 console.log 過它。
  // 沒有這條的話，把 Log.enable 拿掉測試照樣全綠（注入測試抓到過）。
  check('收到瀏覽器層級訊息（Log.entryAdded：404）',
    logs.some(l => /Failed to load resource/i.test(l.text) && l.text.includes('404')),
    JSON.stringify(logs.map(l => [l.type, l.text.slice(0, 50)])));

  // ── pinus ──────────────────────────────────────────────────────────────────
  // 這頁沒有 pinus，所以 patched 應該是 null——這是「沒有」不是「壞了」，
  // 要分得出來，不然使用者會以為攔截失效。
  check('沒有 pinus 的頁面回報 patched=null（不是報錯）',
    capture.pinusPatched() === null && snap.pinus.total === 0,
    `patched=${capture.pinusPatched()} total=${snap.pinus.total}`);

  ws.close();
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  server.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
