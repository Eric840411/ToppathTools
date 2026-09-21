/**
 * server/uat-runner/backend-recorder.js
 *
 * 後台 UAT 的錄製器：注入頁面，把使用者的操作變成積木，並讓他按住 Alt 點元素
 * 當場標斷言。
 *
 * ## 為什麼一定要有 Alt 這一步
 * 錄製只錄得到「你做了什麼」，錄不到「你在檢查什麼」。點擊、輸入都在事件裡，
 * 但「這欄必須有值」「這兩個數字要相等」是使用者腦子裡的意圖，滑鼠軌跡沒有
 * 這個資訊。只錄動作的話產出是一串點擊、跑起來永遠 PASS——沒有斷言的腳本
 * 不是測試，是重播。
 *
 * ## 選擇器策略階梯（跟 CodeX 討論定案）
 * 後台是 Element UI，class 大量是動態產生的，隨便抓一個 class 一定會脆。
 * 取用順序：
 *   ① data-testid / data-uat / aria-label 這類穩定屬性
 *   ② 表單欄位用 label 關聯
 *   ③ 按鈕／選單用可見文字
 *   ④ 表格儲存格用「欄位名 + 第幾列」而不是純結構路徑
 *   ⑤ 都沒有才用結構路徑
 * 每一步都記下 `selectorStrategy`，退到 ⑤ 的最脆，編輯器會標出來讓人盯。
 *
 * ## 座標是受保護的最後備援
 * selector 完全找不到且錄製／執行 viewport 相符時才使用。表格分頁、資料筆數、側欄
 * 展開仍可能讓座標漂移，因此正常路徑永遠先使用 selector，並在結果裡標明是否曾回退。
 */

import { dangerousRulesSource } from './dangerous-actions.js';
import { selectorLadderSource, elementUiAdapterSource } from './selector-ladder.js';

/** 錄製器把積木用這個前綴印到 console，外面透過 CDP 收 */
export const RECORDER_MARKER = '__TOPPATH_BACKEND_REC__';

/**
 * 頁面裡那顆「停止錄製」按下去時印的前綴，兩個 host（agent-runner／uat-server-recorder）
 * 收到就走各自既有的收尾路徑。
 *
 * ⚠️ **這兩個前綴不能互為前綴。** host 端是用 `text.startsWith(marker)` 判斷的，
 *    若停止前綴長成 `RECORDER_MARKER + '_STOP'`，那 `startsWith(RECORDER_MARKER)`
 *    會先命中，停止訊號會被當成一顆**內容解析不了的積木**——症狀是按了沒反應，
 *    而且 JSON.parse 失敗被 catch 吃掉，兩邊都不會報錯。
 *    `scripts/ui-checks/recorder-stop-marker.mjs` 釘住這條。
 */
export const RECORDER_STOP_MARKER = '__TOPPATH_REC_STOP__';

