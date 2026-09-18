/**
 * server/uat-runner/frontend-tc-engine.js
 *
 * 把 H5／PC 的積木引擎（`frontend-engine.js`）接上**跟 Backend 同一套聚合規則**
 * （`multi-tc.js`：每筆 TC 失敗隔離、共用步驟失敗全部 blocked、零斷言＝待確認）。
 *
 * ## 為什麼不另寫一份聚合
 * 「什麼算通過」只能有一份。各寫一份的話，H5 那邊遲早會長出第二套判定，而症狀是
 * **兩個分頁對同一種情況給出不同結論**——沒有人會發現，因為兩邊各自看起來都合理。
 * 這個 repo 今天已經因為「兩份引擎」咬過兩次（基準圖在 agent 上被跳過、重複點擊
 * 只有一邊會濾）。所以 `multi-tc.js` 改成可換引擎，這裡只提供「H5 的積木是什麼」。
 *
 * ## 這一支只負責三件事
 *   ① **分類**：哪顆積木算檢查、哪顆算證據（聚合器據此判斷「這一步要不要指定 TC」）
 *   ② **結果契約**：`runFrontendStep` 是「成功就返回、失敗就 throw」，
 *      這裡轉成聚合器要的 `{ pass, manual, criticalFails, warnings, allShotPaths }`
 *   ③ **重試**：H5 積木的 `failureMode: 'retry'` 在這裡處理
 *
 * ## ⚠️ 執行責任只有一份
 * 接上聚合器之後，**外層的迴圈不可以再自己重試／自己判 failureMode**——
 * 兩邊都做的話同一顆積木會被跑兩次（而且日誌上看起來只跑了一次）。
 * 外層只負責「還要不要繼續跑下一顆」。
 */
import { runFrontendStep } from './frontend-engine.js';

/**
 * H5／PC 積木的分類表。**欄位名跟 Backend 的 `BLOCK_DEFS` 一致**，聚合器才認得。
 *
 * | 分類 | 意思 | 聚合器怎麼用 |
 * |---|---|---|
 * | `nav` | 操作／導航 | 不必指定所屬 TC（登入、進大廳那種共用前置） |
 * | `assert` / `compare` | 檢查 | **一定要指定 TC**；通過才算一次 assertion |
 * | `evidence` | 截圖 | **一定要指定 TC**（圖要回寫到哪一筆） |
 *
 * ⚠️ **這裡沒有的動作＝聚合器會明確拒絕**，不是跳過。少一個的症狀是
 * 「這顆積木存得起來，一按執行就說不支援」——比靜默跳過好查得多。
 */
export const FRONTEND_BLOCK_DEFS = Object.freeze({
  goto: { category: 'nav' },
  click: { category: 'nav' },
  click_xy: { category: 'nav' },
  click_viewport: { category: 'nav' },
  type: { category: 'nav' },
  fill: { category: 'nav' },
  wait: { category: 'nav' },
  backend_snippet: { category: 'nav' },
  screenshot: { category: 'evidence' },
  assert_visible: { category: 'assert' },
  assert_api_called: { category: 'assert' },
  // 視覺基準比對：跟 Backend 的圖片比對同一個分類
  find_baseline_scroll: { category: 'compare' },
});

/**
 * 把 H5 積木的失敗處置翻成聚合器看得懂的 `onFail`。
 *
 * ⚠️ **兩邊用的欄位名不一樣**：H5 是 `failureMode`（stop／continue／retry／inherit），
 * Backend 是 `onFail`（stop／continue／warn／manual）。不翻的話聚合器讀到的是
 * `undefined`，於是**每一顆失敗都當成 stop**——`continue` 那些積木會安靜地失去效果，
 * 而畫面上看不出差別（只會覺得「怎麼失敗就停了」）。
 *
 * `retry` 不是「失敗之後怎麼辦」而是「失敗之前再試幾次」，所以它翻成
 * 腳本層級的預設值（`inherit`）。重試本身在 adapter 裡做。
 */
export function toMultiTcSteps(steps, defaultFailureMode = 'stop') {
  return (steps ?? []).map(step => {
    const mode = step.failureMode && step.failureMode !== 'inherit' ? step.failureMode : defaultFailureMode;
    return { ...step, onFail: mode === 'continue' ? 'continue' : 'stop' };
  });
}

