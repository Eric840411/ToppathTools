/**
 * 對帳頁的日期/時間輸入框——原生選擇器圖示在普通版看不看得見。
 *
 * 那個圖示的顏色是瀏覽器依 color-scheme 決定的，CSS 只能靠 filter 硬改或設 color-scheme。
 * **要量的是實際渲染的像素亮度**，不是讀 CSS——filter/color-scheme 有沒有生效看不出來。
 *
 * 跑法：cd scripts/ui-checks && node date-icon.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

for (const mode of ['classic', 'xianxia']) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  for (const g of ['OSM Tools', '玄樞百器']) {
    const l = page.locator(`text=${g}`).first();
    if (await l.count()) { await l.click().catch(()=>{}); await page.waitForTimeout(600) }
  }
  for (const t of ['Performance Meter', '天秤校帳']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(()=>{}); await page.waitForTimeout(2200); break }
  }
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  const t = page.locator('input[type=time]').first();
  const d = page.locator('input[type=date]').first();
  console.log(`\n[${mode}] html color-scheme: ${scheme}`);
  for (const [name, loc] of [['date', d], ['time', t]]) {
    if (!await loc.count()) { console.log(`  ${name}: 找不到`); continue }
    await loc.screenshot({ path: `dateicon-${mode}-${name}.png` });
    console.log(`  ${name}: 截圖 dateicon-${mode}-${name}.png`);
  }
}
await browser.close();
