/**
 * 用假資料餵真的 SSE，截出「執行中」的 UAT 畫面。
 *
 * ⚠️ **這不是真的跑一次測試。**
 *    真的跑會用真實帳密登入 CP/NC 後台、開 Playwright 跑幾分鐘，
 *    而且 UAT_DRY_RUN 只保證不寫 Lark，仍然會打到正式後台。
 *    要看畫面長怎樣不需要付那個代價。
 *
 * 做法：攔截 `/api/osm-uat/stream`，回一段自己組的 event-stream。
 * **前端的解析與渲染是 100% 真的**（同一個 EventSource、同一組 handler、
 * 同一個 NetworkPanel），只有資料是合成的。
 *
 * 跑法：node scripts/ui-checks/uat-run-preview.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

// 依 NetworkPanel.tsx 的 NetSummary 型別組。數字取「看起來像真的一輪」的量級，
// 不是隨便填——門檻用 runner 的預設值（api 2000 / image 1500 / other 3000）
const stats = {
  scope: 'backend',
  net: {
    thresholds: { api: 2000, image: 1500, other: 3000 },
    totals: { captured: 381, counted: 163, likelyCached: 190, redirects: 12, preflights: 14, failed: 2, dropped: 0 },
    api:   { count: 96, avgMs: 412, maxMs: 3180, p95Ms: 1824 },
    image: { count: 58, avgMs: 221, maxMs: 1642, p95Ms: 703 },
    other: { count: 9,  avgMs: 180, maxMs: 421,  p95Ms: 388 },
    slow: [
      { url: 'https://qat-cp.osmslot.org/egm/reports/gameCount', kind: 'api', durationMs: 3180, thresholdMs: 2000, overThresholdMs: 1180 },
      { url: 'https://qat-cp.osmslot.org/egm/reports/playerMachineCount', kind: 'api', durationMs: 2430, thresholdMs: 2000, overThresholdMs: 430 },
      { url: 'https://qat-cp.osmslot.org/static/img/jackpot-banner.png', kind: 'image', durationMs: 1642, thresholdMs: 1500, overThresholdMs: 142 },
    ],
    apiCalls: [
      { method: 'POST', url: 'https://qat-cp.osmslot.org/*/login', status: 200, durationMs: 268, ts: Date.now() - 90000 },
      { method: 'GET',  url: 'https://qat-cp.osmslot.org/egm/reports/gameCount', status: 200, durationMs: 3180, ts: Date.now() - 61000 },
      { method: 'GET',  url: 'https://qat-cp.osmslot.org/egm/reports/jackpotRecordList', status: 200, durationMs: 742, ts: Date.now() - 40000 },
      { method: 'GET',  url: 'https://qat-cp.osmslot.org/public/gameNameAlias', status: 200, durationMs: 96, ts: Date.now() - 22000 },
      { method: 'GET',  url: 'https://qat-cp.osmslot.org/egm/reports/*/detail', status: 500, durationMs: 1210, ts: Date.now() - 8000 },
    ],
    apiCallsTruncated: 91,
  },
  final: false,
};

const logLines = [
  '🚀 派工給 Agent：DESKTOP-QA01（agent-7f3c）',
  '▶ 模組 1/12：總覽觀測陣（Dashboard）',
  '  ✅ Date：日期選擇器存在且可切換',
  '  ✅ Game Type：下拉共 14 個選項',
  '  ✅ Client Version：欄位存在',
  '  ⚠️ Daily Dashboard：需人工確認（要切渠道比對）',
  '▶ 模組 2/12：靈機核心簿（EGM List）',
  '  ✅ EGM List：表格欄位齊全（12 欄）',
  '  ✅ EGM Status：狀態徽章顯示正常',
  '  🐢 GET /egm/reports/gameCount 3180ms（門檻 2000ms，超出 1180ms）',
  '  ✅ Gaming User：需真實玩家資料，標記為人工判讀',
  '▶ 模組 3/12：報表玉簡庫（EGM Detail）',
  '  ✅ EGM Detail：搜尋欄位 6 個全部存在',
  '  ✅ Transfer：日期元件正常',
  '  ❌ DayCount：Export 按鈕找不到（可能要先送出查詢）',
  '  ✅ Game Record：欄位比對通過',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// 攔截 SSE，回自己組的事件流
await page.route('**/api/osm-uat/stream', async route => {
  const parts = [];
  parts.push(`event: status\ndata: ${JSON.stringify({ status: 'running' })}\n\n`);
  for (const line of logLines) parts.push(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
  parts.push(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: parts.join(''),
  });
});

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
for (const t of ['OSM Tools', 'UAT 整合測試']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1600) }
}
await page.waitForTimeout(1200);

const got = await page.evaluate(() => {
  const pre = document.querySelector('.uat-backend-log pre');
  const net = document.querySelector('.uat-net-panel');
  return {
    logLines: pre ? pre.textContent.trim().split('\n').filter(Boolean).length : 0,
    netRendered: !!net && !net.textContent.includes('尚未起測'),
    slowRows: document.querySelectorAll('.uat-net-slow-row, .uat-net-slow tbody tr').length,
  };
});
console.log('日誌行數:', got.logLines, '| 網路面板有資料:', got.netRendered, '| 超標列數:', got.slowRows);
console.log(got.logLines > 5 && got.netRendered ? '✅ 兩個面板都吃到資料了' : '❌ 面板沒有渲染出資料');

await page.screenshot({ path: path.join(root, 'uat-run-preview.png') });
console.log('截圖：uat-run-preview.png');
await browser.close();
