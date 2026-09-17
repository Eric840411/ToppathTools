/**
 * server/uat-runner/frontend-recorder.js
 *
 * H5／PC 錄製器的注入腳本。**兩個 host 共用這一份**：
 *   - agent 模式：`agent-runner.ts` 自己開 Chrome、用原始 CDP 注入
 *   - 伺服器模式：`routes/frontend-auto.ts` 在本機開 Chrome，同樣走原始 CDP
 *
 * ## 為什麼要合成一份（2026-09-18）
 * 這兩個 host 原本**各自帶一份 44 行的錄製器，而且已經漂掉了**：
 *
 * | | agent 模式 | 伺服器模式 |
 * |---|---|---|
 * | 點擊 | `click` + cssPath | `click_viewport` + 座標 |
 * | 輸入 | `fill` | `type` |
 * | 去重 | 200ms 視窗 | **整段錄製都不重複**（同一顆按鈕按兩次只錄到一次） |
 *
 * 後果很難發現：同一個畫面、同一組操作，換一種模式錄出來是不同的腳本；
 * 而 `fill` 在伺服器模式的執行引擎裡根本不存在——會落到
 * 「⏭ 不支援的動作 → **skipped**」，腳本照樣 PASS。
 *
 * ## DOM 與 Canvas 分開處理（CodeX 2026-09-17 定的切法）
 * H5 是 Vue 3 的 DOM 介面，PC 是 Cocos 的 canvas。**按元素能力切，不是按平台切**：
 *   - 點在 `<canvas>` 上 → 錄座標（canvas 裡沒有東西可以指，選擇器再漂亮也是假的）
 *   - 點在真正的 DOM 上 → 走共用選擇器階梯
 * 所以 PC 的外層 DOM（大廳按鈕、設定面板）也吃得到階梯，H5 若真的嵌了 canvas
 * 也會自動退回座標。
 *
 * ## 錄製當下的驗證
 * 只驗語意對得齊的原生 CSS，其他回 `unknown` + `unsupported`。
 * 理由寫在 `selector-ladder.js` 的 `nativeSelectorCheckSource()`。
 */
import { selectorLadderSource, genericAdapterSource, nativeSelectorCheckSource } from './selector-ladder.js';

/**
 * 錄製器把積木用這個前綴印到 console，兩個 host 都用 `startsWith` 收。
 * ⚠️ 值不能改——舊版 agent 還在用字面量比對。
 */
export const FRONTEND_RECORDER_MARKER = '__TOPPATH_RECORDER__';

export function frontendRecorderScript() {
  return `
(() => {
  if (window.__toppathRecorderInstalled) return;
  window.__toppathRecorderInstalled = true;
${selectorLadderSource(genericAdapterSource())}
${nativeSelectorCheckSource()}

  const MARK = ${JSON.stringify(FRONTEND_RECORDER_MARKER)};
  // ⚠️ 去重只擋「同一下操作被瀏覽器送兩次」，不能擋「使用者真的按了兩次」。
  //    舊的伺服器模式用整段錄製共用的 Set 去重，同一顆按鈕按第二次就**安靜消失**。
  const recent = new Map();
  const send = (step) => {
    const key = step.action + '|' + (step.selector || '') + '|' + (step.x ?? '') + ',' + (step.y ?? '') + '|' + (step.value ?? '');
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 200) return;
    recent.set(key, now);
    console.info(MARK, JSON.stringify(step));
  };

  /** canvas 裡沒有 DOM 可以指，只有座標是真的 */
  const canvasOf = (el) => (el && el.closest) ? el.closest('canvas') : null;

  const describeStep = (el) => {
    const target = actionableTarget(el);
    const d = describe(target);
    const check = nativeSelectorCheck(d.selector, target);
    const step = { selector: d.selector, selectorStrategy: d.strategy, selectorCheck: check.status };
    if (check.reason) step.selectorCheckReason = check.reason;
    return step;
  };

  document.addEventListener('click', (event) => {
    if (window.__toppathCropping) return;
    const el = event.target;
    if (el && el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    const canvas = canvasOf(el);
    if (canvas) {
      // ⚠️ 用 viewport 座標，因為兩個執行引擎的 click_viewport 都是 page.mouse.click(x, y)。
      //    改成 canvas 相對座標的話，canvas 不在左上角時會整個偏掉。
      const x = Math.round(event.clientX);
      const y = Math.round(event.clientY);
      send({ name: '點擊畫面 (' + x + ', ' + y + ')', action: 'click_viewport', x, y });
      return;
    }
    const d = describeStep(el);
    if (!d.selector) return;
    send({ name: '點擊 ' + d.selector, action: 'click', ...d });
  }, true);

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!el || !('value' in el)) return;
    if (el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    const d = describeStep(el);
    if (!d.selector) return;
    // ⚠️ 動作名一定要是 type。伺服器模式的執行引擎沒有 fill 這個動作，
    //    錄成 fill 的腳本在那邊會被當成「不支援的動作」**跳過**，而腳本照樣 PASS。
    send({ name: '輸入 ' + d.selector, action: 'type', ...d, value: String(el.value || '') });
  }, true);
})();
`;
}