export function backendRecorderScript(options = {}) {
  return `(() => {
${dangerousRulesSource()}
  if (window.__toppathBackendRecorder) return;
  window.__toppathBackendRecorder = true;

  const MARK = ${JSON.stringify(RECORDER_MARKER)};
  const STOP_MARK = ${JSON.stringify(RECORDER_STOP_MARKER)};
  const CONFIG = ${JSON.stringify(options)};
  const storageKey = 'toppath-recorder-' + (CONFIG.sessionId || 'single');
  let owner = '';
  let paused = false;
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); owner = saved.owner || ''; paused = !!saved.paused; } catch {}
  const saveSelection = () => { try { sessionStorage.setItem(storageKey, JSON.stringify({ owner, paused })); } catch {} };
  // 自動登入那段不能錄——那是為了讓使用者一開始就在已登入的後台，不是他要測的操作，
  // 而且會把帳密寫進積木。server 登入完成後才呼叫 __toppathArmRecorder()。
  window.__toppathRecArmed = false;
  window.__toppathArmRecorder = () => {
    if (window.__toppathRecArmed) return;
    window.__toppathRecArmed = true;
    if (CONFIG.bindings?.length) emit({ action: 'open_page', path: location.pathname + location.search + location.hash });
  };
  /**
   * 自己畫的提示條。
   *
   * ⚠️ **不能用 alert()**：錄製的瀏覽器是 Playwright 控制的，沒註冊 dialog handler
   *    時所有 alert/prompt 會被**自動關掉**——使用者從來沒看過這些提醒。
   *    （「請先選擇所屬 TC」這句就是這樣陰了很久：斷言沒錄到，也沒人知道為什麼。）
   */
  const toast = (text) => {
    try {
      const box = document.createElement('div');
      box.setAttribute('data-toppath-recorder-ui', '1');
      box.textContent = text;
      box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);' +
        'max-width:min(560px,90vw);padding:10px 16px;border-radius:9px;border:1px solid #d99e22;' +
        'background:#3a2a08;color:#ffe9b8;font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;' +
        'box-shadow:0 12px 32px rgba(0,0,0,.5)';
      document.documentElement.appendChild(box);
      setTimeout(() => box.remove(), 4000);
    } catch (e) { /* 提示失敗不能影響錄製 */ }
  };

  const emit = (step) => {
    if (paused || !window.__toppathRecArmed) return;
    const scoped = step.assertion || step.action === 'screenshot';
    if (CONFIG.bindings?.length && scoped) {
      if (!owner) { toast('請先選擇檢查與截圖所屬的 Lark TC，這一項沒有被錄下來'); return; }
      step.tcId = owner;
    }
    try { console.info(MARK, JSON.stringify(step)); return true; } catch { return false; }
  };

  /**
   * 在剛被操作的元素上留一個一次性標記，Node 那邊拿它確認「錄出來的
   * selector 是不是真的指到剛才那一顆」。只留最新一個，不讓它堆在頁面上。
   * data-* 屬性對頁面行為是惰性的；Vue 重繪把它抹掉也無妨，那邊會回報 unknown。
   */
  const markForVerify = (el) => {
    try {
      document.querySelectorAll('[data-toppath-rec-target]').forEach(n => n.removeAttribute('data-toppath-rec-target'));
      const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      el.setAttribute('data-toppath-rec-target', id);
      return id;
    } catch { return ''; }
  };

${selectorLadderSource(elementUiAdapterSource())}

  const viewportInfo = () => ({ width: innerWidth, height: innerHeight });
  let suppressClickUntil = 0;
  const recordedValues = new WeakMap();
  const flushInput = (el) => {
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || /^(checkbox|radio|button|submit)$/i.test(el.type)) return;
    if (el.closest('[data-toppath-recorder-ui]') || paused || !window.__toppathRecArmed) return;
    const value = String(el.value || '');
    if (recordedValues.get(el) === value) return;
    // Untouched controls must not become unexpected fill steps when merely focused/clicked.
    if (!recordedValues.has(el)) return;
    recordedValues.set(el, value);
    const d = describe(el);
    const secret = /password/i.test(el.type) || /pass/i.test(el.name || '') || /pass/i.test(el.id || '');
    emit({ action: 'type_text', selector: d.selector, selectorStrategy: d.strategy, value: secret ? '' : value, ...(secret ? { secret: true } : {}) });
  };
  document.addEventListener('input', event => {
    const el = event.target;
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.closest('[data-toppath-recorder-ui]')) {
      if (!recordedValues.has(el)) recordedValues.set(el, null);
    }
  }, true);
  document.addEventListener('focusout', event => flushInput(event.target), true);
  window.__toppathFlushRecorder = () => flushInput(document.activeElement);

  /**
   * 危險操作守衛（後台錄製端）。
   *
   * 🚨 後台能做的破壞比前台大：補發彩金、處理 Hand Pay、刪設定、停用機台。
   *    錄製時手滑點下去就**真的執行了**，而且後台不會提示你剛剛改了什麼。
   * ⚠️ 要在事件抵達頁面**之前**攔（capture），而且用 stopImmediatePropagation——
   *    只用 stopPropagation 的話，錄製器自己的 click 監聽器還是會把它錄進腳本，
   *    於是「擋得住人、擋不住腳本」，重播時照樣發生。
   * ⚠️ preventDefault 只對 click 下：取消 pointerdown 會讓瀏覽器連 click 都不發。
   */
  const dangerArmed = { key: '', until: 0 };
  const dangerGuard = (event) => {
    if (!window.__toppathRecArmed || !window.__uatDanger) return;
    if (window.__toppathPicking || isMarking(event)) return;
    const el = event.target;
    if (!el || !el.closest || el.closest('[data-toppath-recorder-ui]')) return;
    const node = actionableTarget(el);
    if (!node || node.nodeType !== 1) return;
    const selector = node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : '';
    const verdict = window.__uatDanger.classify({ selector: selector, text: (node.innerText || '').trim().slice(0, 40) });
    if (!verdict || verdict.strength !== 'strong') return;
    const key = selector + '|' + (node.innerText || '').trim().slice(0, 20);
    if (dangerArmed.key === key && Date.now() < dangerArmed.until) return;
    if (event.type === 'click' || event.type === 'dblclick') event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click' && event.type !== 'pointerdown') return;
    const NL = String.fromCharCode(10);
    const yes = window.confirm(verdict.why + NL + NL + '要繼續的話按「確定」，然後再按一次那顆按鈕（15 秒內有效）。' + NL + '按「取消」就什麼都不會發生。');
    if (yes) { dangerArmed.key = key; dangerArmed.until = Date.now() + 15000; }
  };
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'dblclick']) {
    document.addEventListener(type, dangerGuard, true);
  }

  // ── 錄動作 ───────────────────────────────────────────────────────────
  document.addEventListener('click', (event) => {
    if (!window.__toppathRecArmed) return;   // 登入階段不錄
    if (Date.now() < suppressClickUntil) return; // mouseup 後瀏覽器可能再送 click，拖曳不能錄兩次
    // 標記模式或按著 Alt 時，這一下是「標檢查條件」不是「操作」，不要錄成動作
    if (isMarking(event)) return;
    if (event.target && event.target.closest && event.target.closest('[data-toppath-recorder-ui]')) return;
    if (window.__toppathPicking) return;
    const el = actionableTarget(event.target);
    if (!el || el.nodeType !== 1) return;
    flushInput(document.activeElement);
    if (/^(checkbox|radio)$/i.test(el.type || '') || /^(SELECT|OPTION)$/.test(el.tagName)) return;
    if (el.tagName === 'LABEL' && el.querySelector('input[type=\"checkbox\"],input[type=\"radio\"]')) return;
    // ⚠️ Element UI 的勾選框：使用者點的是看得見的 .el-checkbox__inner（一個 span），
    //    真正的 input 藏在同一個 label 裡。那一下會觸發 input 的 change，
    //    所以我們**已經會錄一顆 set_checked**——再錄一顆 click 就是同一件事錄兩次。
    //
    //    而且那顆 click 指向裝飾用的 span，重播時特別脆弱：使用者 2026-09-17 就是卡在
    //    span:nth-of-type(2) 那一步（命中 0），而後面那顆 set_checked 其實就能完成工作。
    //
    //    只排除「裝飾層」：目標本身是真正的控件（button/a/input…）時不能跳過，
    //    否則 label 裡的按鈕會被一起吞掉。（CodeX 2026-09-17 點名要查這件事）
    if (!/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const toggleOwner = el.closest && el.closest('label, .el-checkbox, .el-radio');
      if (toggleOwner && toggleOwner.querySelector('input[type=\"checkbox\"],input[type=\"radio\"]')) return;
    }
    const d = describe(el);
    const verifyId = markForVerify(el);
    emit({
      action: 'click',
      selector: d.selector,
      selectorStrategy: d.strategy,
      // 錄製當下就驗一次這條 selector 能不能命中（不擋錄製）。
      // 沒有這兩個欄位，Node 那邊分不出「選擇器壞了」跟「頁面已經換掉了」。
      verifyId,
      recordedUrl: location.href,
      // selector 找不到時才作備援；runner 會先確認錄製與執行 viewport 相符。
      viewport: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
      x: Math.round(event.clientX), y: Math.round(event.clientY),
      recordedViewport: viewportInfo(),
    });
  }, true);

  // 特殊鍵與數字鍵逐鍵保留。一般文字交給 change 記最終值，避免每打一個字就多一顆積木。
  // 密碼欄位即使是數字也不能寫入 JSON；自動登入發生在 armed 之前，這裡再守一次使用者
  // 操作到其他密碼欄位的情況。
  const RECORDED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  document.addEventListener('keydown', (event) => {
    if (!window.__toppathRecArmed || !RECORDED_KEYS.has(event.key)) return;
    const el = event.target;
    if (!el || el.nodeType !== 1 || (el.closest && el.closest('[data-toppath-recorder-ui]'))) return;
    if (/password/i.test(el.type || '') || /pass/i.test(el.name || '') || /pass/i.test(el.id || '')) return;
    const textInput = /^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable;
    if (textInput && /^[0-9 ]$/.test(event.key)) return;
    if (event.key === 'Enter' || event.key === 'Tab') flushInput(el);
    const d = describe(el);
    emit({ action: 'keypress', key: event.key, selector: d.selector, selectorStrategy: d.strategy });
  }, true);

  // 自製遊戲／元件的拖曳通常不是 HTML5 drag event，因此從滑鼠軌跡判斷。
  // 超過 8px 才成立，普通點擊和手震不會被錄成 drag。
  let dragState = null;
  document.addEventListener('mousedown', (event) => {
    if (!window.__toppathRecArmed || paused || isMarking(event) || event.button !== 0) return;
    const el = event.target;
    if (!el || el.nodeType !== 1 || (el.closest && el.closest('[data-toppath-recorder-ui]'))) return;
    const target = actionableTarget(el);
    const d = describe(target);
    dragState = { selector: d.selector, selectorStrategy: d.strategy,
      from: { x: Math.round(event.clientX), y: Math.round(event.clientY) }, moved: false };
  }, true);
  document.addEventListener('mousemove', (event) => {
    if (!dragState || dragState.moved) return;
    if (Math.hypot(event.clientX - dragState.from.x, event.clientY - dragState.from.y) > 8) dragState.moved = true;
  }, true);
  document.addEventListener('mouseup', (event) => {
    if (!dragState) return;
    const current = dragState;
    dragState = null;
    if (!current.moved || Math.hypot(event.clientX - current.from.x, event.clientY - current.from.y) <= 8) return;
    suppressClickUntil = Date.now() + 100;
    emit({ action: 'drag', selector: current.selector, selectorStrategy: current.selectorStrategy,
      fromX: current.from.x, fromY: current.from.y,
      toX: Math.round(event.clientX), toY: Math.round(event.clientY),
      recordedViewport: viewportInfo() });
  }, true);

  /**
   * 捲動也要錄。
   *
   * 🚨 **為什麼需要**：錄製器以前只錄點擊／輸入／拖曳，所以「錄的時候往下捲了一段才點到」
   *    這件事完全不會被錄下來。重播時畫面停在最上面，那顆按鈕在視窗外——
   *    症狀是「錄的時候好好的，跑起來說找不到元素」，看腳本也看不出少了什麼。
   * ⚠️ **停下來才錄一顆**（300ms 沒有新事件），而且小幅度（40px 內）不錄——
   *    每個 scroll 事件都錄的話，捲一下會產生幾十顆積木。
   * ⚠️ 錄**絕對位置**不錄位移：重播時內容長度不見得一樣。
   */
  let scrollTimer = null;
  let scrollPending = null;
  document.addEventListener('scroll', (event) => {
    if (!window.__toppathRecArmed || window.__toppathPicking) return;
    const node = event.target;
    if (node && node.closest && node.closest('[data-toppath-recorder-ui]')) return;
    const isDoc = !node || node === document || node === document.documentElement || node === document.body;
    const el = isDoc ? (document.scrollingElement || document.documentElement) : node;
    if (!el) return;
    scrollPending = { el: el, top: Math.round(el.scrollTop || 0), isDoc: isDoc };
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const info = scrollPending;
      scrollPending = null;
      if (!info || info.top < 40) return;
      // 容器捲動才需要 selector；整頁捲動留空（執行端會捲整頁）
      const sel = info.isDoc ? '' : (describe(info.el).selector || '');
      emit({ action: 'scroll', value: String(info.top), selector: sel, recordedUrl: location.href });
    }, 300);
  }, true);

  document.addEventListener('contextmenu', (event) => {
    if (!window.__toppathRecArmed || window.__toppathPicking) return;
    if (isMarking(event)) return;
    const el = actionableTarget(event.target);
    if (!el || el.nodeType !== 1) return;
    if (el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    const d = describe(el);
    if (!d || !d.selector) return;
    emit({ action: 'right_click', selector: d.selector, selectorStrategy: d.strategy, recordedUrl: location.href });
  }, true);

  document.addEventListener('change', (event) => {
    if (!window.__toppathRecArmed) return;   // 登入階段不錄
    const el = event.target;
    if (!el || !('value' in el)) return;
    if (el.closest && el.closest('[data-toppath-recorder-ui]')) return;
    if (/^(checkbox|radio)$/i.test(el.type)) {
      const d = describe(el);
      emit({ action: 'set_checked', selector: d.selector, selectorStrategy: d.strategy, checked: el.checked }); return;
    }
    if (el.tagName === 'SELECT') {
      const d = describe(el);
      emit({ action: 'select_option', selector: d.selector, selectorStrategy: d.strategy, value: el.value }); return;
    }
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) { flushInput(el); return; }
    // 密碼欄位絕對不記值。錄製結果會存進 DB、也會顯示在編輯器上，
    // 把真實密碼寫進測試定義等於到處散佈憑證。
    if (/password/i.test(el.type) || /pass/i.test(el.name || '') || /pass/i.test(el.id || '')) {
      const d0 = describe(el);
      emit({ action: 'type_text', selector: d0.selector, selectorStrategy: d0.strategy, value: '', secret: true });
      return;
    }
    const d = describe(el);
    emit({ action: 'type_text', selector: d.selector, selectorStrategy: d.strategy, value: String(el.value || '') });
  }, true);

  // ── 標斷言：Alt／⌥ 或「標記模式」徽章 ────────────────────────────────
  //
  // 一開始只做 Alt。但 Mac 鍵盤上那顆鍵印的是 option／⌥，畫面寫「Alt」會讓人
  // 愣住（使用者實際問過）；而且 Mac 的 Chrome 上 Option+click 點到連結會觸發
  // 「下載連結目標」，跟標記動作打架。
  //
  // 所以改成不依賴修飾鍵也能用：角落一個常駐徽章可以切換「標記模式」，開著的
  // 時候點任何元素都是標斷言。Alt／⌥ 保留成快捷方式。
  let markMode = false;
  /** 目前滑鼠指著哪個元素。提前宣告，避免下面的徽章 handler 讀起來像用在宣告之前 */
  let hover = null;
  const isMarking = (event) => markMode || (event && event.altKey);

  const BADGE = document.createElement('div');
  BADGE.style.cssText = 'position:fixed;z-index:2147483645;right:14px;bottom:54px;padding:9px 13px;' +
    'border-radius:999px;font:600 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none;transition:background .15s,color .15s';
  const paintBadge = () => {
    BADGE.textContent = markMode ? '● 標記模式：開（點元素＝標檢查條件）' : '○ 標記模式：關（點一下開啟）';
    BADGE.style.background = markMode ? '#3fbe8b' : '#1f2937';
    BADGE.style.color = markMode ? '#06281c' : '#cbd5e1';
  };
  BADGE.addEventListener('click', (event) => {
    event.preventDefault(); event.stopPropagation();
    markMode = !markMode;
    paintBadge();
    if (!markMode) { HL.style.display = 'none'; hover = null; }
  }, true);
  // 徽章自己不能被錄成操作，也不能被當成標記目標
  BADGE.setAttribute('data-toppath-recorder-ui', '1');

  const PANEL = document.createElement('div');
  PANEL.setAttribute('data-toppath-recorder-ui', '1');
  PANEL.style.cssText = 'position:fixed;right:14px;bottom:102px;z-index:2147483645;width:320px;max-width:calc(100vw - 28px);padding:12px;background:#101716;color:#e2e8f0;border:1px solid #42566f;border-radius:8px;font:13px system-ui';
  const title = document.createElement('div');
  title.textContent = '檢查與截圖歸屬（操作預設共用）';
  PANEL.appendChild(title);
  const ownerSelect = document.createElement('select');
  ownerSelect.setAttribute('aria-label', '檢查與截圖歸屬');
  ownerSelect.style.cssText = 'width:100%;margin:8px 0;padding:6px;background:#18312f;color:#fff';
  for (const b of [{ recordId: '', number: '', text: '請選擇 TC' }, ...(CONFIG.bindings || [])]) {
    const option = document.createElement('option'); option.value = b.recordId;
    option.textContent = (b.number ? b.number + '｜' : '') + b.text;
    ownerSelect.appendChild(option);
  }
  ownerSelect.value = owner;
  ownerSelect.onchange = () => { flushInput(document.activeElement); owner = ownerSelect.value; saveSelection(); };
  PANEL.appendChild(ownerSelect);
  // 暫停與停止並排。停止刻意做得比暫停搶眼——它是終止整段錄製的動作，
  // 跟「暫停一下」不是同一個量級，長得一樣會被誤按。
  const BUTTON_ROW = document.createElement('div');
  BUTTON_ROW.style.cssText = 'display:flex;gap:8px;margin:2px 0 0';
  const pauseButton = document.createElement('button');
  pauseButton.type = 'button';
  pauseButton.style.cssText = 'flex:1;padding:9px 10px;border:1px solid #42566f;border-radius:6px;' +
    'background:#18312f;color:#cbd5e1;font:600 12px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer';
  const paintPause = () => { pauseButton.textContent = paused ? '繼續錄製' : '暫停錄製'; };
  paintPause();
  pauseButton.onclick = () => { flushInput(document.activeElement); paused = !paused; saveSelection(); paintPause(); };
  BUTTON_ROW.appendChild(pauseButton);

  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.style.cssText = 'flex:1;padding:9px 10px;border:0;border-radius:6px;background:#c0392f;' +
    'color:#fff;font:700 12px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer;' +
    'box-shadow:0 2px 10px rgba(192,57,47,.5)';
  // 提前宣告，免得下面的 handler 讀起來像用在宣告之前（跟 hover 那邊同一個理由）
  const paintStop = () => { stopButton.textContent = '■ 停止錄製'; };
  paintStop();
  let stopping = false;
  stopButton.addEventListener('click', (event) => {
    event.preventDefault(); event.stopPropagation();
    if (stopping) return;
    stopping = true;
    stopButton.disabled = true;
    stopButton.style.opacity = '.65';
    stopButton.style.cursor = 'default';
    stopButton.textContent = '停止中…';
    // ⚠️ 先 flush 再送停止訊號。還停在輸入框、沒離開焦點的內容要先變成積木，
    //    否則「打完字立刻按停止」那一步會直接消失，而且沒有任何徵兆。
    //    host 端收到停止後也會再 flush 一次，flushInput 本身是冪等的（比對
    //    recordedValues），重複呼叫不會產生第二顆 type_text。
    try { flushInput(document.activeElement); } catch (e) { /* flush 失敗不能擋住停止 */ }
    // ⚠️ **刻意不走 emit()。** 它第一行就是 if (paused || !armed) return——
    //    而「暫停中想停止」正是最常見的情境（暫停去做別的事，回來決定不錄了）。
    //    走 emit 的話那個情境會按了完全沒反應。
    try { console.info(STOP_MARK, '1'); } catch (e) { /* 送不出去下面的逾時會提示 */ }
    // 停止成功的話整個瀏覽器會被關掉，這個計時器根本活不到觸發。
    // 會觸發就代表 host 沒收到——最可能是這台 Local Agent 的 agent-runner 還沒更新。
    // 沒有這段的話，舊版 agent 上按下去是**完全的靜默失敗**。
    setTimeout(() => {
      stopping = false;
      stopButton.disabled = false;
      stopButton.style.opacity = '';
      stopButton.style.cursor = 'pointer';
      paintStop();
      toast('停止指令沒有被接受，錄製還在繼續。這台 Local Agent 可能還沒更新程式碼——' +
        '請回主畫面按「停止錄製」，並到 Local Agent 頁面按「更新程式碼」後重新啟動 Agent。');
    }, 5000);
  }, true);
  BUTTON_ROW.appendChild(stopButton);
  PANEL.appendChild(BUTTON_ROW);
  const info = document.createElement('div');
  info.style.cssText = 'margin-top:8px;color:#a9b8b3';
  info.textContent = '用標記模式點選欄位。截圖可重複加入；錄製後可逐步修改歸屬。';
  PANEL.appendChild(info);
  const feedback = document.createElement('div');
  feedback.setAttribute('role', 'status');
  feedback.style.cssText = 'margin-top:8px;color:#7ff0b8';
  PANEL.appendChild(feedback);
  let shotSequence = 0;

  const SHOT = document.createElement('button');
  SHOT.type = 'button';
  SHOT.textContent = '加入截圖指令';
  SHOT.style.cssText = 'position:fixed;z-index:2147483645;right:14px;bottom:14px;padding:8px 12px;' +
    'border:0;border-radius:999px;background:#0f766e;color:#d1fae5;font:600 12px/1 system-ui,-apple-system,sans-serif;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer';
  SHOT.setAttribute('data-toppath-recorder-ui', '1');
  SHOT.addEventListener('click', (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!window.__toppathRecArmed) { feedback.textContent = '尚未開始錄製，請等待登入完成。'; return; }
    if (paused) { feedback.textContent = '目前暫停中，請先按「繼續錄製」再加入截圖。'; return; }
    if (CONFIG.bindings?.length && !owner) { feedback.textContent = '請先選擇截圖所屬 TC。'; return; }
    const name = 'recorded-shot-' + Date.now() + '-' + (++shotSequence);
    if (emit({ action: 'screenshot', name })) feedback.textContent = '已加入截圖指令（' + shotSequence + '）。停止錄製後合併進腳本，試跑時才拍攝圖片。';
  }, true);
  /** 目前開著的選單的關閉函式。同一時間只允許一個——不然點第二個元素時
   *  第一個會留在畫面上（使用者 2026-09-01 回報「點一個就會產生第二個」）。 */
  let closeCurrentPicker = null;

  const HL = document.createElement('div');
  // 刻意**不**標 data-toppath-recorder-ui：HL 是 pointer-events:none，
  // 本來就不可能成為點擊目標，標了沒有實質保護，反而讓
  // browser-test 的 [data-toppath-recorder-ui] 選擇器一次命中兩個元素。
  HL.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3fbe8b;' +
                     'border-radius:3px;background:rgba(63,190,139,.12);display:none';
  /**
   * ⚠️ 這段一定要延後掛，不能直接 appendChild。
   *
   * 這支腳本是用 addInitScript 注入的——它跑在頁面自己的程式碼之前，那個當下
   * document.documentElement 還是 null。直接 appendChild 會拋
   * 「Cannot read properties of null」，而且因為是在最外層拋的，**後面所有程式碼
   * 都不會被執行**——也就是下面那些標斷言的監聽器從來沒被註冊過。
   *
   * 症狀非常隱蔽：一般操作的錄製（click / input）註冊在這一行之前，所以照常運作，
   * 看起來錄得好好的；只有「按住 Alt 標檢查條件」完全沒反應。錄出來的腳本因此
   * 永遠是零斷言——跑起來一定 PASS，那不是測試是重播。
   *
   * 實測才發現（真的開瀏覽器注入一次），單元測試看不出來。
   */
  const mountRecorderUi = () => {
    const root = document.documentElement || document.body;
    if (!root) return false;
    root.appendChild(HL);
    root.appendChild(BADGE);
    root.appendChild(SHOT);
    if (CONFIG.bindings?.length) root.appendChild(PANEL);
    paintBadge();
    return true;
  };
  if (!mountRecorderUi()) {
    document.addEventListener('DOMContentLoaded', mountRecorderUi, { once: true });
  }

  document.addEventListener('mousemove', (event) => {
    if (!isMarking(event)) { HL.style.display = 'none'; hover = null; return; }
    // 徽章本身不當標記目標，不然點它會變成「標記這顆徽章」
    if (event.target && event.target.closest && event.target.closest('[data-toppath-recorder-ui]')) { HL.style.display = 'none'; hover = null; return; }
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === HL) return;
    hover = el;
    const r = el.getBoundingClientRect();
    HL.style.display = 'block';
    HL.style.left = r.left + 'px'; HL.style.top = r.top + 'px';
    HL.style.width = r.width + 'px'; HL.style.height = r.height + 'px';
  }, true);

  function menuItem(label, hint, color) {
    const b = document.createElement('button');
    b.style.cssText = 'display:flex;gap:9px;align-items:stretch;width:100%;padding:8px 9px;border:0;border-radius:6px;' +
                      'background:transparent;color:#e2e8f0;font:inherit;font-size:12px;text-align:left;cursor:pointer';
    b.onmouseenter = () => b.style.background = 'rgba(59,130,246,.16)';
    b.onmouseleave = () => b.style.background = 'transparent';
    b.innerHTML = '<i style="width:3px;border-radius:2px;background:' + color + '"></i>' +
                  '<span><strong style="display:block">' + label + '</strong>' +
                  '<small style="display:block;color:#94a3b8;font-size:11px">' + hint + '</small></span>';
    return b;
  }

  document.addEventListener('click', (event) => {
    if (!isMarking(event)) return;
    if (event.target && event.target.closest && event.target.closest('[data-toppath-recorder-ui]')) return;
    event.preventDefault(); event.stopPropagation();
    const el = hover || event.target;
    if (!el || el.nodeType !== 1) return;

    window.__toppathPicking = true;
    HL.style.display = 'none';
    const d = describe(el);
    const value = (el.innerText || el.value || '').trim().slice(0, 80);

    // 同一時間只留一個選單。少了這行，點第二個元素時第一個會留在畫面上。
    if (closeCurrentPicker) closeCurrentPicker();

    const menu = document.createElement('div');
    // ⚠️ **這一行是關鍵**，不是為了整潔。
    //
    //    上面那兩個守衛都是靠 closest('[data-toppath-recorder-ui]')
    //    判斷「這個點擊是不是打在錄製器自己的 UI 上」。選單少了這個標記，就會被當成
    //    一般頁面元素，於是在「標記模式」開著的時候：
    //
    //      點選單裡的「必須有值」
    //        → document 的 capture 監聽器先跑，判定這是一次「標記」
    //        → 它呼叫 event.stopPropagation()，**選項按鈕自己的 onclick 永遠不會執行**
    //        → 斷言沒送出、舊選單沒關閉
    //        → 同時又對「選單自己的那顆按鈕」開了第二個選單
    //
    //    使用者看到的是「點一個就會產生第二個」，但真正的後果更嚴重：
    //    **標記模式下根本選不了檢查項目，錄出來會是零斷言**——而零斷言的腳本
    //    跑起來一定 PASS，跟 v4.41.0 那次踩到的是同一種假成功。
    //
    //    佐證：使用者截圖裡第二個選單的選擇器是 ... > button > span > small，
    //    正是 menuItem() 自己的 DOM 結構。
    menu.setAttribute('data-toppath-recorder-ui', '1');
    menu.style.cssText = 'position:fixed;z-index:2147483647;width:262px;padding:6px;border:1px solid #42566f;' +
      'border-radius:9px;background:#0a1628;box-shadow:0 16px 40px rgba(0,0,0,.55);' +
      // 先擺在點擊處，掛上去之後再依實際尺寸修正（見下面 getBoundingClientRect 那段）。
      // max-height + overflow 是最後一道：選單比視窗還高時至少捲得到，不會有選項永遠碰不到。
      'font-family:system-ui,sans-serif;box-sizing:border-box;max-height:calc(100vh - 16px);overflow-y:auto;'+
      'left:' + event.clientX + 'px;top:' + event.clientY + 'px';
    const title = document.createElement('h5');
    title.textContent = '要檢查這個元素的什麼？';
    title.style.cssText = 'margin:5px 8px 7px;color:#94a3b8;font-size:11px;font-weight:700';
    menu.appendChild(title);

    let outsideHandler = null;
    const close = () => {
      menu.remove();
      window.__toppathPicking = false;
      // 原本從選項按鈕呼叫 close() 時不會解除這個監聽器，會一直累積殘留
      if (outsideHandler) { document.removeEventListener('click', outsideHandler, true); outsideHandler = null; }
      if (closeCurrentPicker === close) closeCurrentPicker = null;
    };
    closeCurrentPicker = close;

    const options = [
      ['必須有值', '非空就通過。最常用', '#3fbe8b', () => ({ kind: 'filled' })],
      ['等於某個數字', '已帶入目前的值，可以改', '#9a6ac7', () => ({
        ask: { title: '期望值（已帶入目前的值）', value: value },
        build: (v) => ({ kind: 'equals', expect: v }),
      })],
      ['文字必須相等', '自行確認期望文字', '#3fbe8b', () => ({
        ask: { title: '期望文字（請依規格確認，當下畫面不一定正確）', value: value },
        build: (v) => ({ kind: 'text', expect: v }),
      })],
      ['截取這個區域', '保存到目前所屬 TC 的附圖', '#3fbe8b', () => ({ kind: 'screenshot' })],
      ['這個表格要排序正確', '依這一欄遞減', '#3fbe8b', () => ({ kind: 'sorted' })],
      ['不能出現／不能是這個值', '出現就算 FAIL', '#f87171', () => ({ kind: 'absent' })],
      ['這裡要人工看', '機器判不了，不算失敗', '#d99e22', () => ({
        ask: { title: '為什麼要人工看？', value: '需人工確認' },
        build: (v) => ({ kind: 'manual', reason: v }),
      })],
      ['只記下來，不檢查', '存成變數給後面的積木用', '#64748b', () => ({ kind: 'capture' })],
      // 標記上傳欄位。使用者看得到的是按鈕或 + 方塊，真正收檔案的是藏起來的 input，
      // 所以這裡不是記「點到的那個元素」，是從它找出那個 input（findUploadTarget）。
      ['這裡是上傳欄位', '直接產生一顆上傳積木，素材待選', '#4b8bf5', () => {
        const r = findUploadTarget(el);
        // 找不到就當場說清楚並要求重新標記——**不退回結構路徑、不取第一個**，
        // 那會讓圖靜靜傳到別的欄位，報告上完全看不出來。
        if (r.error) return { note: r.error };
        return { kind: 'upload', selector: r.selector, fieldLabel: r.fieldLabel };
      }],
    ];

    /**
     * 把選單內容換成一個輸入面板。
     *
     * ⚠️ 這裡**絕對不能用 prompt()**。錄製的瀏覽器是 Playwright 控制的，
     *    而 Playwright 在沒有註冊 dialog handler 時會**自動關掉所有 alert/prompt**——
     *    prompt() 立刻回 null，使用者連那個框都看不到。
     *    實際後果：「等於某個數字」「文字必須相等」「這裡要人工看」三個選項
     *    **點下去什麼都不會發生**，使用者 2026-09-17 回報的就是這個。
     *    錄製器本來就自己畫選單，輸入框也自己畫就沒有這個依賴。
     */
    const askInMenu = (title, initial, onOk) => {
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      const h = document.createElement('h5');
      h.textContent = title;
      h.style.cssText = 'margin:5px 8px 7px;color:#cbd5e1;font-size:12px;font-weight:700;line-height:1.5';
      const box = document.createElement('input');
      box.type = 'text';
      box.value = initial == null ? '' : String(initial);
      box.style.cssText = 'width:calc(100% - 16px);margin:0 8px;padding:6px 8px;border-radius:6px;' +
        'border:1px solid #42566f;background:#0f2038;color:#e2e8f0;font-size:12px;box-sizing:border-box';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;padding:8px';
      const mk = (text, bg) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = 'padding:5px 12px;border-radius:6px;border:0;cursor:pointer;font-size:12px;background:' + bg + ';color:#06281c';
        return btn;
      };
      const ok = mk('確定', '#3fbe8b');
      const no = mk('取消', '#42566f');
      no.style.color = '#e2e8f0';
      ok.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onOk(box.value); };
      no.onclick = (e) => { e.preventDefault(); e.stopPropagation(); close(); };
      box.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); onOk(box.value); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      };
      row.appendChild(no); row.appendChild(ok);
      menu.appendChild(h); menu.appendChild(box); menu.appendChild(row);
      setTimeout(() => { try { box.focus(); box.select(); } catch (err) {} }, 0);
    };

    /** 找不到上傳欄位這種訊息也不能用 alert()，同樣會被自動關掉 */
    const noteInMenu = (text) => {
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      const h = document.createElement('h5');
      h.textContent = text;
      h.style.cssText = 'margin:8px;color:#f8b4b4;font-size:12px;font-weight:600;line-height:1.6';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;padding:0 8px 8px';
      const btn = document.createElement('button');
      btn.textContent = '知道了';
      btn.style.cssText = 'padding:5px 12px;border-radius:6px;border:0;cursor:pointer;font-size:12px;background:#42566f;color:#e2e8f0';
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); close(); };
      row.appendChild(btn);
      menu.appendChild(h); menu.appendChild(row);
    };

    const submit = (picked) => {
      if (picked && picked.kind === 'upload') {
        // 上傳不是斷言，是一顆操作積木——selector 指的是找到的那個 input，
        // 不是使用者點到的那顆按鈕
        emit({ action: 'upload_file', selector: picked.selector,
               selectorStrategy: 'uploadField', fieldLabel: picked.fieldLabel });
      } else if (picked) {
        emit({ assertion: picked, selector: d.selector, selectorStrategy: d.strategy,
               currentValue: value, label: labelOf(el), column: d.column ?? null });
      }
      close();
    };

    for (const [label, hint, color, make] of options) {
      const b = menuItem(label, hint, color);
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const picked = make();
        if (picked && picked.note) { noteInMenu(picked.note); return; }
        if (picked && picked.ask) { askInMenu(picked.ask.title, picked.ask.value, (v) => submit(picked.build(v))); return; }
        submit(picked);
      };
      menu.appendChild(b);
    }

    const foot = document.createElement('div');
    const weak = d.strategy === 'cssPath';
    foot.style.cssText = 'padding:6px 9px 4px;border-top:1px solid #2d3f55;color:#94a3b8;font-size:11px;word-break:break-all';
    foot.innerHTML = '選擇器（<b style="color:' + (weak ? '#d99e22' : '#3fbe8b') + '">' + d.strategy +
      (weak ? ' · 較脆' : '') + '</b>）：<code>' + d.selector.slice(0, 70) + '</code><br>目前值：<code>' +
      (value || '（空）') + '</code>' + (value ? ' ✓' : ' <b style="color:#d99e22">⚠ 現在是空的</b>');
    menu.appendChild(foot);

    document.documentElement.appendChild(menu);
    // ⚠️ 位置一定要「掛上去、量到真實尺寸」之後再算。
    //    原本是用寫死的 320 去夾（top: min(clientY, innerHeight - 320)），
    //    選單一變長就從下面被裁掉——使用者實際遇到的就是這個：
    //    最後兩個選項（含新加的「這裡是上傳欄位」）整個看不到，等於功能碰不到。
    //    頁面沒有捲軸時特別明顯，因為連捲下去看的機會都沒有。
    var box = menu.getBoundingClientRect();
    var pad = 8;
    var left = Math.max(pad, Math.min(event.clientX, innerWidth - box.width - pad));
    var top = Math.max(pad, Math.min(event.clientY, innerHeight - box.height - pad));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    setTimeout(() => {
      outsideHandler = (ev) => { if (!menu.contains(ev.target)) close(); };
      document.addEventListener('click', outsideHandler, true);
    }, 0);
  }, true);

  /** 抓這個元素旁邊的標籤文字，當作 read_block 的 labels */
  /**
   * 從使用者標記的那個元素找出「真正收檔案的 input」，並產生一個只命中它的選擇器。
   *
   * 為什麼需要這段：使用者看得到的是「Select Video File」那顆按鈕或一個 + 方塊，
   * 真正的 <input type=file> 是藏起來的兄弟節點（Element UI 的 el-upload 就是這樣）。
   *
   * ⚠️ 規則是「**容器邊界**」不是「往上找幾層」（CodeX review）：
   *    往上找到的容器裡**必須剛好只有一個** file input。0 個或 2 個以上一律停下來，
   *    **不准繼續往外擴、不准猜一個**——猜錯的後果是圖靜靜傳到別的欄位，
   *    上傳成功、綠燈、截圖都有，報告上完全看不出來。
   *    五層只是搜尋上限，不是安全保證。
   */
  var UPLOAD_MAX_LEVELS = 5;
  function findUploadTarget(el) {
    // ① 直接點到 input 本身
    var direct = null;
    if (el.tagName === 'INPUT' && el.type === 'file') direct = el;
    // ② label 明確關聯
    if (!direct && el.tagName === 'LABEL') {
      var forId = el.getAttribute('for');
      var byFor = forId ? document.getElementById(forId) : el.querySelector('input[type=file]');
      if (byFor && byFor.tagName === 'INPUT' && byFor.type === 'file') direct = byFor;
    }
    if (direct) {
      var box = direct.closest('.el-upload, .el-form-item, .el-card, td, li') || direct.parentElement;
      return buildUploadSelector(direct, box || direct.parentElement);
    }
    // ③ 往上找容器，第一個「剛好只有一個 file input」的就停
    var node = el;
    for (var i = 0; i < UPLOAD_MAX_LEVELS && node; i++) {
      var found = node.querySelectorAll('input[type=file]');
      if (found.length === 1) return buildUploadSelector(found[0], node);
      if (found.length > 1) {
        return { error: '這個範圍裡有 ' + found.length + ' 個檔案欄位，分不出要傳哪一個。請標記更靠近那個欄位的位置。' };
      }
      node = node.parentElement;
    }
    return { error: '在這個位置附近（往上 ' + UPLOAD_MAX_LEVELS + ' 層）找不到檔案欄位。請直接標記上傳區塊本身。' };
  }

  /**
   * 產生選擇器並**反查確認只命中剛才那一個 input**。
   *
   * ⚠️ 用容器的可見文字圈住它（:has-text），不要用結構路徑——
   *    同一頁的兩塊上傳區結構常常一模一樣（H5 Icon / PC Icon），
   *    結構路徑換個版面就指到另一塊。
   * ⚠️ :has-text 是 Playwright 的語法，瀏覽器裡沒有，所以這裡用等價的
   *    DOM 判斷自己驗一次：符合「同類容器 + 含這段文字 + 含 file input」的
   *    必須剛好一個，而且它的 input 就是剛才找到的那個。
   */
  function buildUploadSelector(input, container) {
    // ⚠️ 找 input 的容器（最內層、剛好只有一個 file input）通常是 .el-upload，
    //    而它的文字只有「+」——用它去圈根本分不出是哪一塊。
    //    所以「找 input」跟「取名字」是兩件事：input 已經定了，這裡只是往外找一層
    //    **文字足以認出它**的祖先。往外找在這裡是安全的，因為最後一定會反查
    //    「這個選擇器是不是只命中剛才那個 input」——認錯就會被擋下來。
    var node = container || input.parentElement;
    for (var level = 0; level < 8 && node && node !== document.body; level++) {
      var base = null;
      if (node.classList) {
        for (var k = 0; k < node.classList.length; k++) {
          var c = node.classList[k];
          if (/^(is-|has-|active|show|open|hover|focus)/.test(c)) continue;
          base = '.' + c; break;
        }
      }
      if (!base) base = node.tagName.toLowerCase();
      var lines = (node.innerText || '').split('\\n').map(function (x) { return x.trim(); }).filter(Boolean);
      for (var t = 0; t < lines.length && t < 3; t++) {
        var text = lines[t];
        // 「+」「×」這種單字元或純符號認不出東西，跳過
        if (text.length < 2 || !/[A-Za-z0-9\u4e00-\u9fff]/.test(text)) continue;
        var same = Array.prototype.filter.call(document.querySelectorAll(base), function (n) {
          return (n.innerText || '').indexOf(text) >= 0 && n.querySelectorAll('input[type=file]').length > 0;
        });
        if (same.length === 1 && same[0].querySelectorAll('input[type=file]')[0] === input) {
          return {
            selector: base + ':has-text("' + text.replace(/"/g, '\\\\"') + '") input[type=file]',
            fieldLabel: text,
          };
        }
      }
      node = node.parentElement;
    }
    return { error: '找不到能唯一認出這個上傳欄位的標題文字。請改標記外面一層（例如含「PC Icon」那張卡）。' };
  }

  function labelOf(el) {
    const own = (el.innerText || '').trim();
    const card = el.closest('.el-card, .el-form-item, td, li') || el.parentElement;
    if (!card) return own.slice(0, 40);
    const text = (card.innerText || '').trim();
    const first = text.split('\\n').map(s => s.trim()).filter(Boolean)[0] || '';
    return (first && first !== own ? first : own).slice(0, 40);
  }
})();`;
}

