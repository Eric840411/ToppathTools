/**
 * server/uat-runner/frontend-engine.js
 *
 * **H5／PC 積木的執行引擎——只有這一份。**
 *
 * ## 為什麼要合併
 * 在這之前這張「哪顆積木做什麼」的對照表**存在兩份**：`routes/frontend-auto.ts`（伺服器端）
 * 與 `agent-runner.ts`（agent 端）。而它們**已經漂了**：
 *
 *   - `find_baseline_scroll`（尋找基準圖）**只有伺服器端有** → 派工給 agent 時掉進
 *     「不認得的動作 → 跳過」，**腳本照樣 PASS，而視覺比對根本沒跑**。
 *     更糟的是框選截圖自動產生的就是那顆積木。
 *   - 加「後台設定」積木時，同一段邏輯得寫兩次——寫的當下有意識到所以兩邊都補了，
 *     但那正說明：**只要有兩份，就會有人哪次只改一邊**。
 *
 * 後台那條線早就只有一份（`block-engine.js`），H5 的**錄製器**上個月也因為一模一樣的
 * 理由合併過（當時一邊錄 `click`、另一邊錄 `click_viewport`）。這是第三次。
 *
 * ## 切法
 * 引擎只管「這顆積木要做什麼」，**環境差異由 host 用 ctx 提供**：
 *
 *   | host 提供 | 伺服器端 | agent 端 |
 *   |---|---|---|
 *   | `log` | `pushLog` | ws 事件 |
 *   | `loadBaseline` | 讀 DB ＋ 本機檔案 | 從 server 抓 |
 *   | `backend` | 直接從 DB 取 | server 派工時帶過來 |
 *
 * ## 約定
 * - **成功就正常返回，失敗一律 `throw`。** host 的迴圈負責重試／failureMode／計數，
 *   那部分兩邊本來就不同（agent 還要回報 step_result 事件）。
 * - **不認得的動作要 throw，不能回「跳過」。** 少驗是誠實的，假裝驗過不是。
 */
import { evaluateApiAssertion } from './api-assert.js';
import { runBackendOps } from './backend-ops.js';
import { clickRecorded, countRecorded, describeLocateFailure, locateRecorded } from './recorded-selector.js';

/** 這份引擎實作了哪些積木。⚠️ 加新積木時這裡也要加——測試會比對 */
export const FRONTEND_ACTIONS = Object.freeze([
  'goto', 'click', 'click_xy', 'click_viewport', 'type', 'fill', 'wait',
  'screenshot', 'find_baseline_scroll', 'assert_api_called', 'assert_visible',
  'backend_snippet',
]);

/**
 * 執行前的步驟整理。
 *
 * 目前只做一件事：**丟掉「座標點擊後面緊接著的 selector 點擊」**——錄製器對同一下操作
 * 會送出兩種形式，不丟的話同一個地方會被點兩次。
 *
 * ⚠️ 這段原本**只有伺服器端有**（agent 端沒有），所以同一份腳本在兩邊會點不一樣多次。
 *    這是合併時發現的第二處漂移——第一處是 `find_baseline_scroll`。
 *
 * @returns {{ steps: object[], dropped: number }}
 */
export function compileFrontendSteps(steps) {
  const kept = (steps ?? []).filter((step, index, list) => {
    const prev = list[index - 1];
    return !(prev?.action === 'click_viewport' && step.action === 'click');
  });
  return { steps: kept, dropped: (steps ?? []).length - kept.length };
}

/**
 * 跑一顆積木。
 *
 * @param {object} step 積木
 * @param {{
 *   idx: string,                 顯示用的 [3/10]
 *   label: string,               顯示用的步驟名稱
 *   log: (line: string) => Promise<void> | void,
 *   page: import('playwright').Page,
 *   browser: import('playwright').Browser | null,
 *   recordedLocator: (selector: string) => Promise<import('playwright').Locator>,
 *   netCapture: { records: () => object[] } | null,
 *   state: { netMark: number },  ⚠️ goto 會改它，所以是可變物件不是值
 *   startUrl: string,
 *   viewportHeight: number,
 *   backend: { backendUrl: string, username: string, password: string } | null,
 *   loadBaseline?: (step: object) => Promise<{ name: string, template: object, threshold: number }>,
 *   compareTemplate?: (shotPng: Buffer, template: object, threshold: number) => { x: number, y: number, diff: number } | null,
 *   decodePng?: (buffer: Buffer) => object,
 * }} ctx
 */
