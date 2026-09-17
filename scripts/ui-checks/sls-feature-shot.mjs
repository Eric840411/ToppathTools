/**
 * SLS 功能的實際渲染截圖（對帳台的 SLS 區塊 + DC 控制工具的開關）。
 *
 * ⚠️ 版面一律要看**實際渲染**，型別過不代表 JSX 結構是對的
 *    （這個 repo 已經有過「型別通過但版面壞掉」的紀錄）。
 *
 * 跑法：node scripts/ui-checks/sls-feature-shot.mjs
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
try {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1200 } });
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();

  // ⚠️ 這個 app 沒有 URL 路由，頁面是純 React state——一定要先點群組再點子項。
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.locator('text=OSM Tools').first().click().catch(() => {});
  await page.waitForTimeout(1200);

  // ── ① 對帳台的 SLS 區塊 ───────────────────────────────────────────
  for (const t of ['AutoSpin', '傀儡監院']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1800); break }
  }
  const tab = page.locator('button', { hasText: '對帳台' }).first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(4000) }

  // ⚠️ 機台總覽依帳號隔離，不切跨使用者檢視會量到「這區不見了」——那是隔離正常，不是壞掉
  const allBtn = page.locator('button', { hasText: '只顯示自己' }).first();
  if (await allBtn.count()) { await allBtn.click(); await page.waitForTimeout(4500) }

  const block = page.locator('text=SLS 服務健康').first();
  const found = await block.count();
  console.log(`對帳台 SLS 區塊：${found ? '✅ 有渲染' : '❌ 找不到'}`);
  if (found) {
    await block.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    // 連同上下文一起拍，看得出它在對帳台的哪個位置
    const box = await block.boundingBox();
    if (box) {
      await page.screenshot({
        path: 'sls-shot-1-ledger.png',
        clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 60), width: 1100, height: 320 },
      });
    }
    const txt = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(d => d.innerText?.startsWith('SLS 服務健康'));
      return el ? el.innerText.replace(/\s+\n/g, '\n').slice(0, 500) : '';
    });
    console.log('--- 區塊內容 ---');
    console.log(txt);
  }
  await page.screenshot({ path: 'sls-shot-1-ledger-full.png', fullPage: false });

  // ── ② DC 控制工具的 SLS 開關 ──────────────────────────────────────
  await page.locator('text=OSM Tools').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  for (const t of ['Discord 通知', 'Discord通知', '通知設定']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(2500); break }
  }
  const toggle = page.locator('text=SLS 服務健康（G2S／MML）').first();
  const found2 = await toggle.count();
  console.log(`\nDC 控制工具 SLS 開關：${found2 ? '✅ 有渲染' : '❌ 找不到'}`);
  if (found2) {
    await toggle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const box = await toggle.boundingBox();
    if (box) {
      await page.screenshot({
        path: 'sls-shot-2-settings.png',
        clip: { x: Math.max(0, box.x - 340), y: Math.max(0, box.y - 190), width: 1000, height: 330 },
      });
    }
  }
  await page.screenshot({ path: 'sls-shot-2-settings-full.png', fullPage: false });
  console.log('\n截圖：sls-shot-1-ledger.png / sls-shot-2-settings.png（＋兩張 -full）');
} finally {
  // ⚠️ 一次性 Playwright 腳本一定要 close，否則留下孤兒視窗
  await browser.close();
}
