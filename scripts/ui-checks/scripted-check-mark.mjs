/**
 * 腳本化投注表格的勾選框——勾勾有沒有落在方框裡、位置對不對。
 *
 * 使用者在 DevTools 調好數值後指定（2026-08-27）。**視覺調整一定要真的畫出來看**，
 * 光看數字判斷不出來會不會超出邊界或壓到邊框。
 *
 * 跑法：cd scripts/ui-checks && node scripted-check-mark.mjs
 */
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const db = new Database('../../server/data.db');
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now());
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 3 });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

for (const mode of ['xianxia', 'classic']) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 沒有 URL 路由，先點群組再點子項
  for (const t of ['OSM Tools', '玄樞百器']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(800); break }
  }
  for (const t of ['腳本化投注', '御器投注']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(2500); break }
  }

  const box = page.locator('.scripted-check').first();
  if (!await box.count()) { console.log(`[${mode}] ❌ 找不到勾選框（可能沒進到頁面）`); continue }

  // 確保是勾起來的狀態才看得到勾勾
  if (!(await box.evaluate(el => el.classList.contains('on')))) {
    await box.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  const geo = await box.evaluate(el => {
    const b = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    const px = v => parseFloat(v) || 0;
    const left = px(a.left), top = px(a.top), w = px(a.width), h = px(a.height);
    return {
      boxW: Math.round(b.width), boxH: Math.round(b.height),
      after: { left, top, w, h },
      // 勾勾是旋轉 -45 度的 L 形，旋轉後外接矩形會比 w/h 大，這裡只粗估有沒有明顯溢出
      overflowRight: Math.round(left + w - b.width),
      overflowBottom: Math.round(top + h - b.height),
    };
  });
  console.log(`\n[${mode}] 方框 ${geo.boxW}x${geo.boxH}，勾勾 left:${geo.after.left} top:${geo.after.top} ${geo.after.w}x${geo.after.h}`);
  console.log(`  右邊剩 ${-geo.overflowRight}px、下面剩 ${-geo.overflowBottom}px`,
    (geo.overflowRight <= 0 && geo.overflowBottom <= 0) ? '→ 沒有溢出 ✅' : '→ 溢出方框 ❌');

  await box.screenshot({ path: `scripted-check-${mode}.png` });
  console.log(`  截圖：scripted-check-${mode}.png（3 倍解析度）`);
}

await browser.close();
