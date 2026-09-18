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
    return;
  }

  if (step.action === 'click') {
    await log(`⏳ ${idx} ${label}`);
    await (await ctx.recordedLocator(step.selector ?? '')).click({ timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return;
  }

  if (step.action === 'click_xy') {
    await log(`⏳ ${idx} ${label}`);
    await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return;
  }

  if (step.action === 'click_viewport') {
    await log(`⏳ ${idx} ${label}`);
    await page.mouse.click(step.x ?? 0, step.y ?? 0);
    await page.waitForTimeout(500);
    await log(`✅ ${idx} ${label}`);
    return;
  }

  if (step.action === 'type' || step.action === 'fill') {
    // ⚠️ `fill` 是 agent 模式舊錄製器的動作名。少了它的話，那些舊腳本會落到
    //    「不認得的動作」而失敗——留著是為了相容，新錄的一律是 type。
    await log(`⏳ ${idx} ${label}`);
    await (await ctx.recordedLocator(step.selector ?? '')).fill(step.value ?? '', { timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return;
  }

  if (step.action === 'wait') {
    await log(`⏳ ${idx} ${label}`);
    await page.waitForTimeout(Number(step.value) || 1000);
    await log(`✅ ${idx} ${label}`);
    return;
  }

  if (step.action === 'screenshot') {
    await log(`⏳ ${idx} ${label}`);
    await page.screenshot();
    await log(`✅ ${idx} ${label}`);
    return;
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
    return;
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
    return;
  }

  if (step.action === 'assert_visible') {
    await log(`⏳ ${idx} ${label}`);
    await (await ctx.recordedLocator(step.selector ?? '')).waitFor({ state: 'visible', timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return;
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
    return;
  }

  // 🚨 **不認得的動作一律失敗，不能跳過。**
  //
  // 原本兩邊都是「⏭ 跳過」，而那讓 `find_baseline_scroll` 在 agent 上被跳過很久——
  // 腳本照樣 PASS，視覺比對根本沒跑。少驗是誠實的，假裝驗過不是。
  throw new Error(`這個執行環境不支援「${step.action}」這個動作。`
    + '請確認伺服器與 Local Agent 都已更新到含這顆積木的版本；'
    + '若更新後仍然如此，代表這顆積木還沒有被實作。');
}
