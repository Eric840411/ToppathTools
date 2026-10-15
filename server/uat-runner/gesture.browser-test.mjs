/**
 * 長按（long_press）／拖動（drag）的瀏覽器測試：真的開 Chromium、真的送觸控／滑鼠事件，看頁面收到什麼。
 *
 * ## 為什麼一定要真的跑
 * 觸控走 CDP Input.dispatchTouchEvent——事件形狀（touchPoints、touchEnd 要空陣列）、
 * 手機模擬下原生列表會不會跟著滑、長按時間是不是真的有按住，這些用假的 page 都驗不出來。
 * CodeX 1015 要求至少驗：寶箱（拖到目標）、原生列表滑動、長按後拖動、中途失敗不重送。
 *
 * 跑法：node server/uat-runner/gesture.browser-test.mjs
 */
import { chromium } from 'playwright';
import { isNoRetryError, runFrontendStep } from './frontend-engine.js';
import { createFrontendTcEngine } from './frontend-tc-engine.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; font: 14px sans-serif; }
  #spin { position: absolute; left: 20px; top: 20px; width: 120px; height: 60px; background: #c33; touch-action: none; }
  #chest { position: absolute; left: 20px; top: 120px; width: 60px; height: 60px; background: gold; touch-action: none; }
  #slot { position: absolute; left: 250px; top: 120px; width: 80px; height: 80px; background: #3c3; }
  #covered { position: absolute; left: 20px; top: 220px; width: 80px; height: 40px; background: #33c; }
  #mask { position: absolute; left: 0; top: 210px; width: 200px; height: 60px; background: rgba(0,0,0,.4); }
  #list { position: absolute; left: 220px; top: 220px; width: 140px; height: 200px; overflow-y: auto; }
  #list div { height: 60px; border-bottom: 1px solid #ccc; }
</style>
<div id="spin">SPIN</div><div id="chest"></div><div id="slot"></div>
<div id="covered"></div><div id="mask"></div>
<div id="list">${Array.from({ length: 20 }, (_, i) => `<div>item ${i}</div>`).join('')}</div>
<script>
  window.__ev = [];
  const log = (e) => {
    const p = e.touches ? (e.changedTouches[0] || {}) : e;
    __ev.push({ type: e.type, id: e.currentTarget.id, t: performance.now(), x: Math.round(p.clientX || 0), y: Math.round(p.clientY || 0), pt: e.pointerType || '' });
  };
  for (const id of ['spin', 'chest']) {
    const el = document.getElementById(id);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel']) el.addEventListener(t, log);
  }
  // 寶箱：跟著手指走，放開時看落在哪
  const chest = document.getElementById('chest');
  let drag = null;
  chest.addEventListener('pointerdown', e => { drag = { dx: e.clientX - chest.offsetLeft, dy: e.clientY - chest.offsetTop }; chest.setPointerCapture(e.pointerId); });
  chest.addEventListener('pointermove', e => { if (drag) { chest.style.left = (e.clientX - drag.dx) + 'px'; chest.style.top = (e.clientY - drag.dy) + 'px'; } });
  chest.addEventListener('pointerup', e => {
    drag = null;
    const s = document.getElementById('slot').getBoundingClientRect();
    window.__dropped = e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom;
  });
