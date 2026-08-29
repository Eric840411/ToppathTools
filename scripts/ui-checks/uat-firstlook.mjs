/**
 * 「新手第一次打開 UAT 頁，看得懂嗎」的客觀量測。
 *
 * 不是憑印象講好不好用——量幾個具體的東西：畫面上有多少字、多少顆按鈕、
 * 出現了幾個沒解釋就用的專有名詞、有沒有任何一句話告訴人「第一步做什麼」。
 *
 * 跑法：cd scripts/ui-checks && node uat-firstlook.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'classic'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 沒有 URL 路由，先點群組再點子項
const l1 = page.locator('text=OSM Tools').first();
if (await l1.count()) { await l1.click().catch(() => {}); await page.waitForTimeout(700) }
const l2 = page.locator('text=UAT 整合測試').first();
if (await l2.count()) { await l2.click().catch(() => {}); await page.waitForTimeout(2500) }

await page.screenshot({ path: 'uat-firstlook.png' });

const m0 = await page.evaluate(() => {
  const root = document.querySelector('.main-content');
  const txt = root?.innerText ?? '';
  const jargon = ['積木', '模組', '子類型', 'TC', '派工', 'Agent', '錄製', '驗證器', '斷言', 'builtin'];
  return {
    畫面字數: txt.length,
    可點的控制項: root ? root.querySelectorAll('button, select, input, [role=button]').length : 0,
    // 有沒有任何一句在教人怎麼開始
    有沒有起手說明: /第一步|先選|先設定|使用方式|怎麼用|如何開始/.test(txt),
    沒解釋就用的專有名詞: jargon.filter(w => txt.includes(w)),
    畫面開頭文字: txt.replace(/\n+/g, ' ／ ').slice(0, 300),
  };
});

console.log(JSON.stringify(m0, null, 1));

const prim = await page.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('.main-content button')) {
    const t=(b.innerText||'').trim();
    if (!/執行|開始|啟動|跑/.test(t)) continue;
    const r=b.getBoundingClientRect();
    out.push({ 文字:t.slice(0,20), y:Math.round(r.top), 在第一屏內: r.top>=0 && r.top<window.innerHeight });
  }
  return out;
});
console.log('主要動作按鈕：', JSON.stringify(prim));
console.log('視窗高度 1000');
await browser.close();
