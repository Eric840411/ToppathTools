/**
 * 掃各頁，檢查這輪修仙版改動有沒有波及到 Dashboard 以外的地方。
 *
 * 為什麼要掃：這輪加的規則不是每一條都只影響 Dashboard——
 *   全站生效：`.main-content th`（襯線＋字級）、`h1/h2/h3`（襯線＋字距）、
 *             `button/input/select/textarea { font-family: inherit }`
 *   跨頁生效：`.dashboard-chip, .osm-badge, .cr-pill`（印章樣式）、
 *             `.scripted-bet-metric-value, .local-agent-metric-value`（金色數字）
 * 只有靈氣進度條（.dashboard-bar-*）是 Dashboard 專屬。
 *
 * 改字體與字距最容易造成的災情是**文字被容器切掉**或**整頁橫向捲動**，
 * 兩者都不會報錯，只能量。
 *
 * ⚠️ 這個 app 沒有 URL 路由，必須先點群組才點得到子項。
 *
 * 跑法：node scripts/ui-checks/xianxia-crosspage-sweep.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

/** [群組, 子項]；子項是 null 代表群組自己就是一頁 */
const PAGES = [
  ['天機總覽', null],
  ['卷宗管理', null],
  ['試煉手札', null],
  ['行跡呈報', null],
  ['OSM Tools', '靈脈校準'],
  ['OSM Tools', '傀儡監院'],
  ['OSM Tools', '傀儡演武'],
  ['OSM Tools', '總綱試煉'],
  ['傀儡召喚', null],
  ['行跡天錄', null],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const probe = () => page.evaluate(() => {
  const main = document.querySelector('.main-content') ?? document.body;
  // 1) 整頁橫向捲動
  const hScroll = Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // 2) 文字被容器切掉（只看有文字、不是刻意 ellipsis 的元素）
  const clipped = [];
  for (const el of main.querySelectorAll('h1,h2,h3,h4,th,button,label,strong,b')) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden') continue;  // 刻意截斷的不算
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      clipped.push({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 24), over: el.scrollWidth - el.clientWidth });
    }
  }
  // 3) 表頭有沒有真的套到襯線（確認規則有生效，不是根本沒套）
  const th = main.querySelector('th');
  return {
    hScroll,
    clipped: clipped.slice(0, 5),
    clippedCount: clipped.length,
    thFont: th ? getComputedStyle(th).fontFamily.split(',')[0].replace(/"/g, '') : null,
  };
});

console.log(`${'頁面'.padEnd(22)}${'橫捲'.padStart(6)}${'被切元素'.padStart(10)}   表頭字體`);
console.log('-'.repeat(70));
let bad = 0;
for (const [group, sub] of PAGES) {
  const g = page.locator(`text=${group}`).first();
  if (!await g.count()) { console.log(`${(group + (sub ? ' / ' + sub : '')).padEnd(20)}  （找不到入口，跳過）`); continue }
  await g.click().catch(() => {});
  await page.waitForTimeout(sub ? 700 : 1800);
  if (sub) {
    const s = page.locator(`text=${sub}`).first();
    if (!await s.count()) { console.log(`${(group + ' / ' + sub).padEnd(20)}  （找不到子項，跳過）`); continue }
    await s.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  const r = await probe();
  const name = group + (sub ? ' / ' + sub : '');
  const ok = r.hScroll <= 1 && r.clippedCount === 0;
  if (!ok) bad++;
  console.log(
    `${name.padEnd(20)}${String(r.hScroll).padStart(6)}${String(r.clippedCount).padStart(10)}   ${r.thFont ?? '（無表格）'}` +
    (ok ? '' : '   ❌'),
  );
  for (const c of r.clipped) console.log(`      切到：<${c.tag}> 「${c.text}」超出 ${c.over}px`);
}

console.log('');
console.log(bad ? `❌ ${bad} 頁有問題` : '✅ 掃過的頁面都沒有橫向捲動、也沒有文字被切');
await browser.close();
process.exit(bad ? 1 : 0);
