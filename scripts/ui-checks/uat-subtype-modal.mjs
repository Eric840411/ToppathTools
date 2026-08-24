/**
 * UAT 子類型複選彈框的瀏覽器檢查。
 *
 * ## 導頁一定要先點群組再點子項
 * 這個 app 沒有 URL 路由，頁面是純 React state。直接點「UAT 整合測試」時它還沒被
 * render 出來——我在這上面卡了三次驗證才發現。先點「OSM Tools」展開群組才行。
 *
 * ## 為什麼要量彈框尺寸
 * 這個版面的祖先有 backdrop-filter，會把 position: fixed 困在容器裡。彈框沒用
 * portal 就會被裁掉（積木編輯器與錄製選擇器都踩過）。量到滿版才代表 portal 有效。
 *
 * 跑法：cd scripts/ui-checks && node uat-subtype-modal.mjs
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
const errors = [];
page.on('pageerror', e => errors.push(e.message));

for (const mode of ['classic', 'xianxia']) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  // 每輪先清掉篩選，才驗得到「從沒選到有選」
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('osm_uat_config') ?? '{}');
    raw.filter = '';
    localStorage.setItem('osm_uat_config', JSON.stringify(raw));
  });
  await page.goto('http://localhost:3000/#/osm/uat', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);

  // 沒有 URL 路由，頁面是純 React state——一定要先點群組再點子項，
  // 直接點子項時它根本還沒被 render 出來（前幾次驗證失敗都卡在這）
  for (const t of ['OSM Tools', '玄樞百器']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(900); break }
  }
  for (const t of ['UAT 整合測試', '總網試煉']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(2200); break }
  }
  const studio = await page.locator('.uat-studio').count();
  if (!studio) { console.log(`[${mode}] ❌ 進不到 UAT 頁面，這輪不算通過`); continue }

  const trigger = page.locator('.uat-subtype-trigger').first();
  if (!await trigger.count()) { console.log(`[${mode}] ❌ 找不到子類型按鈕`); continue }
  console.log(`\n[${mode}] 按鈕文字（未選）:`, (await trigger.innerText()).replace(/\s+/g, ' '));

  await trigger.click();
  await page.waitForTimeout(600);
  const rows = page.locator('.uat-subtype-row');
  const n = await rows.count();
  console.log(`  彈框打開，列出 ${n} 個子類型`);
  if (!n) { console.log('  ❌ 一個選項都沒有'); continue }

  // 彈框有沒有被裁掉（這個版面踩過 backdrop-filter 困住 fixed 的坑）
  const modalBox = await page.locator('.uat-tc-modal').first().boundingBox();
  const vw = page.viewportSize();
  console.log(`  彈框尺寸 ${Math.round(modalBox.width)}x${Math.round(modalBox.height)}（視窗 ${vw.width}x${vw.height}）`,
    modalBox.width >= vw.width - 2 ? '→ 沒被裁掉 ✅' : '→ 被裁掉了 ❌');

  const first = await rows.first().innerText();
  await rows.first().click();
  await page.waitForTimeout(400);
  console.log(`  勾選「${first.replace(/\s+/g, ' ').slice(0, 28)}」`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('osm_uat_config') ?? '{}').filter);
  console.log('  寫回的 filter:', JSON.stringify(saved));

  await rows.nth(1).click();
  await page.waitForTimeout(400);
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('osm_uat_config') ?? '{}').filter);
  console.log('  再勾第二個 →', JSON.stringify(saved2), (saved2.split(',').length === 2 ? '複選有效 ✅' : '複選壞了 ❌'));

  // 再點一次應該取消
  await rows.first().click();
  await page.waitForTimeout(400);
  const saved3 = await page.evaluate(() => JSON.parse(localStorage.getItem('osm_uat_config') ?? '{}').filter);
  console.log('  取消第一個 →', JSON.stringify(saved3), (saved3.split(',').length === 1 ? '可取消 ✅' : '取消壞了 ❌'));

  await page.locator('.uat-tc-picker-head .uat-btn').first().click();
  await page.waitForTimeout(400);
  console.log('  關閉後按鈕文字:', (await trigger.innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: `subtype-${mode}.png` });
}

console.log('\nJS 錯誤:', errors.length ? errors.join(' | ') : '(無)');
await browser.close();