export async function runFrontendStep(step, ctx) {
  const { idx, label, log, page } = ctx;
  /**
   * 這一步產出的證據檔（目前只有截圖積木會放東西進來）。
   *
   * ⚠️ 回傳值是**後加的**，舊的兩個 host 都沒在收——所以一律回一個物件，
   * 不能改成「有東西才回」，不然接收端得多判一次 undefined。
   */
  const shots = [];

  if (step.action === 'goto') {
    const target = step.value || ctx.startUrl;
    await log(`⏳ ${idx} ${label} → ${target}`);
    // ⚠️ **netMark 要設在導頁之前，不是之後。**
    // 「開這頁時打了哪些後端」正是最常要驗的東西——設在 goto 完成又等三秒之後的話，
    // 載入期間那批 API 全部落在界線之前，assert_api_called 會永遠看到 0 支。
    // Backend 的 block-engine 早就踩過這個坑（也是實測才發現）。
    ctx.state.netMark = Date.now();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'click') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 🚨 **被蓋住的按鈕要有退路，否則只會看到一句 `Timeout 10000ms exceeded`。**
     *
     * 2026-09-19 實測（H5 機台內選面額）：`.btn_bet >> nth=1` 唯一命中、畫面上看得到、
     * 也沒有彈窗，但 `locator.click()` 一直 timeout——「SELECT A DENOMINATION」那圈
     * 發光的托盤蓋在按鈕上，攔截了 pointer events。Playwright 會一直等它變成可點，
     * 等到逾時為止，而錯誤訊息完全看不出「是被蓋住」。
     *
     * Backend 早就有 `clickRecorded`：先正常點，被擋就對**同一個已解析節點**呼叫
     * `el.click()`（事件照樣冒泡到 Vue 的 handler）。H5 這邊沒跟上，所以一樣的頁面
     * Backend 點得動、H5 點不動。
     *
     * ⚠️ `allowFallback` 只開到 JS 那一層——**不給座標退路**。
     *    座標會真的在那個位置按下去，把「不知道該點哪」變成一個看不見的誤點
     *    （`clickRecorded` 內部已經擋掉歧義錯誤，不會進退路）。
     */
    const target = await ctx.recordedLocator(step.selector ?? '');
    await clickRecorded({
      page: ctx.page, locator: target, selector: step.selector ?? '',
      allowFallback: true,
      viewportOk: async () => false,   // 不允許座標退路
      log,
    });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'click_xy') {
    await log(`⏳ ${idx} ${label}`);
    await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'click_viewport') {
    await log(`⏳ ${idx} ${label}`);
    await page.mouse.click(step.x ?? 0, step.y ?? 0);
    await page.waitForTimeout(500);
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'type' || step.action === 'fill') {
    // ⚠️ `fill` 是 agent 模式舊錄製器的動作名。少了它的話，那些舊腳本會落到
    //    「不認得的動作」而失敗——留著是為了相容，新錄的一律是 type。
    await log(`⏳ ${idx} ${label}`);
    await (await ctx.recordedLocator(step.selector ?? '')).fill(step.value ?? '', { timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'wait') {
    await log(`⏳ ${idx} ${label}`);
    await page.waitForTimeout(Number(step.value) || 1000);
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'screenshot') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ **拍了就要留得下來。** 這顆積木原本是 `await page.screenshot()` 然後把 Buffer
    //    丟掉——畫面上那個 ✅ 看起來拍好了，但**沒有任何地方存得到那張圖**。
    //    綁了 TC 的腳本要把截圖當證據回寫 Lark，所以由 host 提供「存到哪」。
    //    host 沒提供時維持舊行為（只是把畫面拍一次確認頁面還活著）。
    if (ctx.takeScreenshot) {
      const shot = await ctx.takeScreenshot(step.name || label || 'screenshot');
      if (shot) shots.push(shot);
    } else {
      await page.screenshot();
    }
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'find_baseline_scroll') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ 這顆積木**以前只有伺服器端有**，agent 上被靜默跳過。現在由 host 提供
    //    「怎麼拿到基準圖」，拿不到就**明確失敗**——不能再變回跳過。
    if (!ctx.loadBaseline || !ctx.compareTemplate || !ctx.decodePng) {
      throw new Error('這個執行環境無法取得基準圖（host 沒有提供 loadBaseline）——請更新 Agent 程式碼');
    }
    const baseline = await ctx.loadBaseline(step);
    const threshold = typeof step.threshold === 'number' ? step.threshold : baseline.threshold || 0.08;
    const scrollStep = Math.max(50, Number(step.scrollStep) || Math.floor((ctx.viewportHeight || 844) * 0.7));
    const maxScrolls = Math.max(1, Number(step.maxScrolls) || 20);
    let found = null;
    for (let attempt = 0; attempt <= maxScrolls; attempt++) {
      const shot = await page.screenshot({ fullPage: false });
      found = ctx.compareTemplate(ctx.decodePng(shot), baseline.template, threshold);
      if (found) break;
      const before = await page.evaluate(() => window.scrollY);
      const atBottom = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2);
      if (atBottom) break;
      await page.mouse.wheel(0, scrollStep);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => window.scrollY);
      if (after === before) break;
    }
    if (!found) throw new Error(`baseline "${baseline.name}" not found before page bottom`);
    await log(`✅ ${idx} ${label} → (${found.x}, ${found.y}), diff ${found.diff.toFixed(3)}`);
    return { shots };
  }

  if (step.action === 'assert_api_called') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ 拿不到網路紀錄一定要**失敗**。斷言被安靜跳過而腳本照樣 PASS，比直接報錯糟得多。
    if (!ctx.netCapture) throw new Error('這個執行環境沒有網路紀錄可查（量測沒有掛上）');
    if (!step.urlPattern) throw new Error('沒有填 API 網址樣式');
    const verdict = evaluateApiAssertion(
      ctx.netCapture.records().filter(r => Number(r.ts) >= ctx.state.netMark),
      { urlPattern: step.urlPattern, expectStatus: step.expectStatus, statusCode: step.statusCode, minCount: step.minCount },
    );
    if (!verdict.ok) throw new Error(`${step.urlPattern} —— ${verdict.why}`);
    await log(`✅ ${idx} ${label}（${verdict.why}）`);
    return { shots };
  }

  if (step.action === 'assert_visible') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 🚨 **這顆不能用 `ctx.recordedLocator()`。**
     *
     * host 建出來的那支帶 `requireUnique: true`，命中多筆就直接拋
     * 「定位必須唯一（命中 N 個）」。對 `click` 來說那是對的——不知道該點哪個就不該亂點；
     * 但這顆問的是「**畫面上看得到這東西嗎**」，`.grid-item-name` 這種一頁 30 個是常態。
     *
     * 2026-09-19 實測（H5 大廳，真站台）：
     * ```
     * .grid-item-name  → 定位必須唯一（命中 30 個）  ← 東西明明就在，卻判失敗
     * .section-title   → 定位必須唯一（命中 39 個）
     * .jackpot-number  → 定位必須唯一（命中 21 個）
     * ```
     * Backend 的 `assert_count` 早就踩過同一個坑並留了註解（`block-engine.js`：
     * 「這顆**不能**用 recordedLocator()」）——H5 這邊沒跟上，所以**任何會命中多個元素的
     * 選擇器都永遠通不過**，而錯誤訊息講的是「定位必須唯一」，看起來像選擇器寫錯，
     * 不像引擎限制。
     *
     * ⚠️ 仍然要走 Playwright locator，不能丟進 `querySelectorAll`：
     *    錄製器產出的 `:text-is()` / `text=` / `label=` 都不是合法 CSS。
     */
    const counted = await countRecorded(ctx.page, step.selector ?? '');
    if (counted.failure) {
      throw new Error(describeLocateFailure(counted, step.selector ?? label));
    }
    if (counted.count < 1) {
      throw new Error(`找不到元素：${step.selector ?? label}（命中 0 個）`);
    }
    // 命中多個時只要求「有一個看得見」——這顆的語意是存在且可見，不是數量檢查。
    // 要驗數量請用 Backend 的 assert_count；H5 目前沒有對應積木。
    // ⚠️ `locateRecorded` 在非唯一模式**已經挑好單一個**（優先挑看得見的），
    //    所以這裡不要再 `.first()`——那會把「它挑的那個」換回第一個，白挑一次。
    const located = await locateRecorded(ctx.page, step.selector ?? '', { requireUnique: false });
    if (located.failure || !located.locator) {
      throw new Error(describeLocateFailure(located, step.selector ?? label) || `找不到可用的元素：${step.selector ?? label}`);
    }
    await located.locator.waitFor({ state: 'visible', timeout: 10000 });
    await log(`✅ ${idx} ${label}（命中 ${counted.count} 個）`);
    return { shots };
  }

  if (step.action === 'backend_snippet') {
    // 後台設定：另開一顆 context 登入後台跑一段設定，跑完回來繼續前端腳本。
    const snippetSteps = step.snippetSteps ?? [];
    const snippetTitle = step.snippetTitle ?? '後台設定';
    if (!ctx.browser) throw new Error('瀏覽器尚未就緒，無法執行後台設定');
    if (!ctx.backend) throw new Error('沒有後台帳密，無法執行後台設定');
    await log(`⏳ ${idx} ${label}：${snippetTitle}`);
    const opResult = await runBackendOps(ctx.browser, {
      ...ctx.backend, steps: snippetSteps, title: snippetTitle,
      onNote: (line) => { void log(line) },
    });
    if (!opResult.ok) throw new Error(opResult.fails.join('；'));
    await log(`✅ ${idx} ${label}：${snippetTitle} 完成`);
    return { shots };
  }

  // 🚨 **不認得的動作一律失敗，不能跳過。**
  //
  // 原本兩邊都是「⏭ 跳過」，而那讓 `find_baseline_scroll` 在 agent 上被跳過很久——
  // 腳本照樣 PASS，視覺比對根本沒跑。少驗是誠實的，假裝驗過不是。
  throw new Error(`這個執行環境不支援「${step.action}」這個動作。`
    + '請確認伺服器與 Local Agent 都已更新到含這顆積木的版本；'
    + '若更新後仍然如此，代表這顆積木還沒有被實作。');
}
