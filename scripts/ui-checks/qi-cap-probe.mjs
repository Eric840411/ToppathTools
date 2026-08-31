/**
 * 靈氣進度條左端沒有圓弧——查是 CSS 沒生效還是素材沒載到。
 *
 * 使用者 2026-08-31：「初始位置沒有圓弧呈現」。截圖放大後左端是**一刀切的垂直邊**，
 * 但右端的發散（::after）是正常的——所以不是整組沒生效，是 ::before 這一顆的問題。
 *
 * 素材本身已排除：qi-cap-anim.webp 的 alpha 從第 0 欄的 4 漸變到第 13 欄的 252，
 * 圓弧是有的。
 *
 * 跑法：node scripts/ui-checks/qi-cap-probe.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 3 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

const assetLog = [];
page.on('response', r => { if (/qi-(cap|mid|tail)/.test(r.url())) assetLog.push(`${r.status()} ${r.url().split('/').pop()}`) });

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);   // 讓生長動畫跑完

console.log('素材請求：', assetLog.length ? assetLog.join(' | ') : '（一個都沒有——CSS 沒載或選擇器沒命中）');

const info = await page.evaluate(() => {
  const fill = document.querySelector('.dashboard-bar-fill');
  if (!fill) return { missing: true };
  const cs = getComputedStyle(fill);
  const before = getComputedStyle(fill, '::before');
  const after = getComputedStyle(fill, '::after');
  const r = fill.getBoundingClientRect();
  const pick = s => ({ content: s.content, display: s.display, position: s.position,
                       left: s.left, width: s.width, height: s.height,
                       bg: s.backgroundImage.slice(0, 90), zIndex: s.zIndex, opacity: s.opacity });
  return {
    fill: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), pos: cs.position,
            radius: cs.borderRadius, overflow: cs.overflow,
            bg: cs.backgroundImage.slice(0, 90) },
    before: pick(before), after: pick(after),
    // 有沒有其他規則也在動 ::before
    sheets: [...document.styleSheets].map(s => s.href || 'inline').filter(h => /xianxia|App/.test(h) || h === 'inline').length,
  };
});
console.log('\n' + JSON.stringify(info, null, 2));

// 逐像素看左端 12px：圓弧的話上下 alpha 應該比中間低
const fill = page.locator('.dashboard-bar-fill').first();
const box = await fill.boundingBox();
if (box) {
  await page.screenshot({ path: path.join(root, 'qi-bar-live.png'),
    clip: { x: box.x - 6, y: box.y - 8, width: Math.min(200, box.width + 60), height: box.height + 16 } });
  console.log(`\n截圖：qi-bar-live.png（fill ${box.width.toFixed(1)}×${box.height.toFixed(1)}）`);
}

await browser.close();
