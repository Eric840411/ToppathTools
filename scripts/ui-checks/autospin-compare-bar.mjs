/**
 * 驗執行監控頁上的「三路對帳摘要」列。
 *
 * ⚠️ 本機沒有任何比對資料（0 群組 0 結果），所以**真實狀態下只驗得到「尚無資料」**。
 *    要看有異常時長怎樣，就得攔截 API 餵合成資料——這頁的重點正是
 *    「有異常時要一眼看得出來」，只驗空狀態等於什麼都沒驗。
 *
 * 三種狀態都要驗：尚無資料／全部相符／有異常。
 *
 * 跑法：node scripts/ui-checks/autospin-compare-bar.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const CASES = [
  ['尚無資料', { machines: [], sessionCount: 0 }, ['尚無資料']],
  ['全部相符', {
    machines: [{ sessionId: 's1', machineType: 'RISINGROCKETS', agentLabel: 'a', compared: 12, matched: 12, mismatched: 0, missing: 0 }],
    sessionCount: 1,
  }, ['已比對 12 筆', '全部相符']],
  ['有異常', {
    machines: [
      { sessionId: 's1', machineType: 'RISINGROCKETS', agentLabel: 'a', compared: 12, matched: 11, mismatched: 1, missing: 0 },
      { sessionId: 's1', machineType: 'TRIPLEPOT', agentLabel: 'a', compared: 8, matched: 6, mismatched: 0, missing: 2 },
    ],
    sessionCount: 1,
  }, ['不符 1', '缺資料 2', 'RISINGROCKETS', 'TRIPLEPOT']],
];

const browser = await chromium.launch();
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

for (const [label, payload, expected] of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.route('**/api/autospin/compare/status*', route =>
    route.fulfill({ json: { ok: true, hasBoxLeg: false, groupCount: 1, ...payload } }));

  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  for (const t of ['OSM Tools', '傀儡監院']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1400) }
  }
  // 切到「執行監控」分頁
  const runTab = page.locator('button', { hasText: '執行監控' }).first();
  if (await runTab.count()) { await runTab.click().catch(() => {}); await page.waitForTimeout(2000) }

  console.log(`\n【${label}】`);
  // ⚠️ 不能用文字找：分頁列上也有一顆叫「三路對帳」的按鈕，
  //    第一版就是抓到那顆、讀到整條分頁列的文字，結果七項全紅但其實是測試錯。
  //    改用元件上的 data-testid。
  const txt = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="autospin-compare-bar"]');
    return el ? (el.textContent ?? '') : null;
  });
  if (txt === null) {
    check('找得到摘要列', false, '（頁面上沒有這個區塊）');
  } else {
    check('找得到摘要列', true);
    for (const e of expected) check(`顯示「${e}」`, txt.includes(e), txt.includes(e) ? '' : `實際：${txt.slice(0, 90)}`);
  }
  if (label === '有異常') await page.screenshot({ path: path.join(root, 'autospin-compare-bar.png') });
  await ctx.close();
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
await browser.close();
process.exit(fail ? 1 : 0);
