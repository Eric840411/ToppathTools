/**
 * 對帳補回填：查詢結果「不完整」與「無法確認」都不能被當成完整送出。
 *
 * 背景：`/rest/api/3/search/jql` 伺服器端硬上限 100，且回應沒有 `total` 欄位，
 * 只有 `nextPageToken` + `isLast`。原本兩個都沒讀，實測 231 筆只看到 100
 * （漏 57%），畫面卻寫「找到 100 筆配對」——而這支工具正是拿來補回遺失單號的，
 * 漏掉的列會一直空白沒人發現。
 *
 * ⚠️ 這支要守的是**三態**，不是布林：
 *      yes     → 完整，正常送
 *      no      → 明確不完整（命中上限），紅色橫幅 + 危險確認
 *      unknown → 舊版後端沒回報，**也要擋**
 *    第一版我把 unknown 做成 `null`、判斷全寫成 `info && !info.complete`，
 *    結果 unknown 的橫幅跟確認全部被跳過＝靜默放行。那是同一種壞法換個地方發生
 *    （CodeX review：條件要涵蓋 `!== 'yes'` 不是只看 `=== 'no'`）。
 *
 * 全程 route 攔截，不打真的 Jira、不碰 Lark、不寫任何資料。
 *
 * 跑法：node scripts/ui-checks/jira-reconcile-completeness.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const matches = Array.from({ length: 5 }, (_, i) => ({
  rowIndex: i + 2, sheetSummary: `[OSM][TCJL]Fortune-${289 + i}`,
  jiraKey: `DSFT-${8201 + i}`, jiraSummary: `[OSM][TCJL]Fortune-${289 + i}`,
  jiraCreated: '2026-09-03T13:55:06.460+0800', confidence: 'high',
}));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

/** 目前這一輪要讓 preview 回什麼 */
let previewBody = null;
await page.route('**/api/jira/reconcile/preview', r => r.fulfill({ json: previewBody }));
// ⚠️ apply 一定要攔掉。它是**真的會寫進 Lark Sheet** 的那一支，
//    這輪測的是「按下去之前擋不擋得住」，不需要也不可以真的送出去。
let applyCalls = 0;
await page.route('**/api/jira/reconcile/apply', r => { applyCalls++; return r.fulfill({ json: { ok: true, succeeded: 0, failed: 0 } }) });

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
// 這個 app 沒有 URL 路由，頁面是純 React state——要先點群組再點子項
for (const t of ['Jira 批量開單', 'Jira']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1500); break }
}
// ⚠️ 兩層：先開「補回填工具」這個面板，裡面才有「對帳補回填」。
//    直接找「對帳補回填」會命中一個還沒 render 出來的隱藏節點然後 click 逾時
//    ——第一版就是這樣卡住的（跟 UAT 那次「要先點群組再點子項」同一種）。
const panelBtn = page.locator('button', { hasText: '補回填工具' }).first();
if (!await panelBtn.count()) { console.log('找不到「補回填工具」按鈕，可能不在 Jira 頁'); await browser.close(); process.exit(1) }
await panelBtn.click();
await page.waitForTimeout(700);
const openBtn = page.locator('button:visible', { hasText: '對帳補回填' }).first();
await openBtn.click();
await page.waitForTimeout(600);

/** 常駐的對話框 handler：記下訊息、一律取消（測的是「擋不擋得住」，不是真的送出）。 */
let lastDialog = null;
page.on('dialog', async d => { lastDialog = d.message(); await d.dismiss().catch(() => {}) });

async function runCase(label, body) {
  previewBody = body;
  await page.locator('input[placeholder], input').first().waitFor({ timeout: 5000 }).catch(() => {});
  // 填必填欄位（值不重要，preview 已被攔截）
  const inputs = page.locator('input[type="text"], input:not([type])');
  await inputs.nth(0).fill('DSFT').catch(() => {});
  await inputs.nth(1).fill('https://example.larksuite.com/wiki/X?sheet=1').catch(() => {});
  await page.locator('button', { hasText: '查詢比對' }).first().click();
  await page.waitForTimeout(900);

  const ui = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      紅橫幅: txt.includes('結果不完整'),
      黃橫幅: txt.includes('無法確認結果是否完整'),
      讀取範圍不明: txt.includes('讀取範圍不明'),
      有筆數頁數: /本次從 Jira 讀取 \d+ 筆／\d+ 頁/.test(txt),
    };
  });

  // 按補回填，看有沒有跳確認
  // ⚠️ 用「一個常駐 handler + 每輪清空」，不要每輪 page.once()。
  //    once 在**沒有跳對話框那一輪**不會被消耗掉，下一輪會有兩個 handler 同時觸發，
  //    第二個 dismiss 直接拋 "Cannot dismiss dialog which is already handled"。
  lastDialog = null;
  const before = applyCalls;
  await page.locator('button', { hasText: '補回填選取' }).first().click();
  await page.waitForTimeout(700);
  return { label, ui, confirmText: lastDialog, applyFired: applyCalls > before };
}

console.log('\n1) isComplete: true —— 完整，正常放行');
{
  const r = await runCase('yes', { ok: true, matches, unmatchedJiraIssues: [], unmatchedSheetRows: [], jiraFetched: 231, pageCount: 3, reachedLimit: false, limitReason: null, isComplete: true });
  check('沒有紅色橫幅', !r.ui.紅橫幅);
  check('沒有黃色橫幅', !r.ui.黃橫幅);
  check('有顯示讀取筆數／頁數', r.ui.有筆數頁數);
  check('不跳確認', r.confirmText === null);
  check('補回填有真的送出', r.applyFired);
}

console.log('\n2) isComplete: false —— 明確不完整，要擋');
{
  const r = await runCase('no', { ok: true, matches, unmatchedJiraIssues: [], unmatchedSheetRows: [], jiraFetched: 2000, pageCount: 20, reachedLimit: true, limitReason: 'maxIssues', isComplete: false });
  check('有紅色橫幅', r.ui.紅橫幅);
  check('跳出確認', r.confirmText !== null);
  check('確認文字講明會補到一部分', /只會補到其中一部分/.test(r.confirmText ?? ''));
  check('確認文字講明剩下的不會有提示', /不會有任何提示/.test(r.confirmText ?? ''));
  check('按取消就不會送出', !r.applyFired);
}

console.log('\n3) 舊版後端（沒有這些欄位）—— 不確定，也要擋');
// ⚠️ 這是原始 bug 還活著的那條路：舊 server 的查詢其實在第 100 筆就被截斷。
//    這裡若放行，等於在最需要警告的情境下完全沒有防護。
{
  const r = await runCase('unknown', { ok: true, matches, unmatchedJiraIssues: [], unmatchedSheetRows: [] });
  check('有黃色橫幅', r.ui.黃橫幅);
  check('沒有誤用紅色（兩者嚴重度不同）', !r.ui.紅橫幅);
  check('標題不顯示看起來很完整的筆數', !r.ui.有筆數頁數);
  check('標題明講讀取範圍不明', r.ui.讀取範圍不明);
  check('跳出確認（條件是 !== yes 不是 === no）', r.confirmText !== null);
  check('確認文字講明是「無法確認」不是「不完整」', /無法確認/.test(r.confirmText ?? ''));
  check('按取消就不會送出', !r.applyFired);
}

await page.screenshot({ path: path.join(root, 'reconcile-completeness.png') });
console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
await browser.close();
process.exit(fail ? 1 : 0);
