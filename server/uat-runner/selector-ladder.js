/**
 * server/uat-runner/selector-ladder.js
 *
 * 錄製選擇器的**產生**階梯。注入頁面執行，Backend 錄製與 H5/PC 錄製共用這一份。
 *
 * ## 為什麼要共用
 * 這段東西原本只住在 `backend-recorder.js` 的注入腳本裡，H5/PC 那支錄製器
 * （44 行）只有 `cssPath` 一種——也就是 Backend 五階階梯裡**最脆的那一階**。
 * 而 H5 是 Vue 3：scoped style 會產生 `data-v-xxxxxxx` 雜湊屬性、class 大量是
 * 編譯產物，純結構路徑一改版就全紅。這跟後台當初被 Element UI 動態 class 咬的
 * 是同一個病，階梯就是為了治它才做的。
 *
 * 各寫一份的下場是漂移：「同一個畫面，Backend 錄出來耐用、H5 錄出來一改版就壞」，
 * 而且兩邊都不會報錯。
 *
 * ## 取用順序
 *   ⓪ adapter 自帶的策略（Element 的下拉選項面板）
 *   ① data-testid / data-uat / aria-label 這類穩定屬性
 *   ② 表單欄位用 label 關聯（Element 的 form-item 規則由 adapter 補）
 *   ③ 表格儲存格用「列錨點文字 + 第幾欄」而不是純結構路徑
 *   ④ 從最近的穩定祖先往下的相對路徑
 *   ⑤ 按鈕／選單用可見文字
 *   ⑥ 都沒有才用結構路徑（最脆，編輯器會標出來讓人盯）
 *
 * ## adapter 負責什麼
 * **框架專用的規則不進共用層。** adapter 提供三樣東西，沒有就是沒有：
 *   - `actionable`：`closest()` 要多認哪些容器（Element 的 `.el-menu-item` 等）
 *   - `strategies`：排在最前面的專用策略
 *   - `byLabelExtra`：label 推不出文字時的框架專用退路
 *
 * ⚠️ 這支檔案**只負責產生 selector**。「錄製當下驗證」在兩邊是不同的東西：
 *    Backend 有 Playwright（`verifyRecordedSelectorLive`），H5/PC 走原始 CDP、
 *    沒有 page 物件。不要在這裡混進驗證邏輯。
 */

/** Element UI（後台）專用規則。H5 不吃這一套，所以不進共用層。 */
export function elementUiAdapterSource() {
  return `{
    actionable: '.el-menu-item, .el-submenu__title',
    byLabelExtra: (el, { cleanText }) => {
      const item = el.closest('.el-form-item');
      const lab = item && item.querySelector('.el-form-item__label');
      // ⚠️ :text-is() 比的是**頁面上的原文**。把「Min Bet:」的冒號拿掉再拿去比，
      //    永遠對不上——錄製當下就是 0 個。（CodeX 2026-09-17 指出）
      //    冒號只用在「同名欄位唯不唯一」的比對上，選擇器裡用原文。
      const labRaw = lab ? cleanText(lab.innerText || '') : '';
      // ⚠️ 這裡的 \\s 一定要寫兩槓。這段是 template literal，單槓的 \\s 在字串裡
      //    就被吃成 s——搬過來時原文正是單槓，實際注入頁面的是 /[:：*]s*$/，
      //    也就是「去掉結尾的字母 s」。cleanText 已經先 trim 過所以看不出差別，
      //    但這種「看起來對、跑起來是別的東西」的洞不該留著。
      const labKey = labRaw.replace(/[:：*]\\s*$/, '');
      if (labRaw) {
        const sameLabel = [...document.querySelectorAll('.el-form-item')].filter(it => {
          const l = it.querySelector('.el-form-item__label');
          return l && cleanText(l.innerText || '').replace(/[:：*]\\s*$/, '') === labKey;
        });
        const fields = [...item.querySelectorAll('input, textarea, select')];
        if (sameLabel.length === 1 && fields.length === 1 && fields[0] === el) {
          // ⚠️ 前面允許 label 在任何層，選擇器卻寫成直接子層會對不上。
          const direct = lab.parentElement === item ? '> ' : '';
          return {
            selector: '.el-form-item:has(' + direct + '.el-form-item__label:text-is(' + JSON.stringify(labRaw) + ')) '
              + el.tagName.toLowerCase(),
            strategy: 'formItem',
          };
        }
      }
      return null;
    },
    strategies: [(el, { cleanText }) => {
  /**
   * Element UI 的下拉選項。
   *
   * ⚠️ 選項面板是掛在 <body> 底下的獨立元素，**不在彈窗裡**，
   *    而且選項文字很常跟表格里的欄位重複。只寫 text=4186-dfdc1 的話，
   *    表格裡那一堆同名儲存格會一起被命中——使用者 2026-09-17 實測命中 8 個。
   *    （強制唯一之前這種情況會點到表格儲存格，下拉完全沒選到，而且不會報錯。）
   *
   *    所以限定在「目前打開著的那個面板」裡找。面板全關著時這條會是 0，不會亂選。
   */

    if (!el.closest) return null;
    const panel = el.closest('.el-select-dropdown, .el-dropdown-menu');
    if (!panel) return null;
    const panelClass = panel.classList.contains('el-dropdown-menu') ? 'el-dropdown-menu' : 'el-select-dropdown';
    const itemClass = panelClass + '__item';
    const item = el.closest('.' + itemClass);
    if (!item) return null;
    const text = cleanText(item.innerText || '');
    if (!text || text.length > 60) return null;
    // 同一個面板裡同名選項不唯一就不用這條，不猜
    const same = [...panel.querySelectorAll('.' + itemClass)]
      .filter(n => cleanText(n.innerText || '') === text);
    if (same.length !== 1) return null;
    return {
      selector: '.' + panelClass + ':visible .' + itemClass + ':has(:text-is(' + JSON.stringify(text) + '))',
      strategy: 'dropdownOption',
    };
    }],
  }`;
}

