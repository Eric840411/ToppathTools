/**
 * 逐頁量「內容有沒有填滿可用寬度」，並截圖存檔。
 *
 * 用途：`.main-content` 原本有 `max-width: 1280px`，只有掛 `--full` 的頁面才滿版。
 * 使用者要求全部滿版自適應、而且未來新功能也要一致。拿掉那個上限之前先量一輪，
 * 拿掉之後再量一輪比對——**不要憑印象說「應該不會壞」**。
 *
 * 跑法：cd scripts/ui-checks && node page-width-sweep.mjs [標記]
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const tag = process.argv[2] ?? 'run';
const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'classic'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 展開所有側邊欄群組，才點得到子項（這個 app 沒有 URL 路由）
for (const g of ['Jira / TestCase', 'OSM Tools', 'Game Show', '系統']) {
  const l = page.locator(`text=${g}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(500) }
}

const names = await page.evaluate(() =>
  [...new Set([...document.querySelectorAll('nav button, aside button, .sidebar-item')]
    .map(e => (e.textContent ?? '').trim()).filter(t => t && t.length < 18))]);

console.log(`\n視窗 1920px，逐頁量「內容寬 / 可用寬」（${tag}）：\n`);
for (const name of names.slice(0, 26)) {
  const l = page.locator(`text=${name}`).first();
  if (!await l.count()) continue;
  await l.click().catch(() => {});
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const main = document.querySelector('.main-content');
    if (!main) return null;
    const cs = getComputedStyle(main);
    const inner = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // 找出最寬的直接子孫，代表內容實際用掉多少
    let widest = 0;
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > widest && r.width <= inner + 2) widest = r.width;
    }
    return { avail: Math.round(inner), used: Math.round(widest), maxW: cs.maxWidth };
  });
  if (!m) continue;
  const pct = m.avail > 0 ? Math.round(m.used / m.avail * 100) : 0;
  console.log(`  ${name.padEnd(16)} 可用 ${String(m.avail).padStart(4)}px  內容 ${String(m.used).padStart(4)}px  (${pct}%)  max-width:${m.maxW}`);
}

await browser.close();