/**
 * 把錄到的原始事件轉成積木。
 *
 * 錄製器送回來的是「動作」與「斷言標記」兩種，斷言標記要展開成實際的積木——
 * 例如「必須有值」= read_block + assert_filled 兩顆，因為引擎的斷言是對變數做的，
 * 不是直接對選擇器做。
 */
export function eventsToSteps(events) {
  const steps = [];
  let varSeq = 0;
  for (const ev of events ?? []) {
    if (['open_page', 'click', 'type_text', 'keypress', 'drag', 'screenshot', 'set_checked', 'select_option', 'wait', 'upload_file'].includes(ev.action)) {
      steps.push(ev);
      continue;
    }
    if (!ev.assertion) continue;
    const kind = ev.assertion.kind;
    const varName = `v${++varSeq}`;
    const labels = ev.label ? [ev.label] : [];
    const owned = ev.tcId ? { tcId: ev.tcId } : {};
    if (kind === 'screenshot') {
      steps.push({ action: 'screenshot', selector: ev.selector, selectorStrategy: ev.selectorStrategy, name: ev.label || 'region', ...owned }); continue;
    }
    if (kind === 'text') {
      steps.push({ action: 'assert_text', selector: ev.selector, selectorStrategy: ev.selectorStrategy, expect: String(ev.assertion.expect ?? ''), match: 'exact', ...owned });
      continue;
    }

    if (kind === 'filled' || kind === 'equals' || kind === 'capture') {
      steps.push({ action: 'read_block', selector: ev.selector, selectorStrategy: ev.selectorStrategy, labels, as: varName, ...owned });
      if (kind === 'filled') steps.push({ action: 'assert_filled', from: varName, ...owned });
      if (kind === 'equals') steps.push({ action: 'assert_equals', left: `${varName}.${labels[0] ?? 'value'}`, right: String(ev.assertion.expect ?? ''), tolerancePct: ev.tcId ? 0 : 1, ...(ev.tcId ? { absoluteTolerance: 0 } : {}), ...owned });
      continue;
    }
    if (kind === 'sorted') {
      steps.push({ action: 'read_table', selector: 'table', as: varName, ...owned });
      steps.push({ action: 'assert_sorted', from: varName, column: ev.column ?? ev.label ?? '', direction: 'desc', ...owned });
      continue;
    }
    if (kind === 'absent') {
      steps.push({ action: 'assert_absent', selector: ev.selector, text: ev.currentValue || undefined, ...owned });
      continue;
    }
    if (kind === 'manual') {
      steps.push({ action: 'mark_manual', reason: ev.assertion.reason || '需人工確認', ...owned });
      continue;
    }
  }
  return steps;
}

/** 這串積木裡有沒有任何斷言。沒有的話錄出來的東西永遠 PASS，要擋下來問清楚 */
export function hasAssertion(steps) {
  const ASSERTIONS = new Set(['assert_filled', 'assert_equals', 'assert_sorted', 'assert_absent', 'assert_text', 'assert_api_called', 'mark_manual']);
  return (steps ?? []).some(s => ASSERTIONS.has(s.action));
}
