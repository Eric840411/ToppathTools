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

/** 錄製器把積木用這個前綴印到 console，外面透過 CDP 收 */
export const RECORDER_MARKER = '__TOPPATH_BACKEND_REC__';

export function backendRecorderScript(options = {}) {
  return `(() => {
  if (window.__toppathBackendRecorder) return;
  window.__toppathBackendRecorder = true;

  const MARK = ${JSON.stringify(RECORDER_MARKER)};
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
  const emit = (step) => {
    if (paused || !window.__toppathRecArmed) return;
    const scoped = step.assertion || step.action === 'screenshot';
    if (CONFIG.bindings?.length && scoped) {
      if (!owner) { alert('請先選擇檢查與截圖所屬的 Lark TC'); return; }
      step.tcId = owner;
    }
    try { console.info(MARK, JSON.stringify(step)); return true; } catch { return false; }
  };

  // ── 選擇器策略階梯 ───────────────────────────────────────────────────
  const esc = (v) => String(v).replace(/"/g, '\\\\"');

  const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const isUniqueCss = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; }
    catch { return false; }
  };

  /**
   * click 的 event.target 經常是按鈕裡的 <i>/<span>。直接描述它會錄出
   * button > i 或 button > span；圖示、版型一改就壞。先升到真正接收操作的節點。
   */
  function actionableTarget(el) {
    if (!el || !el.closest) return el;
    return el.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="option"], .el-menu-item, .el-submenu__title') || el;
  }

  function stableAttr(el) {
    for (const attr of ['data-testid', 'data-test', 'data-uat', 'aria-label', 'name']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const selector = '[' + attr + '="' + esc(v) + '"]';
        if (isUniqueCss(selector)) return { selector, strategy: 'dataAttr' };
      }
    }
    if (el.id && !/^[0-9]/.test(el.id) && !/el-id-|^\\d+$/.test(el.id)) {
      return { selector: '#' + CSS.escape(el.id), strategy: 'dataAttr' };
    }
    return null;
  }

  function byLabel(el) {
    if (!/^(input|textarea|select)$/i.test(el.tagName)) return null;
    // <label for> 或包在 label 裡
    let text = '';
    if (el.id) {
      const lab = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (lab) text = (lab.innerText || '').trim();
    }
    if (!text) {
      const wrap = el.closest('label');
      if (wrap) text = (wrap.innerText || '').trim();
    }
    // Element UI 的 form item：label 在同一個 .el-form-item 裡
    if (!text) {
      const item = el.closest('.el-form-item');
      const lab = item && item.querySelector('.el-form-item__label');
      if (lab) text = (lab.innerText || '').trim();
    }
    if (!text) {
      const ph = el.getAttribute('placeholder');
      if (ph) return { selector: 'input[placeholder="' + esc(ph) + '"]', strategy: 'label' };
      return null;
    }
    return { selector: 'label=' + text.replace(/[:：*]\\s*$/, ''), strategy: 'label' };
  }

  function byText(el) {
    if (!/^(button|a|span|li|div)$/i.test(el.tagName) && !el.matches('[role="button"], [role="menuitem"], [role="option"]')) return null;
    const raw = String(el.innerText || '').trim();
    if (raw.includes('\\n')) return null;
    const text = cleanText(raw);
    if (!text || text.length > 30 || /^[\\d\\s.,%$+\\-]+$/.test(text)) return null;
    return { selector: 'text=' + text, strategy: 'text' };
  }

  function byTableCell(el) {
    const td = el.closest('td');
    const table = td && td.closest('table');
    if (!td || !table) return null;
    const row = td.closest('tr');
    const idx = Array.from(row.children).indexOf(td);
    const head = table.querySelectorAll('thead th')[idx];
    const col = head ? cleanText(head.innerText || '') : '';
    const rowIdx = Array.from(row.parentElement.children).indexOf(row) + 1;
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const cells = Array.from(row.children);
    // 用該列一個簡短且在目前表格中唯一的值當錨點。這樣排序或翻頁後仍能找到同一筆，
    // 也不依賴頁面根本沒有提供的 data-col 屬性。
    let rowText = '';
    for (const cell of cells) {
      if (cell === td) continue;
      const candidate = cleanText(cell.innerText || '');
      if (!candidate || candidate.length > 60) continue;
      const occurrences = rows.filter(r => Array.from(r.children).some(c => cleanText(c.innerText || '') === candidate)).length;
      if (occurrences === 1) { rowText = candidate; break; }
    }
    const rowSelector = rowText
      ? 'tr:has(td:text-is(' + JSON.stringify(rowText) + '))'
      : cssPath(table).selector + ' tbody > tr:nth-of-type(' + rowIdx + ')';
    const cellSelector = rowSelector + ' > td:nth-of-type(' + (idx + 1) + ')';
    let tail = '';
    const target = actionableTarget(el);
    if (target && target !== td) {
      const tag = target.tagName.toLowerCase();
      const same = Array.from(td.querySelectorAll(tag));
      const targetIdx = same.indexOf(target);
      if (targetIdx >= 0) tail = ' ' + tag + ':nth-of-type(' + (targetIdx + 1) + ')';
    }
    return { selector: cellSelector + tail, strategy: 'tableCell', column: col, rowIndex: rowIdx, rowText };
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (isUniqueCss(parts.join(' > '))) break;
      node = parent;
    }
    return { selector: parts.join(' > '), strategy: 'cssPath' };
  }

  function byStableRegion(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.parentElement && depth < 5; depth++) {
      const parent = node.parentElement;
      const peers = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      parts.unshift(node.tagName.toLowerCase() + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(node) + 1) + ')' : ''));
      const anchor = stableAttr(parent);
      if (anchor && !['app', 'root'].includes(parent.id)) {
        const selector = anchor.selector + ' > ' + parts.join(' > ');
        if (isUniqueCss(selector)) return { selector, strategy: 'region' };
      }
      node = parent;
    }
    return null;
  }

  function describe(el) {
    return stableAttr(el) || byLabel(el) || byTableCell(el) || byStableRegion(el) || byText(el) || cssPath(el);
  }

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
    if (el.tagName === 'LABEL' && el.querySelector('input[type="checkbox"],input[type="radio"]')) return;
    const d = describe(el);
    emit({
      action: 'click',
      selector: d.selector,
      selectorStrategy: d.strategy,
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
  const pauseButton = document.createElement('button');
  const paintPause = () => { pauseButton.textContent = paused ? '繼續錄製' : '暫停錄製'; };
  paintPause();
  pauseButton.onclick = () => { flushInput(document.activeElement); paused = !paused; saveSelection(); paintPause(); };
  PANEL.appendChild(pauseButton);
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
      'font-family:system-ui,sans-serif;left:' + Math.min(event.clientX, innerWidth - 280) + 'px;top:' +
      Math.min(event.clientY, innerHeight - 320) + 'px';
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
      ['等於某個數字', '已帶入目前的值，可以改', '#9a6ac7', () => {
        const want = prompt('期望值（已帶入目前的值）', value);
        return want === null ? null : { kind: 'equals', expect: want };
      }],
      ['文字必須相等', '自行確認期望文字', '#3fbe8b', () => {
        const expect = prompt('期望文字（請依規格確認，當下畫面不一定正確）', value);
        return expect === null ? null : { kind: 'text', expect };
      }],
      ['截取這個區域', '保存到目前所屬 TC 的附圖', '#3fbe8b', () => ({ kind: 'screenshot' })],
      ['這個表格要排序正確', '依這一欄遞減', '#3fbe8b', () => ({ kind: 'sorted' })],
      ['不能出現／不能是這個值', '出現就算 FAIL', '#f87171', () => ({ kind: 'absent' })],
      ['這裡要人工看', '機器判不了，不算失敗', '#d99e22', () => {
        const why = prompt('為什麼要人工看？', '需人工確認');
        return why === null ? null : { kind: 'manual', reason: why };
      }],
      ['只記下來，不檢查', '存成變數給後面的積木用', '#64748b', () => ({ kind: 'capture' })],
    ];

    for (const [label, hint, color, make] of options) {
      const b = menuItem(label, hint, color);
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const picked = make();
        if (picked) {
          emit({ assertion: picked, selector: d.selector, selectorStrategy: d.strategy,
                 currentValue: value, label: labelOf(el), column: d.column ?? null });
        }
        close();
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
    setTimeout(() => {
      outsideHandler = (ev) => { if (!menu.contains(ev.target)) close(); };
      document.addEventListener('click', outsideHandler, true);
    }, 0);
  }, true);

  /** 抓這個元素旁邊的標籤文字，當作 read_block 的 labels */
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
    if (['open_page', 'click', 'type_text', 'keypress', 'drag', 'screenshot', 'set_checked', 'select_option', 'wait'].includes(ev.action)) {
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
