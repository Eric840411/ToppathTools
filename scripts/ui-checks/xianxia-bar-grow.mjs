/**
 * 驗證進度條「每次進到 Dashboard 都從 0 長出來」。
 *
 * 為什麼要量而不是用看的：首次渲染沒有「前一個寬度」可以比對，
 * CSS transition 會直接跳到終點，**畫面上看起來就是本來就在那裡**——
 * 沒有動畫跟動畫很快是分不出來的。只有連續取樣寬度才知道它真的有長。
 *
 * 跑法：cd scripts/ui-checks && node xianxia-bar-grow.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));

// 重新載入後立刻開始取樣——晚一點就錯過起跑了
await page.reload({ waitUntil: 'domcontentloaded' });

const samples = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  // 等第一根進度條出現（資料是非同步載入的）
  for (let i = 0; i < 200; i++) {
    if (document.querySelector('.dashboard-bar-fill')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const start = performance.now();
  for (let i = 0; i < 26; i++) {
    const el = document.querySelector('.dashboard-bar-fill');
    out.push({
      t: Math.round(performance.now() - start),
      w: el ? +getComputedStyle(el).width.replace('px', '') : -1,
    });
    await new Promise(r => setTimeout(r, 60));
  }
  return { out, waited: Math.round(start - t0) };
});

console.log(`等待資料載入 ${samples.waited}ms，之後每 60ms 取樣一次：\n`);
const ws = samples.out.map(s => s.w);
const max = Math.max(...ws);
for (const s of samples.out) {
  const bar = '#'.repeat(Math.round((s.w / Math.max(max, 1)) * 46));
  console.log(`  t=${String(s.t).padStart(4)}ms  ${String(Math.round(s.w)).padStart(5)}px  ${bar}`);
}

const first = ws.find(w => w >= 0);
const grew = max - first;
console.log('');
console.log(`起始寬度 ${Math.round(first)}px → 最大 ${Math.round(max)}px，成長 ${Math.round(grew)}px`);
console.log(grew > 5
  ? '✅ 真的有從 0 長出來（起始接近 0，之後才展開）'
  : '❌ 沒有動畫——一開始就在終點，transition 沒有被觸發');

await browser.close();
