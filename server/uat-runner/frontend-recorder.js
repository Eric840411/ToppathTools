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

/**
 * host 端：查這份文件裡有沒有**我們追蹤不到的** shadow root。
 * 查完而且乾淨才把這份文件標成「可以宣稱驗過」。
 *
 * 為什麼一定要 host 來查：宣告式的 closed root（`<template shadowrootmode="closed">`）
 * 在頁面裡完全偵測不到（三條路都試過，見 frontendRecorderScript 裡的說明），
 * **只有 CDP 看得到**。
 *
 * ⚠️ **預設是「尚未確認」，不是「沒問題」**（CodeX 2026-09-18 第四輪指出）。
 *    原本的寫法是「查到問題才設旗標」，於是**查完之前**那段時間一律放行——
 *    而 host 是等 `load` 才查的，`load` 跟「頁面可以點了」在規範上是不同階段。
 *    使用者在那個窗口點了宣告式 closed 元件，那一步就被標成已驗證，**而且之後
 *    查出問題也不會回頭改那一筆**。所以改成反向：確認過才允許驗證。
 *
 * ⚠️ 用 docId 綁定文件。導頁之後回來的檢查結果屬於**上一份文件**，
 *    套到新文件上就是把別人的結論當自己的。
 *
 * ⚠️ 光比 docId 還不夠，**還要確認那份文件已經離開 `loading`**：
 *    讀 docId 時可能已經導到新頁而新頁還在解析，掃一份半成品 DOM 當然找不到
 *    shadow root，於是把它標成「已確認乾淨」——而它後面才解析出來的宣告式
 *    closed root 就會被錯標成已驗證。兩邊讀到的 docId 都一樣，比對擋不到。
 *
 * ⚠️ 這裡刻意**過度保守**：只要這一頁有任何作者建立的 shadow root，整頁都不宣稱
 *    驗過，不去區分「是不是我們自己追蹤到的那些」。少標 ok 只是少一點資訊，
 *    錯標 ok 會讓人相信一條會點錯的選擇器。
 *
 * ⚠️ 查詢失敗（DOM domain 不通、逾時）就維持「尚未確認」——**退路往安全的方向倒**。
 *
 * @param {(method: string, params?: object) => Promise<any>} send CDP 送訊息的函式
 */
