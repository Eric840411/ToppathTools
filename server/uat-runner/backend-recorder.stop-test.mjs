/**
 * 錄製面板那顆「停止錄製」的瀏覽器測試：真的開 Chromium、真的點按鈕。
 *
 * ## 為什麼靜態檢查不夠
 * `scripts/ui-checks/recorder-stop-button.mjs` 釘的是「原始碼長成該有的樣子」。
 * 但這顆按鈕真正的失敗模式是**行為**上的——按鈕被別的元素蓋住、handler 因為
 * 註冊順序沒掛上、暫停中 handler 提早 return——這些原始碼看起來全都對。
 * 這個專案已經被同一種事坑過一次：徽章那個 bug 讓 15 項單元測試全綠，
 * 只有真的開瀏覽器點下去才看得見。
 *
 * ## 面板要有 TC 綁定才會掛上
 * `mountRecorderUi()` 只在 `CONFIG.bindings?.length` 時 appendChild(PANEL)——
 * 暫停與停止都住在那個面板裡，所以沒有綁定就兩顆都不存在（既有行為）。
 * 這支第一版沒帶 bindings，結果三條直接紅在「找不到按鈕」——是測試的 fixture
 * 不像正式環境，不是按鈕壞了。
 *
 * ## 一定要用真的 goto，不要用 setContent
 * 兩者的 init script 執行時機不同，用 setContent 會得到假的結論。
 *
 * 跑法：node server/uat-runner/backend-recorder.stop-test.mjs
 */
import { chromium } from 'playwright';
import { backendRecorderScript, RECORDER_MARKER, RECORDER_STOP_MARKER } from './backend-recorder.js';

const BINDINGS = [{ recordId: 'r1', number: 'TC-1', text: '示範 TC' }];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(backendRecorderScript({ sessionId: 'stop-test', bindings: BINDINGS }));
const page = await ctx.newPage();

/** 錄到的積木 */
const steps = [];
/** 收到幾次停止訊號 */
let stopSignals = 0;
page.on('console', m => {
  const t = m.text();
  // ⚠️ 順序跟兩個 host 一樣：停止先判。這裡刻意重現 host 的判斷方式，
  //    前綴設計若哪天被改成互為前綴，這支也會跟著抓到。
  if (t.startsWith(RECORDER_STOP_MARKER)) { stopSignals++; return; }
  if (t.startsWith(RECORDER_MARKER)) {
    try { steps.push(JSON.parse(t.slice(RECORDER_MARKER.length).trim())); } catch { /* 壞掉的當沒收到 */ }
  }
});

await page.goto('data:text/html,' + encodeURIComponent(
  '<nav>Player Credit Log</nav><input id="amount" type="text"><button id="go">送出查詢</button>'));
await page.evaluate(() => window.__toppathArmRecorder?.());
await page.waitForTimeout(200);

// ⚠️ 不要用 :has-text 定位這兩顆。暫停按下去文字就變成「繼續錄製」、
//    停止按下去變成「停止中…」——用文字抓的話，**測試會在自己按下按鈕之後
//    突然找不到它**，然後以 30 秒逾時收場（第一版就是這樣）。
//    改用結構定位：面板是唯一含 <select> 的那一塊，裡面剛好兩顆按鈕。
const panel = page.locator('div[data-toppath-recorder-ui]:has(select)');
const pauseBtn = panel.locator('button').nth(0);
const stopBtn = panel.locator('button').nth(1);

// ── 1　按鈕存在、可見、而且真的點得到 ────────────────────────────────────
check('停止按鈕存在', await stopBtn.count() === 1, `找到 ${await stopBtn.count()} 顆`);
check('停止按鈕看得見', await stopBtn.isVisible());
check('就在暫停旁邊', await pauseBtn.count() === 1 && await stopBtn.count() === 1);
check('面板裡剛好兩顆按鈕', await panel.locator('button').count() === 2,
  `實際 ${await panel.locator('button').count()} 顆——多一顆的話上面的 nth 定位會默默指到別的東西`);

const sBox = await stopBtn.boundingBox();
const pBox = await pauseBtn.boundingBox();
check('兩顆並排（水平相鄰、垂直對齊）',
  !!sBox && !!pBox && Math.abs(sBox.y - pBox.y) < 4 && sBox.x > pBox.x,
  `pause=${JSON.stringify(pBox)} stop=${JSON.stringify(sBox)}`);

// 「明顯一點」是使用者的要求：紅底、比暫停搶眼。這裡只釘住「不是預設樣式」，
// 不釘死色碼——釘死的話改個色階測試就紅，那不是防線是綁手綁腳。
const stopBg = await stopBtn.evaluate(el => getComputedStyle(el).backgroundColor);
const pauseBg = await pauseBtn.evaluate(el => getComputedStyle(el).backgroundColor);
check('停止跟暫停視覺上分得開', stopBg !== pauseBg, `stop=${stopBg} pause=${pauseBg}`);

