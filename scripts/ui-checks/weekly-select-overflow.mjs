/**
 * 「來源 Sheet」的欄位下拉會不會頂穿卡片。
 *
 * 原生 <select> 不設寬度時會撐到最長的那個 option。這份真實 Sheet 有一欄叫
 * 「熱更新版本 center: AlexTeam-Games/osm-center-hotupdate 2.1.47 client pc: ...」，
 * 兩百多個字元，於是整個控制項頂穿卡片右邊界（2026-08-27 使用者截圖回報）。
 *
 * **量的是實際 boundingBox，不是讀 CSS**——設了 width 不代表沒被別的規則蓋掉，
 * 只有真的畫出來量才算數。
 *
 * 跑法：cd scripts/ui-checks && node weekly-select-overflow.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1050 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('text=週報彙整').first().click().catch(() => {});
await page.waitForTimeout(4000);  // 等預設那份 Sheet 自動讀完表頭

let pass = 0; const fails = [];
const check = (name, cond, extra = '') => cond ? (pass++, console.log(`  ✅ ${name} ${extra}`)) : (fails.push(name), console.log(`  ❌ ${name} ${extra}`));

// 兩個合併開關預設要是勾起來的
const merged = await page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('input[type=checkbox]')) {
    const t = el.closest('label')?.innerText ?? '';
    if (t.includes('P7-005-OSM')) out.osm = el.checked;
    if (t.includes('標籤歸集')) out.tags = el.checked;
  }
  return out;
});
console.log('\n── 合併開關預設 ──');
check('P7-005-OSM 每人合併預設勾起', merged.osm === true, `（實際 ${merged.osm}）`);
check('Jira 標籤歸集預設勾起', merged.tags === true, `（實際 ${merged.tags}）`);

console.log('\n── 下拉有沒有頂穿卡片 ──');
const overflow = await page.evaluate(() => {
  const results = [];
  for (const sel of document.querySelectorAll('select')) {
    // 找出這個 select 所在的卡片（有邊框的那層）
    let card = sel.parentElement;
    while (card && !(getComputedStyle(card).borderRightWidth !== '0px' && card.clientWidth > 400)) card = card.parentElement;
    if (!card) continue;
    const s = sel.getBoundingClientRect(), c = card.getBoundingClientRect();
    results.push({
      label: (sel.previousElementSibling?.textContent ?? sel.parentElement?.textContent ?? '').trim().slice(0, 14),
      width: Math.round(s.width),
      overflowPx: Math.round(s.right - c.right),
    });
  }
  return results;
});
for (const o of overflow) {
  check(`「${o.label}」沒有超出卡片`, o.overflowPx <= 0, `寬 ${o.width}px，右緣超出 ${o.overflowPx}px`);
}

// 頁面本身不該橫向捲動
const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('\n── 頁面橫向捲動 ──');
check('頁面沒有橫向捲軸', bodyOverflow <= 0, `（超出 ${bodyOverflow}px）`);

console.log(`\n通過 ${pass} 項`);
if (fails.length) { console.log('失敗：' + fails.join('、')); await browser.close(); process.exit(1) }
await browser.close();
