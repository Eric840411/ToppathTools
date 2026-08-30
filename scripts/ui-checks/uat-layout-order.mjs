/**
 * 量 UAT 後台工作台各區塊的**實際垂直順序與高度**。
 *
 * 為什麼要量：從 JSX 讀順序會判斷錯——積木編輯器其實是彈框（role="dialog"），
 * 不是頁面上的區塊；而 grid 的視覺順序也不一定等於 DOM 順序。
 * 要討論「把某一塊往上移」之前，得先確定它現在到底在哪。
 *
 * ⚠️ 這個 app 沒有 URL 路由，直接 goto 到不了 UAT 頁——
 *    必須先點「OSM Tools」群組，子項才會被 render 出來。
 *
 * 跑法：node scripts/ui-checks/uat-layout-order.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const g = page.locator('text=OSM Tools').first();
if (await g.count()) { await g.click().catch(() => {}); await page.waitForTimeout(700) }
const s = page.locator('text=UAT 整合測試').first();
if (await s.count()) { await s.click().catch(() => {}); await page.waitForTimeout(2800) }

const boxes = await page.evaluate(() => {
  const want = [
    ['.uat-backend-actions', '行動列'],
    ['.uat-backend-plan', '模組計畫（左）'],
    ['.uat-backend-center', '總覽＋風險佇列（中）'],
    ['.uat-backend-settings', '執行設定（右）'],
    ['.uat-backend-bottom', '下排：網路量測＋執行日誌'],
    ['.uat-backend-log', '　└ 執行日誌'],
    ['.uat-net-panel', '　└ 網路量測'],
    ['.uat-tc-modal', '積木編輯器（彈框）'],
  ];
  const out = [];
  for (const [sel, label] of want) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ label, missing: true }); continue }
    const r = el.getBoundingClientRect();
    out.push({
      label,
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      width: Math.round(r.width),
    });
  }
  return { out, pageHeight: document.documentElement.scrollHeight, viewport: window.innerHeight };
});

console.log(`頁面總高 ${boxes.pageHeight}px，視窗高 ${boxes.viewport}px` +
  (boxes.pageHeight > boxes.viewport ? `　→ 要捲 ${boxes.pageHeight - boxes.viewport}px 才看得到底` : '　→ 一屏放得下'));
console.log('');
console.log(`${'區塊'.padEnd(26)}${'頂端 y'.padStart(9)}${'高度'.padStart(8)}${'寬度'.padStart(8)}   是否在第一屏`);
console.log('-'.repeat(72));
for (const b of boxes.out) {
  if (b.missing) { console.log(`${b.label.padEnd(24)}  （目前不存在／未開啟）`); continue }
  const visible = b.top < boxes.viewport ? '✅ 是' : `❌ 否（要捲 ${b.top - boxes.viewport}px）`;
  console.log(`${b.label.padEnd(24)}${String(b.top).padStart(9)}${String(b.height).padStart(8)}${String(b.width).padStart(8)}   ${visible}`);
}

await page.screenshot({ path: path.join(root, 'uat-layout.png'), fullPage: true });
console.log('\n全頁截圖：uat-layout.png');
await browser.close();
