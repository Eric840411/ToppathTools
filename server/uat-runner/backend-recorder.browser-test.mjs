/**
 * 錄製器的瀏覽器測試：真的開一顆 Chromium、真的注入、真的點。
 *
 * ## 為什麼需要這支（單元測試看不出來的東西）
 * backend-recorder.js 曾經在最外層直接 document.documentElement.appendChild(...)，
 * 但 addInitScript 執行的當下 documentElement 還是 null——那一行拋錯，**後面所有
 * 標斷言的監聽器都沒被註冊**。症狀極隱蔽：一般操作的錄製註冊在那一行之前，照常
 * 運作、看起來錄得好好的，只有標斷言完全沒反應，於是錄出來的腳本永遠零斷言，
 * 跑起來一定 PASS。15 項單元測試全過，完全抓不到。
 *
 * ## 一定要用真的 goto，不要用 setContent
 * 兩者的 init script 執行時機不同。用 setContent 測會得到假的結論——查這個 bug 時
 * 就是先被它誤導過一次。
 *
 * 跑法：node server/uat-runner/backend-recorder.browser-test.mjs
 */
// 驗證「標記模式」徽章：真的注入一頁、真的點它、真的確認行為變了
import { chromium } from 'playwright';
import { backendRecorderScript, RECORDER_MARKER } from './backend-recorder.js';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(backendRecorderScript());
const page = await ctx.newPage();
const events = [];
page.on('console', m => {
  const t = m.text();
  if (t.startsWith(RECORDER_MARKER)) events.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim()));
});

// 一定要用真的導頁：setContent 的 init script 時機跟實際 goto 不同，
// 用它測會得到假的結論（第一次就是這樣誤判成「徽章沒掛上去」）
await page.goto('data:text/html,' + encodeURIComponent(
  '<button id="go">送出查詢</button>'
  + '<table class="el-table__header"><thead><tr><th>Machine Name</th></tr></thead></table>'));
await page.evaluate(() => window.__toppathArmRecorder?.());
await page.waitForTimeout(200);

// 1) 徽章存在、預設是關
const badge = page.locator('[data-toppath-recorder-ui]');
console.log('徽章存在:', await badge.count() === 1);
console.log('預設文字:', (await badge.innerText()).trim());
const box = await badge.boundingBox();
console.log('徽章位置（右下角）:', box ? `x=${Math.round(box.x)} y=${Math.round(box.y)}` : '(量不到)');

// 2) 標記模式關著時，點按鈕應該錄成「操作」
await page.click('#go');
await page.waitForTimeout(150);
const afterPlainClick = events.length;
console.log('\n關著時點按鈕 → 錄到', afterPlainClick, '筆（應該是 1 筆 click 動作）:', JSON.stringify(events[0]?.action ?? null));

// 3) 點徽章開啟
await badge.click();
await page.waitForTimeout(150);
console.log('\n點徽章後文字:', (await badge.innerText()).trim());
console.log('點徽章本身有沒有被錄成操作:', events.length === afterPlainClick ? '沒有 ✅' : '被錄進去了 ❌');

// 4) 開著時點按鈕，應該跳出標記選單而不是錄成操作
await page.click('#go');
await page.waitForTimeout(300);
const menuVisible = await page.evaluate(() => !!window.__toppathPicking);
console.log('\n開著時點按鈕 → 進入標記流程:', menuVisible ? '是 ✅' : '否 ❌');
console.log('  有沒有被誤錄成操作:', events.length === afterPlainClick ? '沒有 ✅' : '多錄了 ❌');

// 5) 標記模式下點選單裡的選項，要真的送出斷言、關掉選單，而且不能再開一個
//
// ⚠️ 這是 2026-09-01 那個 bug 的回歸測試。當時選單沒有 data-toppath-recorder-ui，
//    於是 markMode 開著時點選項會被 document 的 capture 監聽器當成「標記新元素」，
//    它的 stopPropagation() 讓選項自己的 onclick 永遠不會執行——
//    斷言沒送出、選單沒關，還對「選單自己的按鈕」又開了一個。
//    使用者看到「點一個就會產生第二個」，實際後果是**標記模式下錄不出任何斷言**。
//
//    單元測試看不到這個：它只驗轉換邏輯，不會真的派發事件走完 capture/target 兩階段。
const menuCount = async () => page.evaluate(() =>
  document.querySelectorAll('[data-toppath-recorder-ui]').length);
const beforePick = events.length;
console.log();
console.log('選單開啟時，recorder UI 元素數（徽章 + 選單 = 2）:', await menuCount());

// 點第一個選項「必須有值」
await page.evaluate(() => {
  const menus = [...document.querySelectorAll('[data-toppath-recorder-ui]')];
  const menu = menus.find(m => (m.textContent || '').includes('要檢查這個元素的什麼'));
  menu?.querySelector('button')?.click();
});
await page.waitForTimeout(250);

const added = events.slice(beforePick);
console.log('點選項後：');
console.log('  有送出斷言:', added.some(e => e.assertion) ? '是 ✅' : `否 ❌（多出 ${JSON.stringify(added)}）`);
console.log('  斷言種類:', added.find(e => e.assertion)?.assertion?.kind ?? '(無)');
console.log('  選單已關閉:', (await menuCount()) === 1 ? '是 ✅（只剩徽章）' : `否 ❌（還有 ${await menuCount()} 個）`);
console.log('  沒有開出第二個選單:', (await menuCount()) <= 1 ? '是 ✅' : '否 ❌');
console.log('  picking 狀態已解除:', (await page.evaluate(() => !!window.__toppathPicking)) === false ? '是 ✅' : '否 ❌');

await browser.close();