/**
 * 沒有框架專用規則的 adapter。H5（Vue 3）用這個——Vue 的 scoped 屬性是雜湊，
 * 不是穩定錨點，**不能**把 `data-v-` 當 testid 用。
 */
export function genericAdapterSource() {
  return '{}';
}

/**
 * 錄製當下的驗證，**頁面端版本**。給 H5/PC 用。
 *
 * ## 為什麼要有第二種驗證（CodeX 2026-09-17 定案）
 * Backend 錄製有 Playwright，用 `verifyRecordedSelectorLive(page, step)` 驗；
 * **H5/PC 錄製走原始 CDP，沒有 page 物件**，那一支用不了。
 *
 * 但也**不能在頁面裡自己寫一個 Playwright selector 的 matcher**——`text=`、
 * `label=`、`:text-is()`、`:visible` 都是 Playwright 的引擎，仿一份出來就是
 * 「同一條規則兩份實作」，而漂掉的症狀是「錄的時候說沒問題、跑起來找不到」。
 *
 * 所以只驗**語意對得齊的那一部分**：原生 CSS 用 `querySelectorAll` 驗，
 * 其他一律回 `unknown` 並附上 `unsupported` 的理由。少驗一部分是誠實的，
 * 猜一個答案不是。
 *
 * ⚠️ 合法 CSS 也不代表兩端等價：**Playwright 的 CSS 會穿透 open shadow DOM，
 *    原生 querySelectorAll 不會**（CodeX 指出）。所以元素只要不在主 document 樹上，
 *    就算選擇器是純 CSS 也回 `unknown`——否則會拿「原生查不到」去宣告「選擇器壞了」。
 *
 * status 跟 Backend 那支共用同一套詞彙（`SELECTOR_CHECK_STATUSES`）：
 *   ok / none / many / mismatch / invalid / unknown
 * 措辭在 `shared/uat-selector-check.ts`，不在這裡重寫。
 */
export function nativeSelectorCheckSource() {
  return `
  /**
   * Playwright 專屬的偽類與鏈接符號。出現在任何位置都代表不是原生 CSS。
   */
  const PW_ANYWHERE = [':text-is(', ':text(', ':has-text(', ':visible', ':nth-match(', '>>'];
  /**
   * Playwright 的引擎前綴。**只認開頭**——text= / label= 出現在中間是合法的
   * 屬性選擇器內容。
   *
   * ⚠️ 這裡原本用 includes，於是 [aria-label="設定"] 裡的 label= 讓一條
   *    完全正常的原生 CSS 被判成「驗不了」。瀏覽器測試當場抓到——
   *    失敗方式是**少驗**（永遠回 unknown），不會報錯，只會讓驗證安靜地形同虛設。
   */
  const PW_PREFIX = ['text=', 'label=', 'xpath=', 'css=', 'id=', 'role=', '//'];
  const isNativeCss = (selector) => {
    if (typeof selector !== 'string' || !selector) return false;
    if (PW_PREFIX.some(prefix => selector.startsWith(prefix))) return false;
    return !PW_ANYWHERE.some(token => selector.includes(token));
  };

  /**
   * @returns {{status:string, count:number|null, reason?:string}}
   *   ok       唯一命中，而且就是剛才那一顆
   *   none     元素還在、選擇器卻找不到它 → 錄的當下就是壞的
   *   many     命中多筆 → 重播會被「定位必須唯一」擋下來
   *   mismatch 唯一命中但不是剛才那一顆（比「找不到」更危險：重播會安靜點錯）
   *   invalid  連原生 CSS 都解析不了
   *   unknown  無法確認——**不是失敗**，不要拿去標紅
   */
  function nativeSelectorCheck(selector, el) {
    if (!isNativeCss(selector)) return { status: 'unknown', count: null, reason: 'unsupported' };
    if (!el || el.isConnected === false) return { status: 'unknown', count: null, reason: 'gone' };
    // open shadow DOM：Playwright 穿得過去、querySelectorAll 穿不過去，兩端不等價
    try { if (el.getRootNode && el.getRootNode() !== document) return { status: 'unknown', count: null, reason: 'shadow' }; }
    catch { return { status: 'unknown', count: null, reason: 'shadow' }; }
    let nodes;
    try { nodes = document.querySelectorAll(selector); }
    catch { return { status: 'invalid', count: null }; }
    if (nodes.length === 0) return { status: 'none', count: 0 };
    if (nodes.length > 1) return { status: 'many', count: nodes.length };
    return { status: nodes[0] === el ? 'ok' : 'mismatch', count: 1 };
  }
`;
}

