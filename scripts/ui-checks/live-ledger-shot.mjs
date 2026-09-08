/**
 * 對帳台改版後的實際渲染量測（獎池區 + 機台總覽）。
 *
 * ⚠️ 版面改動一律要看**實際渲染**，不能只看程式碼過不過型別——
 *    今天已經有一次「型別通過但 JSX 結構壞掉」。
 *
 * 跑法：node scripts/ui-checks/live-ledger-shot.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1080 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// ⚠️ 這個 app 沒有 URL 路由，頁面是純 React state——一定要先點群組再點子項，
//    直接 goto 或直接點子項都到不了（UAT 那次連續卡三次的教訓）。
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
const tab = page.locator('button', { hasText: '對帳台' }).first();
if (await tab.count()) { await tab.click(); await page.waitForTimeout(4000) }
else { console.log('找不到「對帳台」分頁'); }

// ⚠️ 預設視窗只有 30 分鐘，那段常常沒有資料——用 30 分鐘量會得到
//    「不符明細不見了」這種假結論。拉到 24 小時才驗得到完整版面。
const win = page.locator('select').filter({ hasText: '近 30 分鐘' }).first();
if (await win.count()) { await win.selectOption('1440'); await page.waitForTimeout(3500) }

// ⚠️ 測試登入的帳號跟資料的擁有者不一定一樣。機台總覽是**依帳號隔離**的，
//    不切成跨使用者檢視就會量到「這一區不見了」——那是隔離正常運作，不是版面壞掉。
const allBtn = page.locator('button', { hasText: '只顯示自己' }).first();
if (await allBtn.count()) { await allBtn.click(); await page.waitForTimeout(3500) }

const m = await page.evaluate(() => {
  const txt = document.body.innerText;
  const has = (s) => txt.includes(s);
  const tables = [...document.querySelectorAll('table')];
  const de = document.documentElement;
  return {
    有獎池區: has('獎池'),
    有水位欄: has('水位'),
    有不符明細: has('可能原因'),
    有機台總覽: has('機台總覽'),
    表格數: tables.length,
    // 橫向溢出是這種密集表格最常見的壞法
    溢出的元素: [...document.querySelectorAll('div,table')]
      .filter(el => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto')
      .slice(0, 5).map(el => ({
        w: `${el.scrollWidth}>${el.clientWidth}`,
        文字: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
        父: (el.parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
      })),
    頁面橫捲: de.scrollWidth > de.clientWidth + 2,
  };
});
console.log(JSON.stringify(m, null, 1));
await page.screenshot({ path: path.join(root, 'live-ledger-shot.png'), fullPage: false });
console.log('截圖：live-ledger-shot.png');
await browser.close();
