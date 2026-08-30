/**
 * 修仙版「感覺不夠修仙」——先量，不要憑印象改。
 *
 * 頭號嫌疑：CSS 到處寫 font-family: var(--xx-serif)（"Noto Serif TC"），
 * 但整個專案沒有任何地方載入這個字體（遊戲版的 pixel.css 有 @import Google Fonts，
 * 修仙版沒有）。沒裝的話會一路 fallback 到新細明體。
 *
 * ⚠️ 兩種測法都會給假答案，別用：
 *   - getComputedStyle 照樣回報 "Noto Serif TC"，不管有沒有真的載到
 *   - document.fonts.check() 對本機字體一律回 true（實測連 Songti TC 這種
 *     Windows 上不可能有的都回 true），完全不能拿來判斷
 *
 * 真正可靠的是**寬度比對**：把同一串字分別用「候選字體 + monospace」跟
 * 純 monospace 量寬度，不一樣才代表候選字體真的存在並生效。
 *
 * 跑法：cd scripts/ui-checks && node xianxia-typography.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const report = await page.evaluate(() => {
  /** 寬度比對法：候選字體存在的話，寬度會跟純 fallback 不同 */
  function fontAvailable(name) {
    const probe = '道法自然天機萬象AWMil';
    const cv = document.createElement('canvas').getContext('2d');
    const base = ['monospace', 'serif', 'sans-serif'];
    return base.some(b => {
      cv.font = `48px ${b}`;
      const w0 = cv.measureText(probe).width;
      cv.font = `48px "${name}", ${b}`;
      return Math.abs(cv.measureText(probe).width - w0) > 0.5;
    });
  }

  const probes = ['Noto Serif TC', 'Songti TC', 'PMingLiU', 'Noto Sans TC', 'Microsoft JhengHei', 'Ma Shan Zheng', 'ZCOOL XiaoWei'];
  const available = {};
  for (const f of probes) available[f] = fontAvailable(f);

  // 只統計「真的載到的」字重——全部倒出來會有好幾百行，反而看不到重點
  const loadedWeights = new Set();
  document.fonts.forEach(f => { if (f.status === 'loaded') loadedWeights.add(f.family + ' ' + f.weight) });
  const faces = [...loadedWeights];

  const samples = [];
  for (const sel of ['h1', 'h2', 'h3', '.sidebar-brand', '.page-title', 'button']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    samples.push({
      sel, text: (el.textContent ?? '').trim().slice(0, 20),
      family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, spacing: cs.letterSpacing,
    });
  }

  const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href);
  return { available, faces, samples, links, mode: localStorage.getItem('toppath-theme-mode') };
});

console.log('主題模式：', report.mode);
console.log('\n載入的樣式表：');
report.links.forEach(l => console.log('  ' + l));

console.log('\n這台機器上實際有沒有這個字體（寬度比對法）：');
for (const [f, ok] of Object.entries(report.available)) console.log(`  ${ok ? '✅ 有' : '❌ 沒有'}  ${f}`);

console.log('\n真的載到的 webfont 字重：', report.faces.length ? report.faces.join(' / ') : '（一個都沒有 → 完全沒有 webfont）');

console.log('\n實際套用的字體：');
for (const s of report.samples) {
  console.log(`  ${s.sel.padEnd(14)} ${s.size.padStart(6)} w${s.weight} ls:${s.spacing}`);
  console.log(`  ${''.padEnd(14)} ${s.family}`);
  console.log(`  ${''.padEnd(14)} 「${s.text}」`);
}

await page.screenshot({ path: '../../xianxia-current-dashboard.png' });
console.log('\n截圖：xianxia-current-dashboard.png');
await browser.close();
