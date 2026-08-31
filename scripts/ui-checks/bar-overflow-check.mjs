/**
 * 量進度條在**極小值**時的幾何：靈氣有沒有溢出軌道左緣。
 *
 * 使用者回報「靈脈壓力」那條的靈氣跑到軌道外面。那條通常是 4 條裡數值最小的，
 * 所以懷疑是「填充寬度比端點素材還窄」時的邊界情況——
 * 端點是絕對定位、寬度固定的偽元素，fill 一窄它就沒地方站。
 *
 * 攔截 /api/dashboard/summary 塞一組極端值（0 / 1% / 3% / 60%），
 * 一次看完各種寬度下的行為。**不改後端、不影響真實資料。**
 *
 * 跑法：node scripts/ui-checks/bar-overflow-check.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// 讓四條分別是 0% / 極小 / 小 / 中，一次看完
await page.route('**/api/dashboard/summary', async route => {
  const res = await route.fetch();
  const data = await res.json();
  if (data && data.server) {
    data.server.memory.rss = 0                                   // 0%
    data.worker = data.worker ?? {}
    data.worker.worker = { memory: { rss: Math.round(700 * 1024 * 1024 * 0.01) } }  // 1%
    data.server.memory.systemFree = Math.round(data.server.memory.systemTotal * 0.97) // 3%
    data.totals.requestsPerMinute = 180                          // 60%
  }
  await route.fulfill({ response: res, json: data });
});

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);   // 等展開動畫跑完

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.dashboard-bar-track').forEach((track, i) => {
    const fill = track.querySelector('.dashboard-bar-fill');
    if (!fill) return;
    const t = track.getBoundingClientRect();
    const f = fill.getBoundingClientRect();
    const before = getComputedStyle(fill, '::before');
    const after = getComputedStyle(fill, '::after');
    // 偽元素沒有 getBoundingClientRect，只能從 computed 值推。
    // ⚠️ 一定要同時看 left 跟 right 哪一個是實際生效的那個：
    //    改用 left 定位之後，right 會回 'auto'，parseFloat 得到 NaN，
    //    如果直接 `|| 0` 當成 0 來算，會算出一個看起來很正常的假位置。
    //    （這支第一版就是這樣，改完 CSS 後給出假的全綠。）
    const capW = parseFloat(before.width) || 0;
    const tailW = parseFloat(after.width) || 0;
    const tailLeftCss = parseFloat(after.left);        // NaN 代表用的是 right
    const tailRightCss = parseFloat(after.right);
    const capLeft = f.left;                            // ::before 是 left: 0
    const tailLeft = Number.isFinite(tailLeftCss)
      ? f.left + tailLeftCss                           // left 定位：相對 fill 左緣
      : f.right - (tailRightCss || 0) - tailW;         // right 定位：從 fill 右緣往外推
    if (!Number.isFinite(tailLeftCss) && !Number.isFinite(tailRightCss)) {
      out.push({ i, broken: 'tail 的 left/right 都是 auto，量不出位置' });
      return;
    }
    out.push({
      i,
      pct: Math.round((f.width / t.width) * 1000) / 10,
      trackLeft: Math.round(t.left), fillLeft: Math.round(f.left), fillW: Math.round(f.width),
      capW: Math.round(capW), tailW: Math.round(tailW),
      usedSide: Number.isFinite(tailLeftCss) ? 'left' : 'right',
      capOverflowLeft: Math.round(t.left - capLeft),
      tailOverflowLeft: Math.round(t.left - tailLeft),
    });
  });
  return out;
});

console.log(`${'#'.padEnd(3)}${'寬度%'.padStart(7)}${'fill px'.padStart(9)}${'cap 左溢'.padStart(10)}${'tail 左溢'.padStart(11)}   判定`);
console.log('-'.repeat(58));
let bad = 0;
for (const r of rows) {
  if (r.broken) { console.log(`${String(r.i).padEnd(3)} ❌ ${r.broken}`); bad++; continue }
  const worst = Math.max(r.capOverflowLeft, r.tailOverflowLeft);
  const ok = worst <= 1;
  if (!ok) bad++;
  console.log(
    `${String(r.i).padEnd(3)}${String(r.pct).padStart(6)}%${String(r.fillW).padStart(9)}` +
    `${String(r.capOverflowLeft).padStart(10)}${String(r.tailOverflowLeft).padStart(11)}   ` +
    (ok ? '✅' : `❌ 往左凸出軌道 ${worst}px`),
  );
}
console.log('');
console.log(bad ? `❌ ${bad} 條溢出軌道左緣` : '✅ 四條都沒有溢出');

await page.screenshot({ path: path.join(root, 'bar-overflow.png') });
await browser.close();
process.exit(bad ? 1 : 0);
