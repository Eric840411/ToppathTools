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
import { PC_HITTEST_SOURCE } from './pc-node-hittest.js';
import { dangerousRulesSource } from './dangerous-actions.js';
import { selectorLadderSource, genericAdapterSource, nativeSelectorCheckSource } from './selector-ladder.js';

/**
 * 錄製器把積木用這個前綴印到 console，兩個 host 都用 `startsWith` 收。
 * ⚠️ 值不能改——舊版 agent 還在用字面量比對。
 */
export const FRONTEND_RECORDER_MARKER = '__TOPPATH_RECORDER__';

/**
 * 頁面內控制面板送回 host 的指令（暫停／繼續／停止）用這個前綴。
 *
 * ⚠️ **刻意跟步驟用不同的 marker。** 共用一個的話，host 要先解析 JSON 才知道
 *    這是不是步驟——而解析失敗的那條路目前是 `catch {}`，一個拼錯的指令會
 *    安靜地變成「什麼都沒發生」。分開之後，收不到指令是收不到，不會被誤當成步驟。
 *
 * ⚠️ 兩個 host 的 `attachCdpCapture({ consoleMarkers })` 都要**加上這個值**，
 *    否則控制指令會被當成「使用者的 console」收進錄製日誌裡洗版。
 */
export const FRONTEND_RECORDER_CONTROL_MARKER = '__TOPPATH_REC_CTL__';

/**
 * host → 頁面：把**權威狀態**推給控制面板。
 *
 * ⚠️ 狀態的唯一真實來源是 host，不是頁面。錄製器每次導頁都會重新注入，
 *    面板整個重建——頁面端自己記的話，「暫停後導頁」會變成
 *    **以為還暫停、其實在錄**，而且畫面上完全看不出來（CodeX 2026-09-18 指定第一版必做）。
 *    所以新文件一律從「尚未同步」開始，收到這支推過來的狀態才允許收錄。
 *
 * @param {(method: string, params?: object) => Promise<any>} send CDP 送訊息的函式
 * @param {{ paused: boolean, steps: number }} state host 端的實際狀態（步數是 host 的清單長度，含 goto）
 */
export async function syncRecorderPanel(send, state) {
  const payload = JSON.stringify({ paused: !!state?.paused, steps: Number(state?.steps) || 0 });
  try {
    await send('Runtime.evaluate', {
      expression: 'window.__toppathRecSync && window.__toppathRecSync(' + JSON.stringify(payload) + ')',
    });
  } catch (e) {
    // 同步不到就讓面板留在「同步中」——**不能退回「錄製中」**。
    // 那個方向的退路等於在不確定的時候宣稱正在錄。
  }
}

/**
 * host → 頁面：截圖前把面板藏起來，截完再放回來。
 *
 * 不藏的話面板會被拍進 baseline 圖片裡，而 baseline 是拿來比對的——
 * 等於把一個只有錄製時才存在的東西寫進比對基準，之後每次執行都對不上。
 */
export async function setRecorderPanelVisible(send, visible) {
  try {
    await send('Runtime.evaluate', {
      expression: 'window.__toppathRecPanelVisible && window.__toppathRecPanelVisible(' + (visible ? 'true' : 'false') + ')',
    });
  } catch (e) { /* 藏不起來不能擋住截圖本身 */ }
}

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

/**
 * 面板的配色與用詞。**在 Node 這一側就挑好再嵌進腳本**，不要把兩套都寫進去用
 * 三元運算子在頁面裡選——那樣普通版的頁面裡照樣找得到修仙版的字串，
 * 「修仙版不能漏到普通版」就變成只有肉眼看得出來、檢查腳本驗不到的規則。
 */
const RECORDER_PANEL_THEMES = {
  normal: {
    bg: '#101716', line: '#42566f', text: '#e2e8f0', dim: '#a9b8b3', quiet: '#18312f',
    accent: '#3fbe8b', danger: '#c0392f', dangerInk: '#ffffff',
    recording: '錄製中', paused: '已暫停', syncing: '同步中',
    pause: '暫停錄製', resume: '繼續錄製', stop: '停止錄製', stopping: '停止中…',
    check: '加檢查', checkOn: '檢查模式：點一下畫面上的東西＝加一顆檢查（不會觸發原本的操作）',
  },
  // 墨黑底、青玉主色、細金線（CodeX 2026-09-18 指定）。停止的字面也由他定。
  xianxia: {
    bg: '#0b0a07', line: '#c8a24a', text: '#e8f6f2', dim: '#9aa8a4', quiet: '#141210',
    accent: '#4fd6c9', danger: '#8c2f2a', dangerInk: '#f8e7df',
    recording: '觀照中', paused: '已暫歇', syncing: '同步中',
    pause: '暫歇觀照', resume: '續行觀照', stop: '收陣（停止）', stopping: '收陣中…',
    check: '立驗印', checkOn: '立印之時：點一物即結一印（不觸動原本之法）',
  },
};

