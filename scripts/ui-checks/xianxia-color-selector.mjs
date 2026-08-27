/**
 * 修仙版有一條規則用「行內樣式含某個藍色」來抓主要按鈕：
 *
 *   .main-content [style*="rgb(37, 99, 235)"] { background: linear-gradient(...) !important; ... }
 *
 * 問題是它**比對的是顏色不是角色**——任何行內樣式剛好用到那個藍的元素都會中，
 * 包含只是把文字染成藍色的 <strong>。使用者看到的「我的 0 底色很奇怪」就是這樣來的。
 *
 * 收窄選擇器之前先量：全站有哪些元素會中這條規則、各是什麼 tag。
 * **不要憑印象改**——改太寬會讓真的按鈕失去樣式。
 *
 * 跑法：cd scripts/ui-checks && node xianxia-color-selector.mjs
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

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 逐個側邊欄項目走一遍，統計會中規則的元素
const groups = ['OSM Tools', '玄樞百器'];
for (const g of groups) {
  const l = page.locator(`text=${g}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(700) }
}

const items = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.sidebar-item, nav button, aside button')) {
    const t = (el.textContent ?? '').trim();
    if (t && t.length < 20) out.push(t);
  }
  return [...new Set(out)];
});

const tally = new Map();
const samples = [];
for (const name of items.slice(0, 20)) {
  const l = page.locator(`text=${name}`).first();
  if (!await l.count()) continue;
  await l.click().catch(() => {});
  await page.waitForTimeout(1200);
  const hits = await page.evaluate(() => {
    const sel = '.main-content [style*="rgb(99, 102, 241)"], .main-content [style*="rgb(59, 130, 246)"], .main-content [style*="rgb(37, 99, 235)"]';
    return [...document.querySelectorAll(sel)].map(el => {
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 24),
        clickable: el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button',
        // **要量的是規則有沒有真的套上去，不是有沒有符合屬性選擇器**——收窄選擇器之後
        // 元素照樣「含那個顏色字串」，只是規則不再命中。第一次寫成數屬性符合數，
        // 改完前後數字一模一樣，差點誤判成沒修好。
        styled: cs.backgroundImage.includes('linear-gradient'),
      };
    });
  });
  for (const h of hits) {
    if (!h.styled) continue;   // 規則沒套到就不算數
    const key = `${h.tag}${h.clickable ? '（可點）' : '（純文字）'}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (!h.clickable && samples.length < 12) samples.push(`${name} → <${h.tag}> "${h.text}"`);
  }
}

console.log('\n會中這條規則的元素統計：');
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n其中「不可點」的樣本（這些是被誤傷的）：');
for (const s of samples) console.log('  ' + s);
if (samples.length === 0) console.log('  （無）');

await browser.close();
