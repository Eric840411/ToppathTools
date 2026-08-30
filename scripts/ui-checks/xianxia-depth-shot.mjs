/**
 * 修仙版縱深修正的驗收截圖：只截「往下捲一屏」那一段。
 *
 * 為什麼要單獨一支：問題本來就不在第一屏（Hero 一直都做得很足），
 * 在往下之後。截整頁的話那一段會被壓得很小看不出差別。
 *
 * 跑法：cd scripts/ui-checks && node xianxia-depth-shot.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

// 四張數據卡
const metrics = page.locator('.dashboard-metrics');
if (await metrics.count()) await metrics.screenshot({ path: '../../xx-metrics.png' });

// 表格 + 資源使用量（靈脈進度條在這裡）
const grid = page.locator('.dashboard-grid');
if (await grid.count()) await grid.screenshot({ path: '../../xx-grid.png' });

// 量一下實際套用的值，不要只憑肉眼
const measured = await page.evaluate(() => {
  const pick = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    const out = { sel };
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const tipCs = (() => {
    const el = document.querySelector('.dashboard-bar-fill');
    if (!el) return null;
    const cs = getComputedStyle(el, '::after');
    return { animation: cs.animationName, w: cs.width, bg: cs.backgroundColor };
  })();
  return {
    value: pick('.dashboard-metric-value', ['color', 'font-family', 'font-weight']),
    th: pick('.dashboard-table th', ['color', 'font-family', 'letter-spacing']),
    chip: pick('.dashboard-chip', ['font-family', 'border-radius', 'letter-spacing']),
    track: pick('.dashboard-bar-track', ['height', 'border-radius', 'overflow']),
    tip: tipCs,
  };
});

for (const [k, v] of Object.entries(measured)) {
  console.log(k + ':', JSON.stringify(v));
}
console.log('\nxx-metrics.png / xx-grid.png');
await browser.close();
