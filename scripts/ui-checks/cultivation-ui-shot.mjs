/**
 * 側邊欄修為區塊的截圖 + 實際數值檢查。
 *
 * 為了讓「有修為」的樣子看得到，這支會先塞一筆假的修為值進去、截圖、**再還原**。
 * 不塞的話本機帳號的 total_actions 是 0，只會看到「閉關中 / 今日功課 0」，
 * 看不出功課條長出來、副稱號變化的樣子。
 *
 * ⚠️ 一定要還原：這是使用者真實帳號的資料，不是測試帳號。
 *
 * 跑法：node scripts/ui-checks/cultivation-ui-shot.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));

const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
const acct = db.prepare('SELECT email FROM auth_sessions WHERE sid = ?').get(sess.sid);
const email = acct?.email;
if (!email) { console.log('session 沒有對應帳號'); process.exit(1) }

const before = db.prepare('SELECT total_actions, today_actions, today_date FROM account_cultivation WHERE operator_key = ?').get(email);
console.log('原始值：', JSON.stringify(before));

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
// 塞一組看得出效果的假值：修為 240（>200 → 破境在即）、今日 7 次（過了小周天 5，還沒到大周天 10）
db.prepare('UPDATE account_cultivation SET total_actions = 240, today_actions = 7, today_date = ? WHERE operator_key = ?').run(today, email);

try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const box = document.querySelector('.sidebar-cultivation');
    if (!box) return { missing: true };
    const bar = box.querySelector('.sidebar-cultivation-bar i');
    return {
      text: box.textContent?.trim(),
      barWidth: bar ? getComputedStyle(bar).width : null,
      trackWidth: bar?.parentElement ? getComputedStyle(bar.parentElement).width : null,
      questTitle: box.querySelector('.sidebar-cultivation-quest')?.getAttribute('title'),
      epithet: box.querySelector('.sidebar-cultivation-epithet')?.textContent,
    };
  });
  console.log('畫面上讀到：', JSON.stringify(info, null, 2));

  const el = page.locator('.sidebar-cultivation');
  if (await el.count()) {
    await el.screenshot({ path: path.join(root, 'xx-cultivation.png') });
    console.log('截圖：xx-cultivation.png');
  } else {
    console.log('❌ 找不到 .sidebar-cultivation');
  }
  await browser.close();
} finally {
  // 一定要還原，即使上面炸了
  if (before) {
    db.prepare('UPDATE account_cultivation SET total_actions = ?, today_actions = ?, today_date = ? WHERE operator_key = ?')
      .run(before.total_actions, before.today_actions, before.today_date, email);
  } else {
    db.prepare('DELETE FROM account_cultivation WHERE operator_key = ?').run(email);
  }
  const after = db.prepare('SELECT total_actions, today_actions, today_date FROM account_cultivation WHERE operator_key = ?').get(email);
  console.log('已還原：', JSON.stringify(after));
}