// ── 2　停止按鈕自己不能被錄成一顆操作 ────────────────────────────────────
const beforeUiClick = steps.length;
await pauseBtn.click();          // 進暫停
await page.waitForTimeout(120);
check('點面板按鈕不會被錄成操作', steps.length === beforeUiClick,
  `多出 ${steps.length - beforeUiClick} 顆：${JSON.stringify(steps.slice(beforeUiClick))}`);

// ── 3　暫停中按停止仍然送得出訊號（不走 emit 的理由本身）────────────────
check('目前確實在暫停中', (await pauseBtn.innerText()).includes('繼續錄製'),
  `按鈕文字：${await pauseBtn.innerText()}`);
await stopBtn.click();
await page.waitForTimeout(250);
check('暫停中按停止，訊號送得出去', stopSignals === 1, `收到 ${stopSignals} 次`);
check('停止當下按鈕變成停止中', (await stopBtn.innerText()).includes('停止中'),
  `按鈕文字：${await stopBtn.innerText()}`);

// ── 4　沒收到停止時會提示，不是靜默失敗 ──────────────────────────────────
// 這裡刻意不收掉瀏覽器（模擬舊版 agent 根本不認得這個訊號），等逾時提示出現。
await page.waitForTimeout(5400);
const toastText = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[data-toppath-recorder-ui]')];
  return boxes.map(b => b.textContent || '').find(t => t.includes('停止指令沒有被接受')) || '';
});
check('舊版 Agent 收不到時會提示（不靜默）', toastText.includes('更新程式碼'),
  toastText ? `提示內容：${toastText.slice(0, 60)}…` : '完全沒有提示 ← 這就是靜默失敗');
check('提示後按鈕復原成可以再按', (await stopBtn.innerText()).includes('停止錄製')
  && await stopBtn.isEnabled(), `文字=${await stopBtn.innerText()} enabled=${await stopBtn.isEnabled()}`);

// ── 5　flush 順序：打完字立刻按停止，那一步不能消失 ──────────────────────
// 重開一顆乾淨的頁面，避免被上面的暫停狀態影響（狀態存在 sessionStorage）。
const ctx2 = await browser.newContext();
await ctx2.addInitScript(backendRecorderScript({ sessionId: 'stop-test-flush', bindings: BINDINGS }));
const page2 = await ctx2.newPage();
const steps2 = [];
let stopSignals2 = 0;
/** 積木與停止訊號**照發生順序**記在同一條軌跡上，順序才驗得出來 */
const order = [];
page2.on('console', m => {
  const t = m.text();
  if (t.startsWith(RECORDER_STOP_MARKER)) { stopSignals2++; order.push('__STOP__'); return; }
  if (t.startsWith(RECORDER_MARKER)) {
    try {
      const step = JSON.parse(t.slice(RECORDER_MARKER.length).trim());
      steps2.push(step); order.push(step.action);
    } catch { /* ignore */ }
  }
});
await page2.goto('data:text/html,' + encodeURIComponent(
  '<nav>Player Credit Log</nav><input id="amount" type="text"><button id="go">送出查詢</button>'));
await page2.evaluate(() => window.__toppathArmRecorder?.());
await page2.waitForTimeout(200);

// 打字但**不離開焦點**——這就是會掉步驟的那個情境
await page2.click('#amount');
await page2.fill('#amount', '12345');
await page2.waitForTimeout(120);
const typedBefore = steps2.filter(s => s.action === 'type_text').length;
check('打完字還沒離開焦點時，type_text 尚未產生', typedBefore === 0,
  `已經有 ${typedBefore} 顆，這個案例就測不到 flush 了`);

// ⚠️ **這裡一定要用程式化的 el.click()，不能用 Playwright 的 .click()。**
//    真人用滑鼠點按鈕會讓輸入框失焦，於是 focusout 監聽器（backend-recorder.js:340）
//    會自己 flush 一次——那條路徑把按鈕自己的 flush 完全遮住，**拿掉按鈕裡的 flush
//    測試照樣全綠**，這條防線就是假的（第一版就是這樣，注入測試當場抓到）。
//    HTMLElement.click() 不會移動焦點，所以 focusout 不會觸發，
//    按鈕自己那道 flush 是唯一救得了這一步的東西——這才測得到它。
await page2.locator('div[data-toppath-recorder-ui]:has(select)').locator('button').nth(1)
  .evaluate(el => el.click());
await page2.waitForTimeout(250);
const typed = steps2.filter(s => s.action === 'type_text');
check('按停止會先 flush，那一步沒有消失', typed.length === 1,
  `type_text 有 ${typed.length} 顆：${JSON.stringify(steps2.map(s => s.action))}`);
check('flush 出來的值是對的', typed[0]?.value === '12345', `拿到：${JSON.stringify(typed[0]?.value)}`);
check('停止訊號有送出', stopSignals2 === 1, `收到 ${stopSignals2} 次`);

check('順序：type_text 真的排在停止訊號之前', order.indexOf('type_text') >= 0
  && order.indexOf('__STOP__') >= 0 && order.indexOf('type_text') < order.indexOf('__STOP__'),
  `實際順序：${JSON.stringify(order)}`);

await browser.close();

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
