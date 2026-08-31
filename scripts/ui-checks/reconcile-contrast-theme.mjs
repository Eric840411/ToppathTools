/**
 * 後台對帳：對比度 + 普通版/修仙版差異。
 *
 * 使用者 2026-08-31 回報兩件事：「沒有按照普通版和修仙版做差異」「字也太淺色」。
 *
 * ⚠️ 這裡**一定要用合成資料**：真實查詢回來的 34 筆全是 BACKEND_ONLY 一種狀態，
 *    看不出「相符」（綠）跟「掉單」（紅）這兩個 badge 在深底上讀不讀得到，
 *    也看不到「後台異常」那塊——而那塊原本是 #92400e 深褐字配深底，
 *    正是最嚴重的那一處。只驗真實資料等於漏掉一半。
 *
 * 對比度用 WCAG 演算法實算，不靠肉眼看截圖：rgba 背景要沿父層往上疊到不透明為止，
 * 否則量到的是「半透明色本身」而不是使用者真正看到的合成結果。
 *
 * 跑法：node scripts/ui-checks/reconcile-contrast-theme.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

/** 四種狀態都要有，才驗得到每個 badge 的可讀性 */
const RUN_PAYLOAD = {
  ok: true, reportId: 1,
  summary: '前端 40 筆 / 後台 42 筆 / 匹配 38 / 掉單 2 / 僅後台有 4 / 異常 1',
  matched: 38, unmatched: 2, backendOnly: 4, anomalies: 1,
  notice: '',
  backendAnomalies: [{ uid: '873-BULLBLITZ-0136', time: '2026-08-30 00:35:46', bet: 1250, win: 114000, note: '大獎：win/bet = 91.2x' }],
  details: [
    { status: 'MATCH', uid: '873-DFDC-0003', time: '2026-08-30 11:50:36', bet: 8, win: 0, note: '' },
    { status: 'MISSING', uid: '873-DFDC-0003', time: '2026-08-30 11:50:41', bet: 8, win: 16, note: '後台查無此局' },
    { status: 'BACKEND_ONLY', uid: '873-BULLBLITZ-0136', time: '2026-08-30 00:49:30', bet: 1250, win: 300, note: '局號 873-BULLBLITZ-0136|6A930D96040' },
  ],
};
const REPORTS_PAYLOAD = {
  ok: true, reports: [
    { id: 2, runAt: Date.now() - 3600e3, rangeStart: '2026-08-30 00:00:00', rangeEnd: '2026-08-30 23:59:59', machineType: '', frontCount: 40, backendCount: 42, matchedCount: 38, unmatchedCount: 2, anomalyCount: 1 },
    { id: 1, runAt: Date.now() - 86400e3, rangeStart: '2026-08-29 00:00:00', rangeEnd: '2026-08-29 23:59:59', machineType: 'JJBXGRAND', frontCount: 12, backendCount: 12, matchedCount: 12, unmatchedCount: 0, anomalyCount: 0 },
  ],
};

/** WCAG 相對亮度 */
const lum = ([r, g, b]) => {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) };

const browser = await chromium.launch();
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const seen = {};

