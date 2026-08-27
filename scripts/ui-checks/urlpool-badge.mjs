/**
 * 「我的 0」那個數字底色怪怪的——先重現再說，不要用讀 CSS 猜的。
 *
 * 這個 app 沒有 URL 路由（純 React state），要先點群組再點子項。
 * 截圖存下來直接看，另外把數字元素的 computed style 印出來對照。
 *
 * 跑法：cd scripts/ui-checks && node urlpool-badge.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

for (const mode of ['xianxia', 'classic']) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 先點群組展開，再點子項——直接點子項時它還沒被 render
  for (const t of ['OSM Tools', '玄樞百器']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(800); break }
  }
  for (const t of ['URL 帳號池', '靈脈調度']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(2500); break }
  }

  const info = await page.evaluate(() => {
    const out = [];
    for (const st of document.querySelectorAll('strong')) {
      const label = st.previousElementSibling?.textContent ?? '';
      if (!['總計', '可用', '使用中', '我的'].includes(label)) continue;
      const cs = getComputedStyle(st);
      out.push({
        label, text: st.textContent,
        color: cs.color, background: cs.backgroundColor,
        padding: cs.padding, borderRadius: cs.borderRadius,
        font: cs.fontFamily.slice(0, 30), fontSize: cs.fontSize,
        // 有沒有 ::before/::after 塞東西進去
        before: getComputedStyle(st, '::before').content,
        after: getComputedStyle(st, '::after').content,
      });
    }
    return out;
  });

  console.log(`\n===== ${mode} =====`);
  if (info.length === 0) { console.log('  ❌ 找不到那幾個數字（可能沒進到頁面）'); continue }
  for (const i of info) console.log(' ', JSON.stringify(i));

  const badges = page.locator('strong').first();
  if (await badges.count()) {
    const box = await page.locator('div').filter({ hasText: /^總計/ }).first().boundingBox().catch(() => null);
    if (box) {
      await page.screenshot({
        path: `urlpool-badge-${mode}.png`,
        clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: Math.min(700, box.width + 40), height: box.height + 20 },
      });
      console.log(`  截圖：urlpool-badge-${mode}.png`);
    }
  }
}

await browser.close();
