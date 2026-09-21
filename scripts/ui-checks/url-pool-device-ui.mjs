/**
 * URL 帳號池的 H5／PC 切換，在**真的畫面上**走一次。
 *
 * 單元測試（`url-pool-device.test.ts`）只證明換算對，證明不了：
 *   - 那一欄有沒有真的渲染出來
 *   - 切了之後畫面上那條 URL 有沒有跟著換（按鈕變了、URL 沒變是最容易發生的）
 *   - 整頁切換會不會清掉單列覆寫
 *
 * 跑法：node scripts/ui-checks/url-pool-device-ui.mjs [port]
 *       預設打 3000（PM2 跑的那份）；驗證未部署的改動時傳 vite 的 port。
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = process.argv[2] || '3000';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.locator('text=OSM Tools').first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.locator('text=URL 帳號池').first().click().catch(() => {});
  await page.waitForTimeout(1500);

  // 第一列的帳號（資料是靜態的，但不要寫死號碼——寫死的話換一批資料就假綠）
  const firstAccount = await page.locator('table tbody tr td:first-child').first().innerText();
  const rowUrl = () => page.locator('table tbody tr').first().locator('td').nth(2).innerText();
  const rowToggle = page.locator(`[data-testid="url-pool-row-device-${firstAccount.trim()}"]`);

  // ── ① 預設 H5 ──────────────────────────────────────────────────────────────
  check('版本欄位有渲染', await page.locator('th', { hasText: '版本' }).count() > 0);
  check('整頁切換鈕在（H5/PC）', await page.locator('[data-testid="url-pool-device-h5"]').count() === 1
    && await page.locator('[data-testid="url-pool-device-pc"]').count() === 1);
  check('每一列都有切換鈕',
    await page.locator('[data-testid^="url-pool-row-device-"]').count()
    === await page.locator('table tbody tr').count());

  const u0 = await rowUrl();
  check('預設顯示 H5', (await rowToggle.innerText()).includes('H5'), `按鈕=${(await rowToggle.innerText()).trim()}`);
  check('預設 URL 是 H5 參數', u0.includes('platform=pc') && u0.includes('device=mobile'));
  await page.screenshot({ path: path.join(root, 'urlpool-device-1-h5.png'), fullPage: false });

  // ── ② 單列切 PC ────────────────────────────────────────────────────────────
  await rowToggle.click();
  await page.waitForTimeout(400);
  const u1 = await rowUrl();
  check('那一列變成 PC', (await rowToggle.innerText()).includes('PC'));
  check('URL 跟著換成 PC 參數', u1.includes('platform=50') && u1.includes('device=pc'),
    u1.slice(0, 120));
  check('token 沒被動到', u1.includes(u0.match(/token=[^&]+/)[0]));
  check('mode=live 還在、沒有 mode=web', u1.includes('mode=live') && !u1.includes('mode=web'));
  check('第二列不受影響（單列覆寫不外溢）',
    (await page.locator('[data-testid^="url-pool-row-device-"]').nth(1).innerText()).includes('H5'));
  await page.screenshot({ path: path.join(root, 'urlpool-device-2-row-pc.png'), fullPage: false });

  // ── ③ 整頁切 PC ────────────────────────────────────────────────────────────
  await page.locator('[data-testid="url-pool-device-pc"]').click();
  await page.waitForTimeout(400);
  const labels = await page.locator('[data-testid^="url-pool-row-device-"]').allInnerTexts();
  check('整頁切 PC 之後每一列都是 PC', labels.every(t => t.includes('PC')), `${labels.length} 列`);
  await page.screenshot({ path: path.join(root, 'urlpool-device-3-all-pc.png'), fullPage: false });

  // ── ④ 切回 H5：單列覆寫要被清掉 ────────────────────────────────────────────
  await page.locator('[data-testid="url-pool-device-h5"]').click();
  await page.waitForTimeout(400);
  const back = await page.locator('[data-testid^="url-pool-row-device-"]').allInnerTexts();
  check('切回 H5 之後沒有殘留的 PC 列', back.every(t => t.includes('H5')));
  check('URL 也回到原始 H5', (await rowUrl()) === u0);

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
}