for (const mode of ['classic', 'xianxia']) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.route('**/api/autospin/reconcile/run', r => r.fulfill({ json: RUN_PAYLOAD }));
  await page.route('**/api/autospin/reconcile/reports*', r => r.fulfill({ json: REPORTS_PAYLOAD }));

  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 這個 app 沒有 URL 路由：一定要先點群組展開，子項才會 render
  for (const t of ['OSM Tools']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1200) }
  }
  for (const t of ['AutoSpin', '傀儡監院']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1600); break }
  }
  const rcTab = page.locator('button', { hasText: /^後台對帳$/ }).first();
  if (!await rcTab.count()) { console.log(`[${mode}] 找不到「後台對帳」分頁`); continue }
  await rcTab.click(); await page.waitForTimeout(900);

  const runBtn = page.locator('button', { hasText: /執行對帳|起帳勘校/ }).first();
  await runBtn.click(); await page.waitForTimeout(1400);

  console.log(`\n【${mode === 'classic' ? '普通版' : '修仙版'}】`);

  // ── 對比度實測：沿父層疊背景直到不透明 ──
  const probes = await page.evaluate(() => {
    const parse = s => (s.match(/[\d.]+/g) || []).map(Number);
    const flatten = el => {
      let acc = null;
      for (let n = el; n; n = n.parentElement) {
        const p = parse(getComputedStyle(n).backgroundColor);
        if (p.length < 3) continue;
        const a = p.length > 3 ? p[3] : 1;
        if (a === 0) continue;
        const c = [p[0], p[1], p[2]];
        acc = acc === null ? (a === 1 ? c : c.map((v, i) => v * a)) : acc;
        if (a === 1) return acc.map((v, i) => Math.round(v));
        // 半透明：跟上層繼續合成
        const up = (() => { for (let m = n.parentElement; m; m = m.parentElement) {
          const q = parse(getComputedStyle(m).backgroundColor);
          if (q.length >= 3 && (q.length < 4 || q[3] === 1)) return [q[0], q[1], q[2]];
        } return [15, 23, 42] })();
        return c.map((v, i) => Math.round(v * a + up[i] * (1 - a)));
      }
      return [15, 23, 42];
    };
    const grab = (sel, label) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { label, text: (el.textContent || '').trim().slice(0, 40),
               fg: parse(cs.color).slice(0, 3), bg: flatten(el),
               font: cs.fontFamily.split(',')[0].replace(/"/g, ''), color: cs.color };
    };
    const byText = (re, root = document) => [...root.querySelectorAll('div,span,th,td')]
      .filter(e => re.test((e.textContent || '').trim()) && e.children.length === 0 || (re.test((e.textContent||'').trim()) && e.childElementCount <= 1))
      .pop();
    const out = [];
    const sum = [...document.querySelectorAll('div')].find(d => /^前端 \d+ 筆 \/ 後台/.test((d.textContent || '').trim()));
    if (sum) out.push(grab(sum, '摘要列'));
    const anom = [...document.querySelectorAll('div')].find(d => /^大獎：win\/bet/.test((d.textContent || '').trim()));
    if (anom) out.push(grab(anom, '異常明細'));
    for (const [lbl, re] of [['相符 badge', /^相符$/], ['掉單 badge', /^掉單$/], ['僅後台有 badge', /^僅後台有$/]]) {
      const el = [...document.querySelectorAll('span')].find(e => re.test((e.textContent || '').trim()));
      if (el) out.push(grab(el, lbl));
    }
    const th = [...document.querySelectorAll('th')].find(e => /狀態/.test(e.textContent || ''));
    if (th) out.push({ ...grab(th, '表頭'), border: getComputedStyle(th).borderBottomColor });
    const title = [...document.querySelectorAll('div')].find(d => /^(對帳結果|◈ 勘帳結果)$/.test((d.textContent || '').trim()));
    if (title) out.push(grab(title, '面板標題'));
    return out.filter(Boolean);
  });

  for (const p of probes) {
    const r = ratio(p.fg, p.bg);
    // 3.0 是 WCAG 對大字/UI 元件的下限；本頁多是 11~12px 小字，所以用 4.5 當標準
    const min = /badge|標題|表頭/.test(p.label) ? 3.0 : 4.5;
    check(`${p.label} 對比 ${r.toFixed(2)}:1`, r >= min, `(門檻 ${min}) fg=${p.color} bg=rgb(${p.bg})`);
    if (p.border) console.log(`        表頭底線：${p.border}`);
    if (p.label === '面板標題') seen[mode] = { text: p.text, font: p.font, color: p.color };
  }

  const shot = path.join(root, `rc-theme-${mode}.png`);
  const panel = page.locator('div').filter({ hasText: /^前端 \d+ 筆 \/ 後台/ }).first();
  await page.screenshot({ path: shot, clip: await (async () => {
    const b = await panel.boundingBox().catch(() => null);
    return b ? { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 120), width: Math.min(1500, b.width + 48), height: 700 } : undefined;
  })() });
  console.log(`  截圖：${shot}`);
  await ctx.close();
}

console.log('\n【兩版差異】');
if (seen.classic && seen.xianxia) {
  check('面板標題文字不同', seen.classic.text !== seen.xianxia.text, `「${seen.classic.text}」 vs 「${seen.xianxia.text}」`);
  check('面板標題字體不同', seen.classic.font !== seen.xianxia.font, `${seen.classic.font} vs ${seen.xianxia.font}`);
  check('面板標題顏色不同', seen.classic.color !== seen.xianxia.color, `${seen.classic.color} vs ${seen.xianxia.color}`);
} else check('兩版都取到標題', false, JSON.stringify(seen));

await browser.close();
console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
