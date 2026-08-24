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
 * ## 座標只當診斷資料
 * 不參與定位。後台的座標在表格分頁、資料筆數、側欄展開、換螢幕下都會漂；
 * H5 那邊錄座標是因為遊戲畫在 canvas 上沒有 DOM 可指，後台不一樣。
 */

/** 錄製器把積木用這個前綴印到 console，外面透過 CDP 收 */
export const RECORDER_MARKER = '__TOPPATH_BACKEND_REC__';

export function backendRecorderScript() {
  return `(() => {
  if (window.__toppathBackendRecorder) return;
  window.__toppathBackendRecorder = true;

  const MARK = ${JSON.stringify(RECORDER_MARKER)};
  // 自動登入那段不能錄——那是為了讓使用者一開始就在已登入的後台，不是他要測的操作，
  // 而且會把帳密寫進積木。server 登入完成後才呼叫 __toppathArmRecorder()。
  window.__toppathRecArmed = false;
  window.__toppathArmRecorder = () => { window.__toppathRecArmed = true; };
  const emit = (step) => { try { console.info(MARK, JSON.stringify(step)); } catch {} };

  // ── 選擇器策略階梯 ───────────────────────────────────────────────────
  const esc = (v) => String(v).replace(/"/g, '\\\\"');

  function stableAttr(el) {
    for (const attr of ['data-testid', 'data-test', 'data-uat', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return { selector: '[' + attr + '="' + esc(v) + '"]', strategy: 'dataAttr' };
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
    if (!/^(button|a|span|li|div)$/i.test(el.tagName)) return null;
    const text = (el.innerText || '').trim();
    if (!text || text.length > 30 || text.includes('\\n')) return null;
    return { selector: 'text=' + text, strategy: 'text' };
  }

  function byTableCell(el) {
    const td = el.closest('td');
    const table = td && td.closest('table');
    if (!td || !table) return null;
    const row = td.closest('tr');
    const idx = Array.from(row.children).indexOf(td);
    const head = table.querySelectorAll('thead th')[idx];
    const col = head ? (head.innerText || '').trim() : '';
    const rowIdx = Array.from(row.parentElement.children).indexOf(row) + 1;
    if (!col) return null;
    // 記欄位名 + 第幾列，不是純 nth-child——欄位順序調整時至少欄位名還對得上
    return { selector: 'table >> tr:nth-child(' + rowIdx + ') >> [data-col="' + esc(col) + '"]',
             strategy: 'tableCell', column: col, rowIndex: rowIdx };
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return { selector: parts.join(' > '), strategy: 'cssPath' };
  }

  function describe(el) {
    return stableAttr(el) || byLabel(el) || byText(el) || byTableCell(el) || cssPath(el);
  }

  // ── 錄動作 ───────────────────────────────────────────────────────────
  document.addEventListener('click', (event) => {
    if (!window.__toppathRecArmed) return;   // 登入階段不錄
    // 標記模式或按著 Alt 時，這一下是「標檢查條件」不是「操作」，不要錄成動作
    if (isMarking(event)) return;
    if (event.target && event.target.closest && event.target.closest('[data-toppath-recorder-ui]')) return;
    if (window.__toppathPicking) return;
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    const d = describe(el);
    emit({
      action: 'click',
      selector: d.selector,
      selectorStrategy: d.strategy,
      // 只做診斷不定位，執行時不會用到
      viewport: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
    });
  }, true);

  document.addEventListener('change', (event) => {
    if (!window.__toppathRecArmed) return;   // 登入階段不錄
    const el = event.target;
    if (!el || !('value' in el)) return;
    if (/^(checkbox|radio)$/i.test(el.type)) return;
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
  BADGE.style.cssText = 'position:fixed;z-index:2147483645;right:14px;bottom:14px;padding:9px 13px;' +
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

  const HL = document.createElement('div');
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

    const menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;z-index:2147483647;width:262px;padding:6px;border:1px solid #42566f;' +
      'border-radius:9px;background:#0a1628;box-shadow:0 16px 40px rgba(0,0,0,.55);' +
      'font-family:system-ui,sans-serif;left:' + Math.min(event.clientX, innerWidth - 280) + 'px;top:' +
      Math.min(event.clientY, innerHeight - 320) + 'px';
    const title = document.createElement('h5');
    title.textContent = '要檢查這個元素的什麼？';
    title.style.cssText = 'margin:5px 8px 7px;color:#94a3b8;font-size:11px;font-weight:700';
    menu.appendChild(title);

    const close = () => { menu.remove(); window.__toppathPicking = false; };

    const options = [
      ['必須有值', '非空就通過。最常用', '#3fbe8b', () => ({ kind: 'filled' })],
      ['等於某個數字', '已帶入目前的值，可以改', '#9a6ac7', () => {
        const want = prompt('期望值（已帶入目前的值）', value);
        return want === null ? null : { kind: 'equals', expect: want };
      }],
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
    setTimeout(() => document.addEventListener('click', function once(ev) {
      if (!menu.contains(ev.target)) { close(); document.removeEventListener('click', once, true); }
    }, true), 0);
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
    if (ev.action === 'click' || ev.action === 'type_text') {
      steps.push(ev);
      continue;
    }
    if (!ev.assertion) continue;
    const kind = ev.assertion.kind;
    const varName = `v${++varSeq}`;
    const labels = ev.label ? [ev.label] : [];

    if (kind === 'filled' || kind === 'equals' || kind === 'capture') {
      steps.push({ action: 'read_block', selector: ev.selector, selectorStrategy: ev.selectorStrategy, labels, as: varName });
      if (kind === 'filled') steps.push({ action: 'assert_filled', from: varName });
      if (kind === 'equals') steps.push({ action: 'assert_equals', left: `${varName}.${labels[0] ?? ''}`, right: String(ev.assertion.expect ?? ''), tolerancePct: 1 });
      continue;
    }
    if (kind === 'sorted') {
      steps.push({ action: 'read_table', selector: 'table', as: varName });
      steps.push({ action: 'assert_sorted', from: varName, column: ev.column ?? ev.label ?? '', direction: 'desc' });
      continue;
    }
    if (kind === 'absent') {
      steps.push({ action: 'assert_absent', selector: ev.selector, text: ev.currentValue || undefined });
      continue;
    }
    if (kind === 'manual') {
      steps.push({ action: 'mark_manual', reason: ev.assertion.reason || '需人工確認' });
      continue;
    }
  }
  return steps;
}

/** 這串積木裡有沒有任何斷言。沒有的話錄出來的東西永遠 PASS，要擋下來問清楚 */
export function hasAssertion(steps) {
  const ASSERTIONS = new Set(['assert_filled', 'assert_equals', 'assert_sorted', 'assert_absent', 'mark_manual']);
  return (steps ?? []).some(s => ASSERTIONS.has(s.action));
}
