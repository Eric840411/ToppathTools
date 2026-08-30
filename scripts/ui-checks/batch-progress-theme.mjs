/**
 * 驗證批量工具的進度條在修仙版下真的被改色。
 *
 * 為什麼不直接去頁面上看：那幾條只有**真的在跑批次時**才會出現，
 * 而跑一次就會建立真的 Jira 單／送出真的評論。不能為了截圖去動正式資料。
 *
 * 所以改成注入一個**跟原始碼一模一樣的結構**（同樣的 class、同樣的行內樣式），
 * 驗證 CSS 規則有沒有匹配到、以及有沒有蓋過行內樣式。
 *
 * ⚠️ 這裡的重點是「蓋不蓋得過」：行內樣式的優先權高於 class，
 *    沒有 !important 的話規則會靜默失效——而且因為進度條平常看不到，
 *    這種失效可以很久都沒人發現。
 *
 * 跑法：node scripts/ui-checks/batch-progress-theme.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

async function probe(mode) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    // 跟 JiraBatchCommentStep3.tsx 等 5 個檔案裡完全一樣的結構與行內樣式
    const track = document.createElement('div');
    track.className = 'batch-progress-track';
    Object.assign(track.style, { height: '6px', borderRadius: '3px', background: '#1e2d3d', overflow: 'hidden' });
    const fill = document.createElement('div');
    fill.className = 'batch-progress-fill';
    Object.assign(fill.style, { height: '100%', borderRadius: '3px', background: '#3b82f6', width: '60%' });
    track.appendChild(fill);
    document.body.appendChild(track);
    const t = getComputedStyle(track), f = getComputedStyle(fill);
    const out = { trackBg: t.backgroundColor, trackRadius: t.borderRadius, fillBg: f.backgroundImage, fillColor: f.backgroundColor };
    track.remove();
    return out;
  });
}

console.log('修仙版：規則應該蓋過行內樣式');
const xx = await probe('xianxia');
console.log('   ', JSON.stringify(xx));
check('fill 變成青玉漸層（不再是純藍）', xx.fillBg.includes('gradient'), xx.fillBg.slice(0, 46));
check('fill 不再是行內的 #3b82f6', xx.fillColor !== 'rgb(59, 130, 246)', xx.fillColor);
check('track 不再是行內的 #1e2d3d', xx.trackBg !== 'rgb(30, 45, 61)', xx.trackBg);
check('圓角變成膠囊', parseFloat(xx.trackRadius) > 10, xx.trackRadius);

console.log('\n普通版：不該被動到（行內的藍色要原樣保留）');
const cl = await probe('classic');
console.log('   ', JSON.stringify(cl));
check('fill 仍是行內的 #3b82f6', cl.fillColor === 'rgb(59, 130, 246)', cl.fillColor);
check('track 仍是行內的 #1e2d3d', cl.trackBg === 'rgb(30, 45, 61)', cl.trackBg);
check('沒有被加上漸層', !cl.fillBg.includes('gradient'), cl.fillBg);

console.log(`\n${pass} 通過 / ${fail} 失敗`);
await browser.close();
process.exit(fail ? 1 : 0);
