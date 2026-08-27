/**
 * 週報 v4.53.0 兩個新功能的瀏覽器檢查。
 *
 * ① 來源 Sheet 勾「只用表單名稱，不讀裡面的內容」
 * ② 定時備稿提醒設定卡
 *
 * ## 導頁一定要先點群組再點子項
 * 這個 app 沒有 URL 路由，頁面是純 React state（見 uat-subtype-modal.mjs 同一條註解）。
 * 週報是頂層項目不在群組底下，但仍要用點的，不能靠網址。
 *
 * ## 為什麼一定要真的開瀏覽器
 * 「build 過了」只代表型別對，不代表勾了之後真的不進 batch-scan payload、
 * 也不代表下拉沒被祖先的 overflow 裁掉。這兩件事只有真的點下去才看得出來。
 *
 * 跑法：cd scripts/ui-checks && node weekly-report-v453.mjs
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

// batch-scan 的 payload 攔下來，才驗得到「勾了之後那份表真的沒送出去」
let lastScanPayload = null;
page.on('request', r => {
  if (r.url().includes('/api/weekly-report/batch-scan') && r.method() === 'POST') {
    try { lastScanPayload = JSON.parse(r.postData() ?? '{}') } catch { /* ignore */ }
  }
});

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

for (const t of ['週報彙整', '週報']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(3000); break }
}

const hasPage = await page.locator('text=定時備稿提醒').count();
console.log(hasPage ? '✅ 進到週報頁' : '❌ 進不到週報頁，以下都不算數');
if (!hasPage) { await browser.close(); process.exit(1) }

// ── ② 定時備稿提醒 ───────────────────────────────────────────────────────────
console.log('\n── 定時備稿提醒 ──');
const remBtn = page.locator('button:has-text("定時備稿提醒")').first();
console.log('  收合時摘要：', (await remBtn.innerText()).replace(/\s+/g, ' '));
await remBtn.click();
await page.waitForTimeout(600);
const enableBox = page.locator('label:has-text("啟用") input[type=checkbox]').first();
const weekdaySel = page.locator('select').filter({ hasText: '每週四' }).first();
const timeInput = page.locator('input[type=time]').first();
console.log('  展開後：啟用框', await enableBox.count(), '｜週幾下拉', await weekdaySel.count(), '｜時間欄', await timeInput.count());
console.log('  週幾目前值：', await weekdaySel.inputValue(), '｜時間目前值：', await timeInput.inputValue());
// 收合回去，不留下狀態
await remBtn.click();
await page.waitForTimeout(300);

// ── ① 只用表單名稱 ──────────────────────────────────────────────────────────
console.log('\n── 只用表單名稱 ──');
// 預設第一份是 OSM需求單，會自動讀表頭；等它讀完
await page.waitForTimeout(2500);
const nameOnlyBoxes = page.locator('label:has-text("只用表單名稱")');
console.log('  預設有幾份表顯示這個勾選框：', await nameOnlyBoxes.count(), '（第一份讀完表頭就會有）');

// 新增第二份，貼使用者給的那張表
const addBtn = page.locator('button:has-text("新增 Sheet")').first();
if (await addBtn.count()) { await addBtn.click(); await page.waitForTimeout(500) }
const urls = page.locator('input[placeholder*="sheets"]');
const idx = await urls.count() - 1;
await urls.nth(idx).fill('https://casinoplus.sg.larksuite.com/sheets/XSALs9DJBhwllatHuOJlspIlgEg?sheet=pnmnqp');
await page.locator('button:has-text("讀取表頭")').nth(idx).click();
await page.waitForTimeout(6000);

const boxes2 = page.locator('label:has-text("只用表單名稱")');
const n2 = await boxes2.count();
console.log('  讀完表頭後有幾份表可勾：', n2);
if (n2 < 2) { console.log('  ❌ 第二份沒讀到表頭（拿不到 tabName 就不該顯示勾選框，這步驟本來就會擋）') }
else {
  const target = boxes2.nth(n2 - 1);
  console.log('  第二份的表單名稱：', (await target.innerText()).replace(/\s+/g, ' '));
  await target.locator('input[type=checkbox]').click();
  await page.waitForTimeout(700);

  // placeholder 是 input 的屬性不是文字節點，要用屬性選擇器（第一次寫成 text= 抓不到）
  const memberSel = page.locator('input[placeholder*="選擇成員"]').last();
  console.log('  勾選後出現成員複選：', await memberSel.count() > 0 ? '✅' : '❌');
  const applyBtn = page.locator('button:has-text("套用（")').last();
  console.log('  套用按鈕（沒選人時應為 disabled）：', await applyBtn.isDisabled() ? '✅ disabled' : '❌ 沒鎖住');

  // 第一份沒被牽連
  const firstChecked = await boxes2.first().locator('input[type=checkbox]').isChecked();
  console.log('  第一份是否被牽連：', firstChecked ? '❌ 被一起勾了' : '✅ 沒有，逐份獨立');

  // 真的按掃描，看 payload 有沒有把它排除掉
  const scanBtn = page.locator('button:has-text("開始掃描")').first();
  if (await scanBtn.count() && !await scanBtn.isDisabled()) {
    lastScanPayload = null;
    await scanBtn.click();
    await page.waitForTimeout(8000);
    if (lastScanPayload) {
      const sent = (lastScanPayload.sheets ?? []).map(x => x.url);
      console.log('  batch-scan 實際送出的 sheets 份數：', sent.length);
      const leaked = sent.some(u => u.includes('XSALs9DJBhwllatHuOJlspIlgEg'));
      console.log('  勾了 nameOnly 的那份有沒有被送出去：', leaked ? '❌ 還是送出去了' : '✅ 沒有，被排除掉了');
    } else {
      console.log('  ⚠️ 沒攔到 batch-scan request（可能被擋在前置條件）');
    }

    // 掃描完才有草稿區，這時才驗得到「套用之後真的長出一筆」
    const tabName = (await target.innerText()).replace(/\s+/g, ' ').replace('只用表單名稱，不讀裡面的內容', '').trim();
    await memberSel.click();
    await page.waitForTimeout(500);
    const opt = page.locator('label:has-text("Eric")').last();
    if (await opt.count()) {
      await opt.click();
      await page.waitForTimeout(400);
      const applyNow = page.locator('button:has-text("套用（")').last();
      console.log('  選了人之後套用鈕：', await applyNow.isDisabled() ? '❌ 還是 disabled' : '✅ 可按');
      if (!await applyNow.isDisabled()) {
        await applyNow.click();
        await page.waitForTimeout(1200);
        // 直接查草稿的輸入框值——用 getByText 找不到，草稿內容是放在 input/textarea 的 value 裡
        const landed = await page.evaluate(t => {
          const all = [...document.querySelectorAll('input, textarea')];
          return all.filter(el => el.value === t).length;
        }, tabName);
        console.log(`  草稿區有沒有長出內容為「${tabName}」的項目：`, landed > 0 ? `✅ 有 ${landed} 筆` : '❌ 沒有');
      }
    } else {
      console.log('  ⚠️ 成員清單裡找不到可點的選項，跳過套用驗證');
    }
  } else {
    console.log('  ⚠️ 掃描按鈕不可點（scanReady 沒過），跳過 payload 驗證');
  }
}

console.log('\npage errors:', errors.length ? errors : '（無）');
await browser.close();
