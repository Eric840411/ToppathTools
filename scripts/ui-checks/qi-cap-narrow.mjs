/**
 * 靈氣進度條在**低百分比**時左端沒有圓弧。
 *
 * 根因（算術上就能確定，不用猜）：
 *   requestPct = round(4 / 300 * 100) = 1%  → fill 只有約 3px 寬
 *   tail 的 left = calc(100% - min(11.25px, 100%))
 *                = 3px - min(11.25px, 3px) = 3px - 3px = 0
 *   tail 寬 41.25px、z-index: 3；cap 寬 23.5px、z-index: auto
 *   → **tail 整個蓋在 cap 上面**，看到的就是 tail 那一刀切的左緣。
 *
 * ⚠️ 本機重現不出來，因為本機的 req/min 較高、fill 有 47.9px 寬，
 *    tail 的 left 是 36.7px，離 cap 很遠。**只驗當下的真實數值等於驗不到**——
 *    要把寬度掃過一遍才看得見這個邊界。
 *
 * 判定方式：左端逐欄的「靈氣像素數」。圓弧的話應該由少變多（例如 2→8→16→22），
 * 一刀切的話第一欄就是滿高。
 *
 * 跑法：node scripts/ui-checks/qi-cap-narrow.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const WIDTHS = ['0%', '0.5%', '1%', '2%', '3%', '8%', '60%'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2600);

let pass = 0, fail = 0;
console.log('寬度      左端前 10 欄的靈氣像素數                      判定');
console.log('-'.repeat(74));

for (const w of WIDTHS) {
  // 直接改最後一條（靈脈壓力）的行內寬度
  await page.evaluate(width => {
    const fills = document.querySelectorAll('.dashboard-bar-fill');
    const el = fills[fills.length - 1];
    el.style.transition = 'none';
    el.style.width = width;
  }, w);
  await page.waitForTimeout(500);

  const box = await page.locator('.dashboard-bar-fill').last().boundingBox();
  const shot = await page.screenshot({ clip: { x: box.x - 4, y: box.y - 6, width: 120, height: box.height + 12 } });
  const png = PNG.sync.read(shot);

  // 靈氣是青綠：G 明顯大於 R
  const cols = [];
  let firstCol = -1;
  for (let x = 0; x < png.width; x++) {
    let n = 0;
    for (let y = 0; y < png.height; y++) {
      const i = (png.width * y + x) << 2;
      if (png.data[i + 1] - png.data[i] > 25 && png.data[i + 1] > 90) n++;
    }
    if (n > 0 && firstCol < 0) firstCol = x;
    if (firstCol >= 0 && cols.length < 10) cols.push(n);
  }
  const peak = Math.max(...cols, 1);
  // 圓弧 = 第一欄明顯低於峰值（收攏）；一刀切 = 第一欄就接近滿高
  const rounded = cols[0] <= peak * 0.6;
  console.log(`${w.padEnd(9)} [${cols.join(', ').padEnd(38)}] ${rounded ? 'PASS 有圓弧' : 'FAIL 一刀切'}  (首欄 ${cols[0]} / 峰值 ${peak})`);
  rounded ? pass++ : fail++;
  fs.writeFileSync(path.join(root, `qi-w${w.replace('%', '')}.png`), shot);
}

await browser.close();
console.log(`\n${fail === 0 ? '全部通過' : fail + ' 種寬度沒有圓弧'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