/**
 * 產生可注入頁面的階梯原始碼。回傳的是**片段**不是完整腳本：呼叫端把它放進
 * 自己的 IIFE 裡，後面接自己的錄製邏輯。
 *
 * @param {string} adapterSource 一段會求值成 adapter 物件的 JS 原始碼
 */
export function selectorLadderSource(adapterSource = '{}') {
  return `
  const ADAPTER = ${adapterSource};
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
    const base = 'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="option"]';
    const extra = ADAPTER.actionable ? ', ' + ADAPTER.actionable : '';
    return el.closest(base + extra) || el;
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
    // ⚠️ Element UI 的 form item：label 跟 input **沒有任何關聯**（沒 for、也沒包住）。
    //    這裡推得出文字，不代表 Playwright 的 getByLabel 找得到——實測命中 0。
    //    （使用者 2026-09-17：label=Jackpot ID 在二級彈窗裡永遠找不到。）
    //    所以這一條不再產 label=，改產「按 form item 範圍」的選擇器，
    //    而且**當場確認它真的只指到這一個欄位**，不唯一就不用。
    // Element UI 的 form item 那條規則搬到 adapter：它只在後台成立。
    // ⚠️ 位置不能動——要在「label 推不出文字」之後、placeholder 退路之前。
    if (!text && ADAPTER.byLabelExtra) {
      const viaAdapter = ADAPTER.byLabelExtra(el, { cleanText, esc, isUniqueCss });
      if (viaAdapter) return viaAdapter;
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
    // ⚠️ 錨點絕對不能寫成 td:text-is(...)。Playwright 的 :text-is() 只配「最小的那個元素」，
    //    而後台是 el-table，每一格的文字都包在 <td><div class="cell">…</div></td> 裡，
    //    它會配到那個 div——td:text-is() 在任何 el-table 上都是 0 個，重播必定失敗。
    //    去掉 td 限定之後，純文字格與包了一層的格子都命中 1。（2026-09-17）
    const rowSelector = rowText
      ? 'tr:has(:text-is(' + JSON.stringify(rowText) + '))'
      : cssPath(table).selector + ' tbody > tr:nth-of-type(' + rowIdx + ')';
    const cellSelector = rowSelector + ' > td:nth-of-type(' + (idx + 1) + ')';
    let selector = cellSelector;
    const target = actionableTarget(el);
    if (target && target !== td) {
      const tag = target.tagName.toLowerCase();
      const same = Array.from(td.querySelectorAll(tag));
      // 格子裡只有一顆就用後代寫法，最耐改版；有好幾顆才需要區分。
      selector = cellSelector + ' ' + tag;
      if (same.length > 1) {
        // ⚠️ 不能用 nth-of-type（querySelectorAll 數的是「這格裡第幾個後代」，
        //    nth-of-type 數的却是「在自己父層裡同 tag 第幾個」），
        //    也不能用 :nth-match()。
        //
        //    :nth-match(sel, N) 是從**整個查詢結果**取第 N 個，不是在格子裡取第 N 個。
        //    日後多出一列錨點文字相同、而且排在前面的列時，它會指到**別一列的
        //    按鈕**，而且依然只命中 1 個——「定位必須唯一」根本擋不住，會安靜地點錯東西。
        //    實測：錄製時 r1/b2，前面插一列 r0 之後變成 r0/b2，命中數還是 1。
        //    （CodeX 2026-09-17 指出）
        //
        //    改成從 td 往下的**相對結構路徑**：它只在這一格裡展開，列不唯一時整條
        //    選擇器會命中多筆而被擋下來——**大聲失敗比安靜點錯好**。
        const parts = [];
        let node = target;
        while (node && node !== td && node.parentElement) {
          const parent = node.parentElement;
          const peers = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          parts.unshift(node.tagName.toLowerCase() + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(node) + 1) + ')' : ''));
          node = parent;
        }
        if (node === td && parts.length) selector = cellSelector + ' > ' + parts.join(' > ');
      }
    }
    return { selector, strategy: 'tableCell', column: col, rowIndex: rowIdx, rowText };
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
    // adapter 的策略排最前：Element 的下拉選項在獨立面板裡，
    // 別的策略都會產出跟表格撞名的 text=。
    for (const fn of (ADAPTER.strategies || [])) {
      const hit = fn(el, { cleanText, esc, isUniqueCss, actionableTarget });
      if (hit) return hit;
    }
    return stableAttr(el) || byLabel(el) || byTableCell(el) || byStableRegion(el) || byText(el) || cssPath(el);
  }
`;
}