export async function flagShadowCompleteness(send) {
  const value = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.result?.value;
  };
  try {
    // ⚠️ **要一併確認這份文件已經解析完**（CodeX 2026-09-18 第五輪指出）。
    //    載入事件是 A 頁的，但這行 evaluate 執行時可能已經導到 B 頁了——
    //    那時讀到的是 B 的 docId，而 B 還在解析中。掃一份**半成品 DOM**
    //    當然找不到 shadow root，於是把 B 標成「已確認乾淨」，
    //    B 後面才解析出來的宣告式 closed root 就會被錯標成已驗證。
    //    docId 比對擋不到這個——兩邊讀到的都是 B。
    const state = await value('JSON.stringify({ id: window.__toppathDocId || "", rs: document.readyState })');
    const before = state ? JSON.parse(state) : null;
    if (!before?.id) return;              // 錄製器還沒裝好，不下結論
    if (before.rs === 'loading') return;  // 還在解析，等下一次（load 那次）再查
    await send('DOM.enable');
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const root = doc?.result?.root;
    if (!root) return;
    let found = false;
    const walk = (node) => {
      if (found || !node) return;
      // ⚠️ **一定要排除 user-agent shadow root。** `<input>`、`<video>` 這些元素
      //    瀏覽器自己就掛了一個；不排除的話**每一頁都會被判成「有 shadow root」**，
      //    於是所有步驟永遠是 unknown——驗證等於整個關掉，而且不會有人發現。
      //    （第一版就是這樣，瀏覽器測試的第一條當場抓到。）
      for (const sr of node.shadowRoots ?? []) {
        if (sr?.shadowRootType && sr.shadowRootType !== 'user-agent') { found = true; return; }
      }
      for (const child of node.children ?? []) walk(child);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    // 寫回去要同時比 docId **與** readyState：掃描期間又導頁的話，這份結論
    // 不屬於現在這份文件；文件退回 loading 代表我們掃的是半成品。
    await value('(window.__toppathDocId === ' + JSON.stringify(before.id)
      + ' && document.readyState !== "loading")'
      + ' ? (window.__toppathShadowChecked = ' + (found ? 'false' : 'true') + ', true) : false');
  } catch (e) {
    /* 維持尚未確認 */
  }
}

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

  /**
   * 事件真正的來源。
   *
   * ⚠️ event.target 在跨出 shadow 邊界時會被**重新指向 host**，所以 document 上的
   *    監聽器看到的是 host、不是裡面那顆按鈕。只看 target 的話，我們會描述 host、
   *    而且 host 通常真的唯一命中——於是這一步被標成 **ok（已驗證）**。
   *    但 host 裡有兩顆以上按鈕時，重播點 host 的中心**不保證落在原本那一顆**，
   *    等於把「不確定」包裝成「已驗證」，而且重播不會報錯。（CodeX 2026-09-18 指出）
   *
   *    composedPath()[0] 拿得到真正的來源；來源不在主 document 樹上就標 unknown。
   */
  const eventSource = (event) => {
    try { return (event.composedPath && event.composedPath()[0]) || event.target; }
    catch { return event.target; }
  };

  /**
   * ⚠️ **closed shadow 連 composedPath() 都看不到**（CodeX 2026-09-18 複驗指出）：
   *    從 document 這一側取路徑時，closed 樹的內部節點不會出現，第一項仍然是 host。
   *    也就是說單靠 composedPath 判斷的話，closed 的情況會走回「host 唯一命中 → ok」
   *    那條老路——跟修之前一模一樣。
   *
   *    可靠的做法是**記下誰有 shadow root**。錄製器是用
   *    Page.addScriptToEvaluateOnNewDocument 注入的，跑在頁面自己的程式碼之前，
   *    所以包得住 attachShadow——open 與 closed 都記得到。
   *
   *    包不住（很舊的瀏覽器、或 attachShadow 被別人先換掉）就寧可回 unknown：
   *    少標一個 ok 只是少一點資訊，錯標一個 ok 會讓人相信一條會點錯的選擇器。
   */
  // 這份文件的身分。host 端查完 shadow 完整性時用它綁定結果——
  // 導頁之後回來的結果屬於上一份文件，不能套到這一份。
  window.__toppathDocId = String(Date.now()) + '-' + String(Math.random()).slice(2, 10);
  // ⚠️ **預設「尚未確認」。** host 端要等 CDP 查完才會把它設成 true；
  //    在那之前一律不宣稱驗過。反過來寫（預設放行、查到問題才擋）的話，
  //    查完之前那個窗口的點擊會被標成已驗證，而且事後不會回頭修正。
  window.__toppathShadowChecked = false;

  const shadowHosts = new WeakSet();
  // ⚠️ 追蹤完整性的**前提**是「我們比這份文件的解析更早」。
  //    readyState 已經不是 loading，代表文件在我們進來之前就開始解析了——
  //    之前建立的 shadow root 我們沒看到，不能宣稱追蹤完整。
  //    （產品端已改成先開 about:blank、注入完才導頁；這裡是那個前提的守門，
  //      哪天有人把啟動順序改回去，症狀會是「全部 unknown」而不是「錯標 ok」。）
  let shadowTrackable = document.readyState === 'loading';
  try {
    const nativeAttachShadow = Element.prototype.attachShadow;
    if (typeof nativeAttachShadow === 'function') {
      const patched = function (init) {
        try { shadowHosts.add(this); } catch (e) { /* 追蹤失敗不能影響頁面 */ }
        return nativeAttachShadow.call(this, init);
      };
      Element.prototype.attachShadow = patched;
      // ⚠️ 一定要**確認真的換上去了**，不能指派完就當成成功。
      //    這段注入的腳本不是嚴格模式：屬性被設成唯讀時，指派會**安靜失敗**、
      //    不拋例外——於是我們會以為在追蹤，其實沒有，而那正是會錯標 ok 的情況。
      shadowTrackable = shadowTrackable && Element.prototype.attachShadow === patched;
    } else {
      shadowTrackable = false;
    }
  } catch (e) { shadowTrackable = false; }

  /**
   * ⚠️ **宣告式 shadow root 從頁面裡根本偵測不到**（CodeX 2026-09-18 指出）：
   *    <template shadowrootmode="closed"> 由 HTML parser 建立，不經過 attachShadow。
   *
   *    我試過三條頁面端的路，全部不行，實測結論記在這裡免得有人再試一遍：
   *      ① MutationObserver 攔 template —— **parser 根本不會把它插進 DOM**
   *         （實測：整份文件的 addedNodes 裡沒有那個 TEMPLATE）
   *      ② el.shadowRoot —— closed 一律 null，跟「沒有 shadow」分不開
   *      ③ el.attachShadow() 探測 —— 已經有 root 時會丟 NotSupportedError（可靠），
   *         **但沒有 root 時它會真的建一個**，等於在受測頁面上動手腳。不能用。
   *
   *    只有 CDP 看得到（DevTools 就是這樣檢視 closed root 的）。所以由 **host 端**
   *    在每次載入完成時查一次，發現這份文件有 shadow root 就設下面這個旗標，
   *    之後這一頁一律不宣稱驗過——見 flagShadowCompleteness()。
   */

  /** 這一下點擊跟 shadow DOM 有沒有關係——有關係就不能宣稱驗過 */
  const fromShadow = (source, described) => {
    // host 端還沒確認過這份文件、或確認的結果是「有追蹤不到的 shadow root」
    if (!window.__toppathShadowChecked) return true;
    if (!shadowTrackable) return true;   // 追蹤不到 → 一律不下判斷
    for (const node of [source, described]) {
      if (!node) continue;
      try {
        // open：來源真的在 shadow 樹裡
        if (node.getRootNode && node.getRootNode() !== document) return true;
        // open／closed：這個元素自己就是 host（closed 時 shadowRoot 是 null，靠 WeakSet）
        if (node.shadowRoot) return true;
        if (shadowHosts.has(node)) return true;
      } catch (e) { return true; }
    }
    return false;
  };

  const describeStep = (el, source) => {
    const target = actionableTarget(el);
    const d = describe(target);
    // 來源在 shadow 裡 → 我們描述的是 host，那條 selector 指不到原本那一顆，
    // 不能宣稱驗過。理由帶 shadow，讓人知道不是「壞了」而是「確認不了」。
    const check = fromShadow(source, target)
      ? { status: 'unknown', reason: 'shadow' }
      : nativeSelectorCheck(d.selector, target);
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
    const d = describeStep(el, eventSource(event));
    if (!d.selector) return;
    send({ name: '點擊 ' + d.selector, action: 'click', ...d });
  }, true);

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!el || !('value' in el)) return;
    if (el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    const d = describeStep(el, eventSource(event));
    if (!d.selector) return;
    // ⚠️ 動作名一定要是 type。伺服器模式的執行引擎沒有 fill 這個動作，
    //    錄成 fill 的腳本在那邊會被當成「不支援的動作」**跳過**，而腳本照樣 PASS。
    send({ name: '輸入 ' + d.selector, action: 'type', ...d, value: String(el.value || '') });
  }, true);
})();
`;
}
