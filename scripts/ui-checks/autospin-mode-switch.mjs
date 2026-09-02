/**
 * 切「遠端 Agent ↔ 伺服器端」時，版面必須保留。
 *
 * ⚠️ 這條是被回報兩次才定案的：
 *    ① v4.98.3 我把切換鈕移進只在 hub 分支渲染的卡裡 → 切到 server 就**回不去了**
 *    ② v4.98.4 修好切換鈕，但整個左半邊仍然換成另一組版面
 *       → 使用者：「切換到伺服器端，其他功能的介面不能保留嗎? 可以做成反灰的」
 *
 *    兩次都不會拋錯、build 也乾淨——只有真的切一次才看得見。所以要有這支。
 *
 * 跑法：node scripts/ui-checks/autospin-mode-switch.mjs
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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1080 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// 給一台 agent，否則卡一是空清單、看不出有沒有反灰
await page.route('**/api/autospin/hub-agents*', r => r.fulfill({ json: {
  ok: true,
  agents: [{ agentId: 'a1', hostname: 'MacBook-Pro-2.local', ownerName: 'Eric Wu', capabilities: ['autospin'], busy: false, sessionId: null, connectedAt: Date.now(), lastSeenAt: Date.now(), updateStatus: 'current' }],
} }));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.locator('text=OSM Tools').first().click().catch(() => {});
await page.waitForTimeout(1000);
for (const t of ['AutoSpin', '傀儡監院']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1500); break }
}
const runTab = page.locator('button', { hasText: '執行監控' }).first();
if (await runTab.count()) { await runTab.click(); await page.waitForTimeout(1500) }

const snapshot = () => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.autospin-run-cards > section')];
  // ⚠️ 不要用 closest('[style*=opacity]')——closest() 包含自己，而 agent 卡本身的
  //    inline style 就有 opacity（busy 時 0.6），會永遠抓到卡片自己而不是反灰的外層。
  //    第一版就是這樣誤報 FAIL 的。改成找明確的 class。
  const picker = document.querySelector('.autospin-pane-off');
  return {
    卡片數: cards.length,
    卡片標題: cards.map(c => (c.firstElementChild?.textContent || '').trim().slice(0, 20)),
    有切換鈕: !!document.querySelector('.autospin-mode-toggle, [data-mode-toggle]')
      || [...document.querySelectorAll('button')].some(b => /遠端 Agent|伺服器端/.test(b.textContent || '')),
    反灰面板數: document.querySelectorAll('.autospin-pane-off').length,
    agent選擇已反灰: !!picker && getComputedStyle(picker).opacity !== '1'
      && getComputedStyle(picker).pointerEvents === 'none',
    有日誌面板: !!document.querySelector('.autospin-log-panel'),
    頁面橫捲: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  };
});

const before = await snapshot();
console.log('\n1) 遠端 Agent 模式（基準）');
check('三張卡都在', before.卡片數 === 3, JSON.stringify(before.卡片標題));
check('切換鈕在', before.有切換鈕);
check('agent 選擇沒有反灰', !before.agent選擇已反灰);
check('日誌面板在', before.有日誌面板);
check('沒有橫向捲動', !before.頁面橫捲);

// 切到伺服器端
await page.locator('button', { hasText: '伺服器端' }).first().click();
await page.waitForTimeout(700);
const after = await snapshot();
console.log('\n2) 切到伺服器端——版面要保留，不是換一套');
check('三張卡還在（不是被換掉）', after.卡片數 === 3, JSON.stringify(after.卡片標題));
check('卡片標題完全沒變', JSON.stringify(after.卡片標題) === JSON.stringify(before.卡片標題));
check('切換鈕還在（能切回去）', after.有切換鈕);
check('agent 選擇變成反灰（不是消失）', after.agent選擇已反灰);
check('日誌面板還在', after.有日誌面板);
check('沒有橫向捲動', !after.頁面橫捲);

// 切回去
await page.locator('button', { hasText: '遠端 Agent' }).first().click();
await page.waitForTimeout(700);
const back = await snapshot();
console.log('\n3) 切回遠端 Agent——要完全還原');
check('三張卡還在', back.卡片數 === 3);
check('agent 選擇恢復可用', !back.agent選擇已反灰);
check('跟一開始一模一樣', JSON.stringify(back.卡片標題) === JSON.stringify(before.卡片標題));

await page.screenshot({ path: path.join(root, 'autospin-mode-switch.png') });
console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）  截圖：autospin-mode-switch.png`);
await browser.close();
process.exit(fail ? 1 : 0);