/**
 * 建一顆給 `runMultiTcSteps(steps, ctx, bindings)` 用的引擎。
 *
 * @param {object} hostCtx `runFrontendStep` 要的那一整包（log／page／browser／
 *   recordedLocator／netCapture／startUrl／viewportHeight／backend／loadBaseline…）。
 *   ⚠️ **不含 `state`**：那個由聚合器管，每一步都會傳進來。
 * @returns {{ defs: object, runSteps: Function }}
 */
export function createFrontendTcEngine(hostCtx) {
  return {
    defs: FRONTEND_BLOCK_DEFS,
    runSteps: (steps, ctx, options = {}) => runOneFrontendStep(steps, { ...hostCtx, ...ctx }, options),
  };
}

/**
 * 跑一顆積木並轉成聚合器的結果契約。
 *
 * ⚠️ **失敗一定要同時滿足 `pass === false` 與 `criticalFails.length > 0`。**
 * 只設 `pass = false` 而不記硬失敗的話，聚合器最後那段會判成
 * 「沒有成功執行的檢查條件 → 待確認」——**失敗會被降級成待確認**，
 * 回寫到 Lark 就是「需人工」而不是 FAIL。
 */
async function runOneFrontendStep(steps, ctx, options) {
  const notes = [];
  const criticalFails = [];
  const warnings = [];
  const allShotPaths = [];
  // 聚合器用同一個 state 物件跨步驟保存網路界線；`goto` 會改它。
  const state = options.state ?? { netMark: Date.now() };
  if (typeof state.netMark !== 'number') state.netMark = Date.now();

  for (const step of steps) {
    const def = FRONTEND_BLOCK_DEFS[step.action];
    if (!def) {
      // ⚠️ 不認得的動作**明確失敗**，不是跳過。（v4.208.0 的教訓：
      //    跳過的話腳本照樣 PASS，而那一步根本沒跑。）
      const message = `不支援的動作「${step.action}」——請確認伺服器與 Local Agent 都已更新`;
      notes.push(`❌ ${message}`);
      criticalFails.push(message);
      continue;
    }
    const retryLimit = step.failureMode === 'retry'
      ? Math.min(10, Math.max(0, Number(step.retryCount) || 1))
      : 0;
    let attempt = 0;
    while (true) {
      try {
        // ⚠️ 顯示用的「[3/10] 步驟名」由這裡組，**不能沿用 host 傳進來的**——
        //    聚合器是一顆一顆送進來的，host 那份會整輪停在第一顆，
        //    日誌上就變成每一行都寫 [1/N]。序號由 host 用 onStep 更新到 ctx.progress。
        const outcome = await runFrontendStep(step, {
          ...ctx,
          state,
          idx: ctx.progress?.idx ?? '',
          label: step.name || step.action,
        });
        if (Array.isArray(outcome?.shots)) allShotPaths.push(...outcome.shots);
        notes.push(`✅ ${step.name || step.action}`);
        break;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        // ⚠️ 瀏覽器被關掉不該重試——重試只會得到同一個錯誤，而且把中止拖慢好幾倍。
        const fatal = /closed|Target crashed|Stopped by user/.test(message);
        if (attempt < retryLimit && !fatal) {
          attempt++;
          notes.push(`↻ 第 ${attempt}/${retryLimit} 次重試：${message}`);
          continue;
        }
        notes.push(`❌ ${step.name || step.action}：${message}`);
        criticalFails.push(message);
        break;
      }
    }
  }

  if (options.state) options.state.netMark = state.netMark;
  return {
    diagnostics: [],
    declaredOutcome: null,
    pass: criticalFails.length === 0,
    // H5 積木沒有「標成需人工」這種動作（Backend 的 `mark_manual`），
    // 所以這裡永遠是 false——不是漏做，是這套積木裡不存在那個概念。
    manual: false,
    manualReason: '',
    notes: notes.join(' | '),
    criticalFails,
    warnings,
    allShotPaths,
    error: criticalFails[0] ?? null,
  };
}