</script>`;

const browser = await chromium.launch();
const logs = [];
const ctxFor = page => ({
  idx: '[1/1]', label: 'gesture', log: l => { logs.push(l); }, page, browser,
  recordedLocator: async sel => page.locator(sel), netCapture: null, state: { netMark: Date.now() },
  startUrl: 'http://qat.example/', viewportHeight: 640, backend: null,
});
const run = (page, step) => runFrontendStep({ name: step.action, ...step }, ctxFor(page));
const events = page => page.evaluate(() => window.__ev);
// ⚠️ 每次都先換一份新 document：setContent 是在同一份 document 上重寫，舊的全域（const log）還在，
//    第二次的 script 會 SyntaxError，__ev／__dropped 留著上一輪的——量到的是上一個手勢
const fresh = async page => { await page.goto('about:blank'); await page.setContent(PAGE); };

for (const mode of ['touch', 'mouse']) {
  const touch = mode === 'touch';
  const context = await browser.newContext({ viewport: { width: 390, height: 640 }, isMobile: touch, hasTouch: touch });
  const page = await context.newPage();
  await fresh(page);

  // ── 長按：真的按住、而且是這種裝置的事件 ──
  await run(page, { action: 'long_press', selector: '#spin', holdMs: 900 });
  let ev = (await events(page)).filter(e => e.id === 'spin');
  const down = ev.find(e => e.type === (touch ? 'touchstart' : 'pointerdown'));
  const up = ev.find(e => e.type === (touch ? 'touchend' : 'pointerup'));
  check(`[${mode}] 長按：有按下、有放開`, !!down && !!up, JSON.stringify(ev.map(e => e.type)));
  check(`[${mode}] 長按：按住時間 ≥ 900ms`, !!down && !!up && up.t - down.t >= 880, down && up ? `${Math.round(up.t - down.t)}ms` : '');
  check(`[${mode}] 長按：${touch ? '觸控事件（不是只有滑鼠）' : '滑鼠事件（不是觸控）'}`, touch ? ev.some(e => e.type === 'touchstart') : !ev.some(e => e.type === 'touchstart') && down?.pt === 'mouse', JSON.stringify(ev.map(e => e.type)));
  check(`[${mode}] 長按：點在元素中心`, !!down && Math.abs(down.x - 80) <= 1 && Math.abs(down.y - 50) <= 1, down ? `${down.x},${down.y}` : '');

  // 座標版長按
  await page.evaluate(() => { window.__ev = []; });
  await run(page, { action: 'long_press', x: 30, y: 30, holdMs: 300 });
  ev = (await events(page)).filter(e => e.id === 'spin');
  check(`[${mode}] 長按（座標）也打得到`, ev.some(e => e.type === (touch ? 'touchend' : 'pointerup')), JSON.stringify(ev.map(e => e.type)));

  // ── 寶箱：拖到目標上 ──
  await page.evaluate(() => { window.__ev = []; window.__dropped = undefined; });
  await run(page, { action: 'drag', fromSelector: '#chest', toSelector: '#slot', durationMs: 400, moveSteps: 8 });
  ev = (await events(page)).filter(e => e.id === 'chest');
  const moves = ev.filter(e => e.type === (touch ? 'touchmove' : 'pointermove')).length;
  check(`[${mode}] 拖動：寶箱落在目標上`, await page.evaluate(() => window.__dropped) === true, JSON.stringify(ev.map(e => e.type)));
  check(`[${mode}] 拖動：中間有分段移動（≥ 8 次 move）`, moves >= 8, `move ${moves} 次`);

  // ── 長按後拖動：先按住才開始移 ──
  await fresh(page);
  await run(page, { action: 'drag', fromSelector: '#chest', toX: 290, toY: 160, holdMs: 700, durationMs: 200, moveSteps: 4 });
  ev = (await events(page)).filter(e => e.id === 'chest');
  const d0 = ev.find(e => e.type === (touch ? 'touchstart' : 'pointerdown'));
  const m0 = ev.find(e => e.type === (touch ? 'touchmove' : 'pointermove') && d0 && e.t > d0.t);
  check(`[${mode}] 長按後拖動：按下到第一次移動 ≥ 700ms`, !!d0 && !!m0 && m0.t - d0.t >= 680, JSON.stringify(ev.map(e => [e.type, Math.round(e.t)])));
  check(`[${mode}] 長按後拖動：寶箱照樣落在目標上`, await page.evaluate(() => window.__dropped) === true);

  // ── 原生列表滑動（手機才有意義：觸控拖動要讓瀏覽器自己捲）──
  if (touch) {
    await run(page, { action: 'drag', fromX: 290, fromY: 400, toX: 290, toY: 240, durationMs: 300, moveSteps: 10 });
    const top = await page.evaluate(() => document.getElementById('list').scrollTop);
    check('[touch] 原生列表：觸控往上拖會捲動', top > 50, `scrollTop=${top}`);
  }

  // ── 被蓋住：按下去之前就失敗，而且可以重試（還沒動到畫面）──
  let err = null;
  try { await run(page, { action: 'long_press', selector: '#covered', holdMs: 100 }); } catch (e) { err = e; }
  check(`[${mode}] 被蓋住 → 按下去之前失敗`, !!err && /被蓋住/.test(err.message), err?.message);
  check(`[${mode}] 被蓋住 → 可以重試（還沒按下去）`, !!err && !isNoRetryError(err));

  // ── 兩端都填或都沒填 → 擋 ──
  err = null;
  try { await run(page, { action: 'drag', fromSelector: '#chest', fromX: 1, fromY: 1, toX: 5, toY: 5 }); } catch (e) { err = e; }
  check(`[${mode}] 起點 selector 和座標都填 → 擋`, !!err && /擇一/.test(err.message), err?.message);
  err = null;
  try { await run(page, { action: 'long_press', selector: '#spin', holdMs: 20000 }); } catch (e) { err = e; }
  check(`[${mode}] 按住毫秒超出範圍 → 擋（不默默夾成 10000）`, !!err && /holdMs/.test(err.message), err?.message);

  // ── 中途失敗：按下去之後失敗就不能重試，而且有放開（觸控 touchCancel／滑鼠 up）──
  await fresh(page);
  err = null;
  const p = run(page, { action: 'long_press', selector: '#spin', holdMs: 3000 });
  setTimeout(() => { page.evaluate(() => { throw new Error('x'); }).catch(() => {}); page.close().catch(() => {}); }, 400);
  try { await p; } catch (e) { err = e; }
  check(`[${mode}] 中途失敗 → 標成不可重試`, !!err && isNoRetryError(err), err?.message);

  // 聚合器（綁 TC 的執行）也不能重試：failureMode retry×3，按下去之後失敗只能跑一次
  const page2 = await context.newPage();
  await fresh(page2);
  await page2.evaluate(() => { window.__downs = 0; document.getElementById('spin').addEventListener('pointerdown', () => window.__downs++); });
  // 按住期間「斷線」：waitForTimeout 丟錯（按下已經送出）。其他照真的 page 走
  const flaky = new Proxy(page2, { get(t, k) {
    if (k === 'waitForTimeout') return async () => { throw new Error('連線中斷（模擬）'); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const engine = createFrontendTcEngine({ ...ctxFor(page2), page: flaky });
  const out = await engine.runSteps([{ action: 'long_press', name: '長按 SPIN', selector: '#spin', holdMs: 500, failureMode: 'retry', retryCount: 3 }], {}, {});
  const tried = await page2.evaluate(() => window.__downs);
  check(`[${mode}] 聚合器：按下去之後失敗不重試（只按了 1 次）`, tried === 1 && !out.pass, `按了 ${tried} 次；notes=${JSON.stringify(out.notes ?? out).slice(0, 200)}`);
  await context.close();
}

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
