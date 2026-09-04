/**
 * URL 帳號池的 QAT / UAT 分頁。
 *
 * 兩件事要守：
 * ① 切分頁要**真的換一批資料**（不是同一批的篩選）——兩邊網域不同、號段不同
 * ② **27 筆「有帳號但沒有 URL」的不能標成可用**。那些是產 token 的腳本沒跑出來的，
 *    刻意保留在清單上（過濾掉的話沒有人會知道它們存在），但點下去會產生一個空的
 *    中轉連結，所以必須擋住複製並標示原因。
 *
 * ⚠️ 這支不會認領任何帳號——`複製使用 URL` 會觸發自動認領，測試不該去佔用真實帳號。
 *    只檢查按鈕的可用狀態，不按下去。
 *
 * 跑法：node scripts/ui-checks/url-pool-env-tabs.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
// ⚠️ 這支端點會真的佔用帳號。攔掉，確保測試不會影響正在用的人。
await page.route('**/api/url-pool/*/claim', r => r.fulfill({ json: { ok: false, message: 'blocked by test' } }));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
// 這個 app 沒有 URL 路由，要先點群組再點子項
for (const t of ['OSM Tools', 'URL 帳號池', '靈脈調度']) {
  const l = page.locator(`text=${t}`).first();
  if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(900) }
}
await page.waitForTimeout(1200);

const readTable = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('tbody tr')];
  const cells = r => [...r.querySelectorAll('td')].map(td => (td.textContent || '').trim());
  return {
    列數: rows.length,
    第一筆帳號: cells(rows[0] ?? document.createElement('tr'))[0] ?? '',
    網域: (document.body.innerText.match(/https:\/\/[a-z-]*osm-redirect\.osmslot\.org/g) ?? [])
      .filter((v, i, a) => a.indexOf(v) === i),
    無URL標記: [...document.querySelectorAll('tbody tr')].filter(r => (r.textContent || '').includes('無 URL')).length,
    總計: (document.body.innerText.match(/總計\s*(\d+)/) ?? [])[1] ?? '',
  };
});

console.log('\n1) 預設是 QAT');
const qat = await readTable();
check('有資料', qat.列數 > 0, `${qat.列數} 列`);
check('帳號是 9111 開頭（QAT 號段）', qat.第一筆帳號.startsWith('9111'), qat.第一筆帳號);
check('網域是 osm-redirect（非 uat-）', qat.網域.every(d => !d.includes('uat-')), qat.網域.join(','));
check('總計 191', qat.總計 === '191', qat.總計);

console.log('\n2) 切到 UAT —— 要換一批資料，不是篩選');
await page.locator('[data-testid="url-pool-env-uat"]').click();
await page.waitForTimeout(900);
const uat = await readTable();
check('帳號變成 9361 開頭（UAT 號段）', uat.第一筆帳號.startsWith('9361'), uat.第一筆帳號);
check('網域變成 uat-osm-redirect', uat.網域.some(d => d.includes('uat-')), uat.網域.join(','));
check('總計 500', uat.總計 === '500', uat.總計);
check('看得到「無 URL」標記', uat.無URL標記 > 0, `本頁 ${uat.無URL標記} 列`);

console.log('\n3) 沒有 URL 的不能複製');
// ⚠️ 這一條是重點：標示對了但按鈕還能按的話，使用者會拿到一個空的中轉連結
const noUrlBtn = await page.evaluate(() => {
  const row = [...document.querySelectorAll('tbody tr')].find(r => (r.textContent || '').includes('無 URL'));
  if (!row) return null;
  const btn = [...row.querySelectorAll('button')].find(b => (b.textContent || '').includes('複製使用 URL'));
  return btn ? { disabled: btn.disabled, title: btn.title } : null;
});
check('找得到無 URL 的列', noUrlBtn !== null);
check('複製按鈕是停用的', noUrlBtn?.disabled === true);
check('停用原因寫在 title 裡', /沒有 URL/.test(noUrlBtn?.title ?? ''), noUrlBtn?.title);

const okBtn = await page.evaluate(() => {
  const row = [...document.querySelectorAll('tbody tr')].find(r => !(r.textContent || '').includes('無 URL'));
  const btn = row ? [...row.querySelectorAll('button')].find(b => (b.textContent || '').includes('複製使用 URL')) : null;
  return btn ? { disabled: btn.disabled } : null;
});
check('有 URL 的仍可複製（沒有誤擋）', okBtn?.disabled === false);

console.log('\n4) 切回 QAT 要完全還原');
await page.locator('[data-testid="url-pool-env-qat"]').click();
await page.waitForTimeout(900);
const back = await readTable();
check('帳號回到 9111 開頭', back.第一筆帳號.startsWith('9111'), back.第一筆帳號);
check('總計回到 191', back.總計 === '191');
check('QAT 沒有「無 URL」的列', back.無URL標記 === 0, `${back.無URL標記} 列`);

console.log('\n5) 「已設定」要跟「使用中」分開');
// ⚠️ 中轉認領是自願制，實測 8 台已設定的 Game URL 有 5 台在用帳號池的帳號、0 台走中轉，
//    而畫面顯示「使用中 0」。這一組驗的就是那 5 台現在看不看得見。
{
  const st = await page.evaluate(() => {
    const t = document.body.innerText;
    const num = (label) => { const m = new RegExp(label + '\\s*(\\d+)').exec(t); return m ? Number(m[1]) : null };
    const rows = [...document.querySelectorAll('tbody tr')];
    const withAssigned = rows.filter(r => (r.textContent || '').includes('已設定'));
    return {
      已設定: num('已設定'), 使用中: num('使用中'), 可用: num('可用'), 總計: num('總計'),
      有已設定標記的列: withAssigned.length,
      // ⚠️ 不能用 querySelector('[title]') 抓第一個——那一列的 URL 欄也有 title，
      //    會抓到網址而不是狀態標籤（第一版就是這樣誤報的）
      第一個已設定的標題: [...(withAssigned[0]?.querySelectorAll('[title]') ?? [])]
        .find(el => (el.textContent || '').includes('已設定'))?.getAttribute('title') ?? '',
      讀取失敗橫幅: t.includes('讀不到「已設定」狀態'),
    };
  });
  check('沒有出現讀取失敗橫幅', !st.讀取失敗橫幅);
  check('「已設定」是獨立統計，沒有併進使用中', st.已設定 !== null && st.使用中 !== null);
  check('QAT 有帳號被設定綁著（實測 5 台）', (st.已設定 ?? 0) > 0, `已設定 ${st.已設定}`);
  check('列上看得到「已設定」標記', st.有已設定標記的列 > 0, `${st.有已設定標記的列} 列`);
  check('標記會講是誰的哪一台', /設定裡填著這個帳號/.test(st.第一個已設定的標題), st.第一個已設定的標題.slice(0, 50));
  // ⚠️ 可用不能把「已設定」的算進去——算進去別人拿走會撞帳號，正是要修的問題
  check('可用沒有把已設定的算進去',
    (st.可用 ?? 0) + (st.已設定 ?? 0) + (st.使用中 ?? 0) <= (st.總計 ?? 0),
    `${st.可用}+${st.已設定}+${st.使用中} <= ${st.總計}`);
}

console.log('\n6) 消費端也要看得到 UAT（不是只有帳號池那頁）');
// ⚠️ v4.105.0 給帳號池加了 UAT，但 AutoSpin／機台測試共用的「帳號池選取」彈窗
//    仍然只看得到 191 筆 QAT——使用者截圖回報「共 191 個帳號」。
//    加資料源時漏掉消費端，跟今天修過兩次的「新增狀態但漏掉讀取端」同一種。
{
  await page.locator('text=OSM Tools').first().click().catch(() => {});
  await page.waitForTimeout(600);
  for (const t of ['AutoSpin', '傀儡監院']) {
    const l = page.locator(`text=${t}`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(1600); break }
  }
  // ⚠️ 彈窗不是一顆按鈕就開得了：要先按機台列的「編輯」，才會出現 Game URL 旁的「選取」。
  //    第一版直接找含「帳號池」的按鈕，結果只找到側邊欄的「URL 帳號池」導覽項。
  await page.locator('button', { hasText: '編輯' }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  const poolBtn = page.locator('button[title="從帳號池選取"]').first();
  if (await poolBtn.count() === 0) {
    check('找得到「從帳號池選取」按鈕', false, '（機台編輯表單可能沒展開）');
  } else {
    await poolBtn.click();
    await page.waitForTimeout(1000);
    const hasTabs = await page.locator('[data-testid="pool-picker-env-uat"]').count();
    check('彈窗有 UAT 分頁', hasTabs > 0);
    if (hasTabs > 0) {
      const readCount = () => page.evaluate(() =>
        (document.body.innerText.match(/共 (\d+) 個帳號/) ?? [])[1] ?? '');
      const before = await readCount();
      await page.locator('[data-testid="pool-picker-env-uat"]').click();
      await page.waitForTimeout(800);
      const after = await readCount();
      check('切到 UAT 之後筆數改變', before !== after, `${before} -> ${after}`);
      // ⚠️ 27 筆沒有 URL 的不能出現在可選清單——選了會把空字串帶進 Game URL
      check('可選的是 473 筆（沒有 URL 的 27 筆被排除）', after === '473', after);
    }
  }
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
await browser.close();
process.exit(fail ? 1 : 0);
