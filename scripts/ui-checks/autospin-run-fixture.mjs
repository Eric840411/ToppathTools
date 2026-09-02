/**
 * 用「塞滿的假資料」檢查執行監控版面。
 *
 * ⚠️ 之前每一次驗證都是在**空狀態**下做的——沒有 LuckyLink、沒有截圖、沒有對帳資料、
 *    沒有獎池。空的時候什麼版面都好看；會撐爆的是資料塞滿的時候
 *    （使用者 2026-09-02：「你可以塞一些假想數據，看看版面有沒有符合」）。
 *
 * 這支把每一個面板都餵到滿，然後量「有沒有橫向溢出」「有沒有被裁掉」。
 * 不改任何程式碼、不寫入資料庫——純粹 route 攔截。
 *
 * 跑法：node scripts/ui-checks/autospin-run-fixture.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

/** 一張 1x1 透明 png，當截圖縮圖用——重點是版面不是畫面內容 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LOG_LINES = [];
for (let i = 1; i <= 120; i++) {
  const t = `10:${String(10 + (i % 50)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
  LOG_LINES.push(`[${t}] [RISINGROCKETS] Spin #${1690 + i} 餘額 ${1094408 - i * 5}.00 → ${1094403 - i * 5}.00（-5.00）`);
  if (i % 6 === 0) LOG_LINES.push(`[${t}] [RISINGROCKETS] ⚠️ Spin 被伺服器拒絕，耗時 8.0s（errcode:100 請求超時或未確認錯誤）`);
  if (i % 9 === 0) LOG_LINES.push(`[${t}] [RISINGROCKETS] ERROR 連線逾時，重新連線中（第 ${i / 9} 次）`);
  if (i % 4 === 0) LOG_LINES.push(`[${t}] [RISINGROCKETS][pinus:push] moneyNtc coin=${1094403 - i * 5} reason=end`);
  // 特意放一行超長的，看單行截斷會不會把版面撐開
  if (i === 30) LOG_LINES.push(`[${t}] [RISINGROCKETS][pinus:req] dealGMActionReq ${JSON.stringify({ isspin: 1, bet: 1250, lines: 243, extra: 'x'.repeat(300) })}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1080 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

const json = (data) => (r) => r.fulfill({ json: data });

// ── 每一個面板都餵到滿 ──
await page.route('**/api/machine-test/osm-jackpot*', json({
  ok: true,
  jackpots: [
    { gmid: '873-RISINGROCKETS-0140', name: 'RISINGROCKETS', grand: 4125689.5, major: 503214.32, minor: 52183.61, mini: 11247.83, fortunate: 8123.4, updatedAt: Date.now() },
    { gmid: '873-BULLBLITZ-0136', name: 'BULLBLITZ', grand: 3980112.7, major: 488901.11, minor: 49877.02, mini: 10933.5, fortunate: 7788.1, updatedAt: Date.now() },
  ],
}));
await page.route('**/api/autospin/hub-agents*', json({
  ok: true,
  agents: [
    { agentId: 'a1', hostname: 'MacBook-Pro-2.local', ownerName: 'Eric Wu', capabilities: ['machine-test', 'scripted-bet', 'uat-record', 'uat-run', 'autospin', 'backend-uat'], busy: false, sessionId: null, connectedAt: Date.now(), lastSeenAt: Date.now(), updateStatus: 'current' },
    { agentId: 'a2', hostname: 'QA-WIN-STATION-07.corp.local', ownerName: 'Eric Wu', capabilities: ['machine-test', 'autospin'], busy: true, sessionId: 's9', connectedAt: Date.now(), lastSeenAt: Date.now(), updateStatus: 'needs_update' },
    { agentId: 'a3', hostname: 'lab-agent-03', ownerName: 'Eric Wu', capabilities: ['autospin'], busy: false, sessionId: null, connectedAt: Date.now(), lastSeenAt: Date.now(), updateStatus: 'needs_restart' },
  ],
}));
await page.route('**/api/autospin/agent/status*', json({ ok: true, running: true, sessionId: 'demo-sess-0001', status: 'running', startedAt: Date.now() - 9245000 }));
await page.route('**/api/autospin/compare/status*', json({
  ok: true, hasBoxLeg: false, groupCount: 2, sessionCount: 1,
  machines: [
    { sessionId: 's1', machineType: 'RISINGROCKETS', agentLabel: 'MacBook-Pro-2.local', compared: 1234, matched: 1230, mismatched: 3, missing: 1 },
    { sessionId: 's1', machineType: 'BULLBLITZ', agentLabel: 'MacBook-Pro-2.local', compared: 981, matched: 975, mismatched: 4, missing: 2 },
  ],
}));
// ⚠️ agent 模式的截圖走 `/agent/screenshots/:id`，不是 captures-list。
//    第一版只攔了後者，結果右欄一直顯示「尚無截圖」——**等於整個右欄沒驗到**，
//    而右欄正是這次要確認的地方之一。
await page.route('**/api/autospin/captures-list*', json({
  ok: true,
  files: Array.from({ length: 8 }, (_, i) => ({ name: `RISINGROCKETS_spin${1700 + i}.png`, dir: 'demo', mtime: Date.now() - i * 20000 })),
}));
await page.route('**/api/autospin/agent/screenshots/**', json({
  ok: true,
  files: Array.from({ length: 9 }, (_, i) => ({ name: `RISINGROCKETS_spin${1700 + i}.png`, time: Date.now() - i * 20000 })),
}));
await page.route('**/api/autospin/agent/screenshot/**', (r) => r.fulfill({
  status: 200, contentType: 'image/png', body: Buffer.from(PNG.split(',')[1], 'base64'),
}));
await page.route('**/api/autospin/screenshot-prefs*', json({ ok: true, screenshotEnabled: true }));
await page.route('**/*.png', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG.split(',')[1], 'base64') }));
await page.route('**/api/autospin/agent/stream/**', (r) => r.fulfill({
  status: 200, headers: { 'Content-Type': 'text/event-stream' },
  body: LOG_LINES.map(l => `data: ${JSON.stringify({ line: l })}\n\n`).join(''),
}));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1700);
await page.locator('text=OSM Tools').first().click().catch(() => {});
await page.waitForTimeout(1200);
for (const t of ['AutoSpin', '傀儡監院']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1800); break }
}
const runTab = page.locator('button', { hasText: '執行監控' }).first();
// ⚠️ 截圖是 5 秒輪詢一次（不是進頁面就抓），等太短會量到 0 張然後誤以為右欄壞掉。
// 第一次就是這樣——等 2.6 秒、看到「尚無截圖」，差點當成版面問題。
if (await runTab.count()) { await runTab.click(); await page.waitForTimeout(9000) }

const report = await page.evaluate(() => {
  const out = { 橫向溢出: [], 卡片: [], 日誌高: 0, 日誌行數: 0 };
  // 整頁不該橫向捲動
  out.頁面橫捲 = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
  for (const el of document.querySelectorAll('.autospin-run-cards > section, .autospin-log-panel, .uat-net-scroller')) {
    if (el.scrollWidth > el.clientWidth + 2) out.橫向溢出.push((el.textContent || '').slice(0, 24));
  }
  out.卡片 = [...document.querySelectorAll('.autospin-run-cards > section')]
    .map(c => ({ w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) }));
  const shots = document.querySelectorAll('.autospin-shot');
  out.截圖數 = shots.length;
  const p = document.querySelector('.autospin-log-panel');
  out.日誌高 = p ? Math.round(p.getBoundingClientRect().height) : 0;
  out.日誌行數 = p ? p.querySelectorAll('[title]').length : 0;
  return out;
});
console.log(JSON.stringify(report, null, 1));

await page.screenshot({ path: path.join(root, 'autospin-fixture.png'), fullPage: false });
console.log('截圖：autospin-fixture.png');
await browser.close();