/**
 * @param {{ theme?: 'normal' | 'xianxia' }} [options]
 *        `theme` 只影響**面板自己的配色與用詞**，不影響錄到什麼。
 *        ⚠️ 修仙版的視覺不能漏到普通版：這裡是整份腳本唯一讀 theme 的地方。
 */
/**
 * ⚠️ 這支回傳的是**要注入頁面的整段程式碼字串**，而它包在 template literal 裡——
 *    所以裡面（含註解）**一個反引號都不能有**，否則字串會被提前結束，
 *    錯誤訊息長得像「Unexpected identifier」，完全指不到真正的位置。2026-09-19 踩過一次。
 */
export function frontendRecorderScript(options = {}) {
  const theme = options.theme === 'xianxia' ? 'xianxia' : 'normal';
  return `
(() => {
  if (window.__toppathRecorderInstalled) return;
  window.__toppathRecorderInstalled = true;
${selectorLadderSource(genericAdapterSource())}
${nativeSelectorCheckSource()}
${PC_HITTEST_SOURCE}
${dangerousRulesSource()}

  const MARK = ${JSON.stringify(FRONTEND_RECORDER_MARKER)};
  const CTL = ${JSON.stringify(FRONTEND_RECORDER_CONTROL_MARKER)};

  // ── 控制面板的狀態 ────────────────────────────────────────────────────
  //
  // ⚠️ **權威狀態在 host，不在這裡。** 每份新文件都從「尚未同步」開始，
  //    host 推過來才允許收錄。反過來（預設在錄）的話，「暫停後導頁」會變成
  //    以為還暫停、其實在錄——安靜出錯，畫面上看不出來。
  let synced = false;
  let paused = false;
  /**
   * 檢查模式：點畫面上的東西＝**加一顆斷言**，而且**不觸發原本的操作**。
   *
   * 🚨 CodeX 2026-09-20 的要求：檢查模式的點選不可以把原本的操作也做出去——
   *    不然「想加一顆『Reserve Now 在不在』的檢查」會變成真的去預約機台。
   */
  let checkMode = false;
  /** null＝還不知道。**不要顯示 0**，那是在假裝「一步都沒錄到」 */
  let stepCount = null;

  // ⚠️ 去重只擋「同一下操作被瀏覽器送兩次」，不能擋「使用者真的按了兩次」。
  //    舊的伺服器模式用整段錄製共用的 Set 去重，同一顆按鈕按第二次就**安靜消失**。
  const recent = new Map();
  const send = (step) => {
    // 尚未同步或暫停中一律不送。host 端**也**會擋一次——兩道都要有：
    // 這一道擋得住「頁面知道自己暫停」，host 那道擋得住「頁面還沒收到狀態」。
    if (!synced || paused) return;
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

  // ── 控制面板 ────────────────────────────────────────────────────────────
  //
  // 版面由 CodeX 定（2026-09-18）：H5／PC 共用一個窄浮動面板，右上、預設收合、
  // **停止永遠露出**（收合狀態也按得到，不必先展開）。
  //
  // 第一版刻意**沒有**兩樣東西：
  //   - 「TC 歸屬」——那是 Backend 的 Lark TC 綁定，H5/PC 錄的是腳本，這個概念不存在
  //   - 「加入截圖」——存 baseline 需要 scriptId，主畫面現在不會下發；
  //     為了填版面先塞一個預設值，等於做一顆按了會靜默失敗的按鈕
  const T = ${JSON.stringify(RECORDER_PANEL_THEMES[theme])};
  const FONT = '600 12px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif';
  const svg = (paths, size) => '<svg viewBox="0 0 16 16" width="' + (size || 13) + '" height="' + (size || 13)
    + '" fill="currentColor" aria-hidden="true" focusable="false">' + paths + '</svg>';
  const ICON = {
    // 刻意用 SVG 不用 emoji：emoji 在不同平台會變成完全不同的圖，而且遊戲頁的
    // 字型不一定含那些碼位，會掉成豆腐方塊。
    grip: svg('<circle cx="6" cy="4" r="1.3"/><circle cx="10" cy="4" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="12" r="1.3"/><circle cx="10" cy="12" r="1.3"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1"/>'),
    pause: svg('<rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/>'),
    play: svg('<path d="M5 3.5l7 4.5-7 4.5z"/>'),
    down: svg('<path d="M4 6l4 4 4-4z"/>', 12),
    up: svg('<path d="M4 10l4-4 4 4z"/>', 12),
  };

  /** 送指令回 host。console.info 是這條線唯一的上行通道（錄製端沒有 page 物件） */
  const control = (cmd) => { try { console.info(CTL, JSON.stringify({ cmd: cmd })); } catch (e) { /* 下面的逾時會提示 */ } };

  let expanded = false;
  /** 送出後還沒被 host 確認的指令。⚠️ 確認之前不能顯示成已完成，也不能重複送 */
  let awaiting = null;
  let awaitTimer = null;
  let hint = '';
  let WRAP = null, BAR = null, STATUS = null, BAR_STOP = null, TOGGLE = null,
      BODY = null, PAUSE = null, CHECK = null, STOP = null, HINT = null;
  /**
   * 把面板夾回可視範圍。mount() 裡才裝得起來（要拿得到 WRAP 的尺寸）。
   *
   * ⚠️ **面板變高之後一定要重算**（CodeX 2026-09-18 覆核指出）：拖到視窗底部再展開，
   *    或逾時提示跳出來讓面板長高，下半截就會跑到畫面外——而展開時收合列那顆停止
   *    是藏起來的，**等於停止鈕整個按不到**。
   */
  let reposition = () => {};

  const stateText = () => {
    if (awaiting === 'stop') return T.stopping;
    if (!synced) return T.syncing;
    return paused ? T.paused : T.recording;
  };
  const countText = () => (stepCount === null ? '—' : String(stepCount) + ' 步');
  const dotColor = () => (!synced ? T.dim : paused ? '#d9a441' : T.accent);

  const paint = () => {
    if (!WRAP) return;
    STATUS.innerHTML = '<i style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;'
      + 'vertical-align:middle;background:' + dotColor() + '"></i>'
      + '<span style="vertical-align:middle">' + stateText() + ' · ' + countText() + '</span>';
    TOGGLE.innerHTML = expanded ? ICON.up : ICON.down;
    TOGGLE.setAttribute('aria-label', expanded ? '收合' : '展開');
    TOGGLE.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    BODY.style.display = expanded ? 'block' : 'none';
    // 收合時列上那顆停止才露出——展開時下面已經有一顆完整的，
    // 同時出現兩顆一模一樣的停止只會讓人猶豫該按哪個。
    BAR_STOP.style.display = expanded ? 'none' : 'inline-flex';
    PAUSE.innerHTML = (paused ? ICON.play : ICON.pause) + '<span style="margin-left:7px">'
      + (paused ? T.resume : T.pause) + '</span>';
    PAUSE.setAttribute('aria-label', paused ? T.resume : T.pause);
    // 暫停要等狀態同步才按得動（不知道現在是暫停還是在錄，就不知道該送哪個指令）。
    // **停止不等**——同步不到本來就是想離開的理由之一，那時把唯一的出口鎖上最糟。
    for (const [button, dead] of [[PAUSE, !synced || !!awaiting], [STOP, !!awaiting], [BAR_STOP, !!awaiting]]) {
      button.disabled = dead;
      button.style.opacity = dead ? '.55' : '1';
      button.style.cursor = dead ? 'default' : 'pointer';
    }
    CHECK.innerHTML = '<span>' + (checkMode ? '● ' : '') + T.check + '</span>';
    CHECK.setAttribute('aria-pressed', checkMode ? 'true' : 'false');
    CHECK.style.borderColor = checkMode ? T.accent : T.line;
    HINT.textContent = hint;
    HINT.style.display = hint ? 'block' : 'none';
    // 展開／收合與提示的出現都會改變高度，所以每次重畫完都夾一次。
    reposition();
  };

  const clearAwait = () => {
    if (awaitTimer) { clearTimeout(awaitTimer); awaitTimer = null; }
    awaiting = null;
  };

  const startAwait = (cmd) => {
    awaiting = cmd;
    hint = '';
    if (awaitTimer) clearTimeout(awaitTimer);
    // ⚠️ 逾時要顯示「未確認」，不能顯示「已完成」。停止沒被接受時錄製其實還在跑，
    //    而畫面若寫「已停止」，使用者會直接走人，留下一顆開著的瀏覽器跟一段還在錄的 session。
    awaitTimer = setTimeout(() => {
      awaitTimer = null;
      awaiting = null;
      hint = cmd === 'stop'
        ? '停止沒有得到確認，錄製可能還在繼續——請回主畫面停止這一輪。'
        : '這個指令沒有得到確認，狀態以主畫面為準。';
      // ⚠️ 提示放在展開區裡，收合著就看不到。**出事的時候要自己打開**——
      //    否則「停止沒生效」這件事會完全沒有徵兆，使用者以為停了就走人。
      expanded = true;
      paint();
    }, 5000);
    paint();
  };

  /**
   * host 推狀態進來。**這是面板唯一能離開「同步中」的路。**
   * 回傳 true／false 讓 host 端的測試看得出來有沒有被接住。
   */
  /**
   * 檢查模式的程式介面（測試用；面板上的按鈕走的是同一條路）。
   * 回傳切換後的狀態，讓呼叫端**看得出來有沒有真的切到**——
   * 測試若只是「按下去然後假設有效」，模式沒開時會表現成「斷言一顆都沒錄到」，
   * 看起來像功能壞了，其實是測試自己沒開。
   */
  window.__toppathRecSetCheck = (on) => {
    checkMode = !!on;
    hint = checkMode ? T.checkOn : '';
    paint();
    return checkMode;
  };

  window.__toppathRecSync = (raw) => {
    let next = null;
    try { next = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return false; }
    if (!next || typeof next !== 'object') return false;
    synced = true;
    paused = !!next.paused;
    if (typeof next.steps === 'number') stepCount = next.steps;
    // 送出的指令被實現了才算確認。收到的狀態跟要求的相反時**不清掉 awaiting**，
    // 讓逾時那條去處理——否則會把「host 還沒處理」誤報成「已完成」。
    if (awaiting === 'pause' && paused) { clearAwait(); hint = ''; }
    if (awaiting === 'resume' && !paused) { clearAwait(); hint = ''; }
    paint();
    return true;
  };

  /** host 截圖前後呼叫：面板不能被拍進 baseline 圖片裡 */
  window.__toppathRecPanelVisible = (visible) => {
    if (!WRAP) return false;
    WRAP.style.visibility = visible ? 'visible' : 'hidden';
    return true;
  };

  const POS_KEY = '__toppath_rec_panel_pos';
  const readPos = () => {
    try { return JSON.parse(sessionStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; }
  };
  const writePos = (pos) => {
    try { sessionStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* 換網域就沒了，純裝飾 */ }
  };

  const button = (kind) => {
    const b = document.createElement('button');
    b.type = 'button';
    const base = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;'
      + 'min-height:44px;border-radius:7px;font:' + FONT + ';padding:0 12px;';
    if (kind === 'danger') {
      b.style.cssText = base + 'width:100%;border:0;background:' + T.danger + ';color:' + T.dangerInk + ';'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.35)';
    } else if (kind === 'bar') {
      b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;'
        + 'width:34px;height:34px;padding:0;border:0;border-radius:6px;background:' + T.danger + ';color:' + T.dangerInk;
    } else if (kind === 'ghost') {
      b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;'
        + 'width:34px;height:34px;padding:0;border:0;border-radius:6px;background:transparent;color:' + T.dim;
    } else {
      b.style.cssText = base + 'width:100%;border:1px solid ' + T.line + ';background:' + T.quiet + ';color:' + T.text;
    }
    return b;
  };

  const mount = () => {
    if (WRAP || !document.body) return;
    WRAP = document.createElement('div');
    WRAP.setAttribute('data-toppath-recorder-ui', '1');
    WRAP.setAttribute('role', 'region');
    WRAP.setAttribute('aria-label', '錄製控制');
    WRAP.style.cssText = 'position:fixed;top:12px;right:12px;left:auto;z-index:2147483644;width:240px;'
      + 'max-width:calc(100vw - 24px);box-sizing:border-box;border:1px solid ' + T.line + ';border-radius:10px;'
      + 'background:' + T.bg + ';color:' + T.text + ';font:' + FONT + ';box-shadow:0 8px 26px rgba(0,0,0,.45);'
      + 'user-select:none;-webkit-user-select:none;touch-action:none';

    BAR = document.createElement('div');
    BAR.style.cssText = 'display:flex;align-items:center;gap:6px;height:44px;padding:0 6px 0 4px;box-sizing:border-box';
    const GRIP = document.createElement('div');
    GRIP.innerHTML = ICON.grip;
    GRIP.setAttribute('aria-hidden', 'true');
    GRIP.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:22px;height:34px;'
      + 'color:' + T.dim + ';cursor:grab;flex:none';
    STATUS = document.createElement('div');
    STATUS.setAttribute('role', 'status');
    STATUS.style.cssText = 'flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:' + T.text;
    BAR_STOP = button('bar');
    BAR_STOP.innerHTML = ICON.stop;
    BAR_STOP.setAttribute('aria-label', T.stop);
    BAR_STOP.title = T.stop;
    // ⚠️ 用 data 屬性標識別，不要讓測試靠文字抓——這幾顆按鈕的文字會隨狀態改變，
    //    靠文字抓的測試會在**自己按下去之後突然找不到那顆按鈕**
    //    （Backend 那支踩過，見 docs/features/24-27-uat.md）。
    //    ⚠️ 這段註解也會被嵌進頁面，所以裡面不要寫出任一主題的實際字面，
    //    否則主題隔離的檢查會紅——它比對的是整份腳本的內容。
    BAR_STOP.setAttribute('data-toppath-rec-btn', 'bar-stop');
    TOGGLE = button('ghost');
    TOGGLE.setAttribute('data-toppath-rec-btn', 'toggle');
    BAR.appendChild(GRIP); BAR.appendChild(STATUS); BAR.appendChild(BAR_STOP); BAR.appendChild(TOGGLE);

    BODY = document.createElement('div');
    BODY.style.cssText = 'display:none;padding:0 10px 10px;box-sizing:border-box';
    PAUSE = button('quiet');
    PAUSE.setAttribute('data-toppath-rec-btn', 'pause');
    CHECK = button('quiet');
    CHECK.setAttribute('data-toppath-rec-btn', 'check');
    CHECK.addEventListener('click', () => {
      checkMode = !checkMode;
      hint = checkMode ? T.checkOn : '';
      paint();
    });
    STOP = button('danger');
    STOP.setAttribute('data-toppath-rec-btn', 'stop');
    STOP.innerHTML = ICON.stop + '<span style="margin-left:7px">' + T.stop + '</span>';
    const gap = document.createElement('div');
    gap.style.cssText = 'height:8px';
    HINT = document.createElement('div');
    HINT.setAttribute('role', 'alert');
    HINT.style.cssText = 'display:none;margin-top:8px;color:#f3c98b;font:500 11px/1.5 system-ui,-apple-system,sans-serif;white-space:normal';
    const gap2 = document.createElement('div');
    gap2.style.cssText = 'height:8px';
    BODY.appendChild(PAUSE); BODY.appendChild(gap2); BODY.appendChild(CHECK);
    BODY.appendChild(gap); BODY.appendChild(STOP); BODY.appendChild(HINT);

    WRAP.appendChild(BAR); WRAP.appendChild(BODY);
    document.body.appendChild(WRAP);

    const pos = readPos();
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      WRAP.style.left = pos.left + 'px';
      WRAP.style.top = pos.top + 'px';
      WRAP.style.right = 'auto';
    }
    if (pos && pos.expanded) expanded = true;

    TOGGLE.addEventListener('click', () => {
      expanded = !expanded;
      const current = readPos() || {};
      current.expanded = expanded;
      writePos(current);
      paint();
    });
    PAUSE.addEventListener('click', () => {
      if (!synced || awaiting) return;
      const cmd = paused ? 'resume' : 'pause';
      startAwait(cmd);
      control(cmd);
    });
    const doStop = () => {
      if (awaiting) return;
      startAwait('stop');
      control('stop');
    };
    STOP.addEventListener('click', doStop);
    BAR_STOP.addEventListener('click', doStop);

    // ── 拖曳 ───────────────────────────────────────────────────────────
    // 放開時貼最近的左右邊，並夾回可視範圍——縮放或轉向之後面板會跑到畫面外，
    // 那時停止鈕就按不到了。
    let dragging = false, dx = 0, dy = 0;
    const clampAndSnap = (snap) => {
      const rect = WRAP.getBoundingClientRect();
      let left = rect.left, top = rect.top;
      if (snap) left = (rect.left + rect.width / 2) < window.innerWidth / 2 ? 12 : window.innerWidth - rect.width - 12;
      left = Math.max(6, Math.min(left, window.innerWidth - rect.width - 6));
      top = Math.max(6, Math.min(top, window.innerHeight - rect.height - 6));
      WRAP.style.left = left + 'px';
      WRAP.style.top = top + 'px';
      WRAP.style.right = 'auto';
      if (snap) writePos({ left: left, top: top, expanded: expanded });
    };
    GRIP.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dragging = true;
      const rect = WRAP.getBoundingClientRect();
      dx = event.clientX - rect.left;
      dy = event.clientY - rect.top;
      GRIP.style.cursor = 'grabbing';
      try { GRIP.setPointerCapture(event.pointerId); } catch (e) { /* 舊瀏覽器沒有也無妨 */ }
    });
    GRIP.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      event.preventDefault();
      WRAP.style.left = (event.clientX - dx) + 'px';
      WRAP.style.top = (event.clientY - dy) + 'px';
      WRAP.style.right = 'auto';
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      GRIP.style.cursor = 'grab';
      clampAndSnap(true);
    };
    GRIP.addEventListener('pointerup', endDrag);
    GRIP.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => clampAndSnap(false));
    // 面板變高（展開、或逾時提示跳出來）之後也要夾一次，理由見 reposition 的宣告。
    // ⚠️ 拖曳途中不要夾——那會在手指還按著的時候把面板拉走。
    // ⚠️ 只有**真的出界**才動。無條件夾的話，還沒被拖過的面板會在第一次重畫時
    //    從「貼右邊」變成固定的 left 座標，之後把視窗拉寬它就不跟著右邊走了。
    reposition = () => {
      if (dragging) return;
      const rect = WRAP.getBoundingClientRect();
      const outside = rect.left < 6 || rect.top < 6
        || rect.right > window.innerWidth - 6 || rect.bottom > window.innerHeight - 6;
      if (outside) clampAndSnap(false);
    };

    // ⚠️ 面板上的操作不能傳給遊戲。
    //
    // **一定要掛在冒泡階段（第三個參數 false），不能掛捕獲。** 捕獲階段的
    // stopPropagation 發生在事件抵達目標之前——連面板自己的按鈕都收不到事件，
    // 症狀是「按了完全沒反應、也不報錯」（第一版就是這樣，⑩f 當場抓到）。
    //
    // 擋得住的：掛在面板底下的元素、以及所有冒泡階段的監聽器。
    // 擋不住的：掛在 document／window **捕獲階段**的監聽器——它們在事件抵達面板
    // 之前就跑完了，從面板內部攔不到。所以這不是完整隔離，只是把最常見的擋掉。
    // （我們自己的錄製監聽器就是 document 捕獲階段，靠 data-toppath-recorder-ui 排除。）
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
                        'touchstart', 'touchend', 'keydown', 'keyup', 'wheel', 'contextmenu']) {
      WRAP.addEventListener(type, (event) => { event.stopPropagation(); }, false);
    }
    paint();
  };

  if (document.body) mount();
  // ⚠️ 注入跑在頁面程式碼之前，那個當下 document.body 還是 null。
  //    直接 appendChild 會在最外層拋例外，**後面所有程式碼都不會執行**——
  //    症狀是「面板沒出現，而且連錄製也停了」。Backend 那支踩過同一個坑。
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /**
   * 危險操作守衛（錄製端）。
   *
   * 🚨 **要在動作發生之前攔**（CodeX 2026-09-20）。錄製的時候手滑按到 Reserve Now，
   *    機台就真的被鎖 24 小時了——事後在腳本裡把那一步刪掉也救不回來，
   *    而且畫面上看不出剛剛發生過什麼。所以第一下**擋下來**問清楚。
   *
   * ⚠️ 要攔的不只 click：Vue 的 handler 可能掛在 mousedown、Cocos 聽的是 pointer 事件。
   *    只擋 click 的話，畫面上「按鈕有反應但沒錄到」——比沒擋更難查。
   * ⚠️ 確認之後**不幫使用者補一下點擊**：合成事件 Cocos 不見得吃，
   *    而「以為按下去了其實沒有」比多按一次糟。改成開一個 15 秒的放行窗，請他再按一次。
   */
  const dangerArmed = { key: '', until: 0 };
  const dangerKeyOf = (event) => {
    const el = event.target;
    if (!el || !el.closest) return null;
    if (el.closest('[data-toppath-recorder-ui]')) return null;
    const canvas = canvasOf(el);
    if (canvas) {
      let node = null;
      try { node = window.__uatPcHit ? window.__uatPcHit.at(Math.round(event.clientX), Math.round(event.clientY)) : null; } catch (e) { node = null; }
      if (!node) return null;
      return { key: node.id || node.name, what: { node: node.id || node.name, text: node.label } };
    }
    const d = describeStep(el, eventSource(event));
    if (!d.selector) return null;
    return { key: d.selector, what: { selector: d.selector, text: (el.textContent || '').trim().slice(0, 40) } };
  };
  /**
   * 檢查模式的攔截。**擋在所有事件之前**：DOM 那邊 Vue 可能掛在 mousedown、
   * Cocos 聽的是 pointer 事件，只擋 click 的話畫面照樣有反應。
   */
  const checkGuard = (event) => {
    if (!checkMode || !synced || paused || window.__toppathCropping) return;
    const el = event.target;
    if (el && el.closest && el.closest('[data-toppath-recorder-ui]')) return;   /* 面板自己不算 */
    /**
     * 🚨 **preventDefault 只能對 click 下**，不能對 pointerdown／mousedown 下。
     *    取消 pointerdown 會讓瀏覽器**連後面的 click 都不發**——實測症狀是
     *    「原本的操作確實沒發生（看起來對了），但斷言也一顆都沒錄到」，
     *    而且畫面上完全看不出差別。擋住頁面用 stopImmediatePropagation 就夠了。
     * 🚨 一定要用 stopImmediatePropagation：一般的 stopPropagation **擋不住同一個
     *    節點上的其他監聽器**，而錄製器自己的 click 監聽器就掛在 document 上。
     *    只用 stopPropagation 的話，檢查模式會同時錄下一顆「點擊」——
     *    那顆點擊重播時會真的點下去，而錄的當下畫面根本沒反應，完全對不起來。
     */
    if (event.type === 'click' || event.type === 'dblclick') event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;   /* 一次操作只加一顆 */
    const canvas = canvasOf(el);
    if (canvas) {
      let node = null;
      try { node = window.__uatPcHit ? window.__uatPcHit.at(Math.round(event.clientX), Math.round(event.clientY)) : null; } catch (e) { node = null; }
      if (!node || !node.id) { hint = '這個位置反查不到節點，改點按鈕本體試試'; paint(); return; }
      send({ name: '檢查：' + (node.label || node.name) + ' 在', action: 'assert_pc_node', value: node.id });
      hint = '已加一顆檢查：' + (node.label || node.name);
      paint();
      return;
    }
    const d = describeStep(el, eventSource(event));
    if (!d.selector) { hint = '這個元素給不出可靠的選擇器，換一個更明確的目標'; paint(); return; }
    const assertion = { name: '檢查：' + d.selector + ' 可見', action: 'assert_visible' };
    for (const k in d) assertion[k] = d[k];
    send(assertion);
    hint = '已加一顆檢查：' + d.selector;
    paint();
  };
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'touchstart', 'touchend', 'dblclick']) {
    document.addEventListener(type, checkGuard, true);
  }

  const dangerGuard = (event) => {
    if (checkMode) return;   /* 檢查模式下沒有任何操作會發生，不用再問危不危險 */
    if (!synced || paused || window.__toppathCropping) return;
    if (!window.__uatDanger) return;
    const info = dangerKeyOf(event);
    if (!info) return;
    const verdict = window.__uatDanger.classify(info.what);
    /* 只有文字命中（weak）不擋——字會翻譯也會改版，拿它當唯一依據會擋到無害的東西 */
    if (!verdict || verdict.strength !== 'strong') return;
    if (dangerArmed.key === info.key && Date.now() < dangerArmed.until) return;
    /* 同檢查模式：preventDefault 只對 click 下（取消 pointerdown 會連 click 都不發），
       而且一定要 stopImmediatePropagation——否則被擋下來的危險操作**還是會被錄進腳本**，
       重播時它就真的發生了，擋得住人擋不住腳本，等於沒擋。 */
    if (event.type === 'click' || event.type === 'dblclick') event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click' && event.type !== 'pointerdown') return;   /* 一次操作只問一次 */
    /* ⚠️ 這段字串在**樣板字串裡**，不能寫 
 之類的跳脫——會被外層先解釋掉，
       把字串切斷（症狀是整個注入腳本語法錯）。要換行請用 String.fromCharCode(10)。 */
    const NL = String.fromCharCode(10);
    const yes = window.confirm(verdict.why + NL + NL + '要繼續的話按「確定」，然後再按一次那顆按鈕（15 秒內有效）。' + NL + '按「取消」就什麼都不會發生。');
    if (yes) { dangerArmed.key = info.key; dangerArmed.until = Date.now() + 15000; hint = '已放行 15 秒，請再按一次'; }
    else { hint = '已擋下一個危險操作'; }
    paint();
  };
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'touchstart', 'touchend']) {
    document.addEventListener(type, dangerGuard, true);
  }

  document.addEventListener('click', (event) => {
    if (window.__toppathCropping) return;
    const el = event.target;
    if (el && el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    const canvas = canvasOf(el);
    if (canvas) {
      const x = Math.round(event.clientX);
      const y = Math.round(event.clientY);
      /**
       * PC(Cocos)：先試著反查成**節點**，查得到就錄節點而不是座標。
       *
       * 🚨 座標腳本的問題不是跑不動，是**跑起來不會錯**：視窗一改尺寸、清單捲過、
       *    有彈窗擋住，點擊照樣送出去，只是點在別的東西上，畫面沒有異狀、報告全綠。
       * ⚠️ 反查不到、或反查得到但**給不出唯一識別字**時，**照舊錄座標**——
       *    硬給一個會點到隔壁那顆的名字，比座標更糟。
       */
      let node = null;
      try { node = window.__uatPcHit ? window.__uatPcHit.at(x, y) : null; } catch (e) { node = null; }
      if (node && node.id) {
        const step = {
          name: '點 ' + (node.label || node.name) + (node.nameUnique ? '' : '（同名節點多顆，用路徑）'),
          action: 'pc_click_node', value: node.id,
          // 座標留著純粹當診斷：執行時用的是節點，不是這組數字
          x: x, y: y,
        };
        // 剛剛在守衛那裡明確同意過，就把同意記在積木上——不然每次重播都會停下來問
        if (dangerArmed.key === (node.id || node.name) && Date.now() < dangerArmed.until) step.allowDangerous = true;
        send(step);
        return;
      }
      // ⚠️ 用 viewport 座標，因為兩個執行引擎的 click_viewport 都是 page.mouse.click(x, y)。
      //    改成 canvas 相對座標的話，canvas 不在左上角時會整個偏掉。
      send({ name: '點擊畫面 (' + x + ', ' + y + ')', action: 'click_viewport', x, y });
      return;
    }
    const d = describeStep(el, eventSource(event));
    if (!d.selector) return;
    const domStep = { name: '點擊 ' + d.selector, action: 'click' };
    for (const k in d) domStep[k] = d[k];
    if (dangerArmed.key === d.selector && Date.now() < dangerArmed.until) domStep.allowDangerous = true;
    send(domStep);
  }, true);

  /**
   * 捲動也要錄。
   *
   * 🚨 **為什麼需要**：錄製器原本只聽 click 與 change，所以「錄的時候往下捲了一段才點到」
   *    這件事**完全不會被錄下來**。重播時畫面停在最上面，那顆按鈕在視窗外——
   *    症狀是「錄的時候好好的，跑起來說找不到元素」，而且看腳本完全看不出少了什麼。
   *    （.footer-top 這種更狠：它**捲下去才存在**，沒捲的話連元素都沒有。）
   *
   * ⚠️ **停下來才錄一顆**（300ms 沒有新的 scroll 事件）。每個 scroll 事件都錄的話，
   *    捲一下會產生幾十顆積木，腳本直接不能看。
   * ⚠️ **錄絕對位置**（to:N）不錄位移：重播時內容長度不見得一樣，相對位移會落在別的地方。
   * ⚠️ 小幅度（40px 以內）不錄——那多半是慣性回彈或點擊造成的微調，不是使用者真的在捲。
   */
  let scrollTimer = null;
  const lastScroll = new WeakMap();
  /** 這一輪捲動期間，哪些容器動過（元素 → 當下的 scrollTop） */
  let pending = new Map();
  document.addEventListener('scroll', (event) => {
    if (window.__toppathCropping) return;
    const node = event.target;
    // 錄製器自己的面板在捲不算
    if (node && node.closest && node.closest('[data-toppath-recorder-ui]')) return;
    const isDoc = !node || node === document || node === document.documentElement || node === document.body;
    const el = isDoc ? (document.scrollingElement || document.documentElement) : node;
    if (!el) return;
    pending.set(el, Math.round(el.scrollTop || 0));
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      /**
       * 🚨 **不能「最後一個發事件的就是它」。**
       *    一次滑動會有好幾個容器跟著發 scroll 事件（巢狀的、回彈的），
       *    只取最後一個的話會錄到一個根本沒動的容器——實測第一版就錄成
       *    to:0 ＋ 一長串 nth-of-type 的選擇器，重播當然什麼也不會發生。
       *    改成：這一輪裡**位移最大**的那個才是使用者真的在捲的東西。
       */
      let best = null; let bestDelta = 0; let bestTop = 0;
      pending.forEach((top, node2) => {
        const prev = lastScroll.get(node2);
        const delta = Math.abs(top - (prev === undefined ? 0 : prev));
        if (delta > bestDelta) { best = node2; bestDelta = delta; bestTop = top; }
      });
      pending.forEach((top, node2) => lastScroll.set(node2, top));
      pending = new Map();
      // 小幅度不錄——那多半是慣性回彈或點擊造成的微調，不是使用者真的在捲
      if (!best || bestDelta < 40) return;
      /**
       * ⚠️ **沒有 class 的容器不要寫選擇器。**
       *    describeStep 會退回 div:nth-of-type(3) > div … 這種位置式選擇器，
       *    那個東西換個版本就指到別的地方。寧可不寫——執行時 scroll 積木
       *    會自己找「真的捲得動」的那個容器，反而穩。
       */
      var cls = (best.className && best.className.toString) ? best.className.toString().trim() : '';
      var sel = '';
      if (cls) {
        var first = cls.split(/\s+/)[0];
        if (first && document.querySelectorAll('.' + first).length === 1) sel = '.' + first;
      }
      send({
        name: '捲動 ' + (sel || '頁面') + ' 到 ' + bestTop,
        action: 'scroll',
        value: 'to:' + bestTop,
        ...(sel ? { selector: sel } : {}),
      });
    }, 300);
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
