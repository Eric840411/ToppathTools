/**
 * server/uat-runner/block-engine.js
 *
 * 後台 UAT 的積木執行器。把「一筆 TC 要檢查什麼」從寫死的 verifier 函式
 * 變成 tc-registry.json 裡的 steps 陣列。
 *
 * ## 為什麼獨立成一個檔案
 * run-lark-tc-backend.js 已經 5000 行，再往裡面塞會更難維護；獨立出來也才能
 * 不開瀏覽器就單獨測執行器本身的行為（見同目錄的測試）。
 *
 * ## 回傳形狀要跟 performAction() 一致
 * 外層那段（截圖上傳、回寫 Lark、統計 pass/manual/skip）是共用的，執行器必須
 * 回傳同一個形狀，才不用動到那段已經在跑的程式碼。
 *
 * ## 複雜流程不硬拆
 * Bonus 等 5 分鐘、xlsx 三方比對這種流程，拆成十顆小積木之後每顆都只有一個地方
 * 用得到，讀起來反而比看程式碼難。這類保持一顆 `builtin_verifier` 積木，但把
 * 寫死在裡面的常數（容差、等待時間、比對欄位）開成參數——使用者想調的本來就是
 * 那些數字，不是流程。
 */

/**
 * 積木定義。前端的積木庫與參數表單直接讀這份，不要在前端另外抄一份——
 * 抄兩份的結果是「畫面上有這顆積木、跑起來說不認得」。
 *
 * params 的 type：text | number | textarea | select | boolean
 */
export const BLOCK_DEFS = {
  open_page: {
    label: '開啟後台頁面', category: 'nav', defaultOnFail: 'stop',
    description: '依子類型自動帶路徑，登入沿用同一個 session',
    params: [
      { key: 'subtype', label: '子類型', type: 'text', placeholder: 'Dashboard', help: '對應 SUBTYPE_MAP 的鍵；填了 path 就以 path 為準' },
      { key: 'path', label: '直接指定路徑', type: 'text', placeholder: '/dashboard', help: '選填。子類型對不到時用這個' },
      { key: 'waitMs', label: '開啟後等待（毫秒）', type: 'number', default: 1500 },
    ],
  },
  click: {
    label: '點擊元素', category: 'nav', defaultOnFail: 'stop',
    description: '用選擇器點一個元素（錄製時自動產生）',
    params: [
      { key: 'selector', label: '選擇器', type: 'text', required: true, placeholder: 'text=查詢' },
      // 錄製時記下是用哪一階策略抓到的。退到 cssPath 的最脆，編輯器會標黃底提醒
      { key: 'selectorStrategy', label: '選擇器來源', type: 'text', help: 'dataAttr / label / text / tableCell / cssPath；錄製時自動填' },
      { key: 'waitMs', label: '點完等待（毫秒）', type: 'number', default: 800 },
    ],
  },
  type_text: {
    label: '輸入文字', category: 'nav', defaultOnFail: 'stop',
    description: '在欄位輸入內容（錄製時自動產生）',
    params: [
      { key: 'selector', label: '選擇器', type: 'text', required: true },
      { key: 'value', label: '要輸入的內容', type: 'text', required: true },
      { key: 'selectorStrategy', label: '選擇器來源', type: 'text' },
    ],
  },
  apply_filter: {
    label: '套用篩選', category: 'nav', defaultOnFail: 'stop',
    description: '設定日期／Game Type／Client Version 之後按查詢',
    params: [
      { key: 'field', label: '欄位', type: 'text', required: true, placeholder: 'Date' },
      { key: 'value', label: '值', type: 'text', required: true },
      { key: 'submitSelector', label: '查詢按鈕選擇器', type: 'text', placeholder: 'text=Search' },
      { key: 'waitMs', label: '查詢後等待（毫秒）', type: 'number', default: 1500 },
    ],
  },
  assert_control_exists: {
    label: '控制項必須存在', category: 'assert', defaultOnFail: 'stop',
    description: '畫面上要有這個按鈕／連結（用可見文字比對，不分大小寫）',
    params: [
      { key: 'text', label: '文字或關鍵字', type: 'text', required: true, placeholder: 'Add' },
      { key: 'scope', label: '限定範圍', type: 'select', options: ['button', 'any'], default: 'button', help: 'button 只找按鈕與連結；any 找整頁任何可見元素' },
      { key: 'match', label: '比對方式', type: 'select', options: ['contains', 'startsWith', 'exact'], default: 'contains' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  assert_column_exists: {
    label: '表格必須有這一欄', category: 'assert', defaultOnFail: 'stop',
    description: '表頭要有指定的欄位名稱',
    params: [
      { key: 'columns', label: '欄位名稱（一行一個）', type: 'textarea', required: true },
      { key: 'selector', label: '表格 selector', type: 'text', default: 'table', placeholder: 'table' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  assert_option_count: {
    label: '下拉選項數量', category: 'assert', defaultOnFail: 'stop',
    description: '下拉選單要存在，選項數量要符合',
    params: [
      { key: 'selector', label: '下拉 selector', type: 'text', required: true, placeholder: 'select' },
      { key: 'min', label: '至少幾個', type: 'number', default: 1 },
      { key: 'max', label: '最多幾個（留空不限）', type: 'number' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  assert_absent: {
    label: '不能出現', category: 'assert', defaultOnFail: 'stop',
    description: '這個元素不能存在，或這段文字不能出現在畫面上',
    params: [
      { key: 'selector', label: '不能出現的選擇器', type: 'text', placeholder: '.el-message--error' },
      { key: 'text', label: '不能出現的文字', type: 'text', placeholder: '查無資料' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  read_block: {
    label: '讀取色塊', category: 'read', outputKind: 'blockFields', defaultOnFail: 'stop',
    description: '用 selector 取區塊，抓每個標籤後面的值',
    params: [
      { key: 'selector', label: '區塊 selector', type: 'text', placeholder: '.blue-block', required: true },
      { key: 'labels', label: '要抓的標籤（一行一個）', type: 'textarea', required: true },
      { key: 'as', label: '存成變數名', type: 'text', placeholder: 'blueBlock', required: true },
    ],
  },
  read_table: {
    label: '讀取表格', category: 'read', outputKind: 'tableRows', defaultOnFail: 'stop',
    description: '把表格讀成列陣列，後面可以拿來檢查排序或比對',
    params: [
      { key: 'selector', label: '表格 selector', type: 'text', placeholder: 'table', default: 'table' },
      { key: 'as', label: '存成變數名', type: 'text', required: true },
      { key: 'maxRows', label: '最多讀幾列', type: 'number', default: 200 },
    ],
  },
  assert_filled: {
    label: '欄位必須有值', category: 'assert', inputKind: 'blockFields', defaultOnFail: 'stop',
    description: '指定變數裡的標籤都要出現而且非空',
    params: [
      { key: 'from', label: '來源變數', type: 'text', required: true },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  assert_equals: {
    label: '兩值必須相等', category: 'compare', defaultOnFail: 'stop',
    description: '畫面 ↔ API ↔ xlsx 交叉比對，可設容差',
    params: [
      { key: 'left', label: '左值', type: 'text', placeholder: 'blueBlock.TotalAvailableEGM', required: true },
      { key: 'right', label: '右值', type: 'text', placeholder: 'apiData.total', required: true },
      // 容差開成參數，是因為現在 cmp() 裡寫死 pct = 0.01，要調只能改 5000 行那支
      { key: 'tolerancePct', label: '容差（%）', type: 'number', default: 1, help: '相對誤差；絕對誤差至少容許 1' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  assert_sorted: {
    label: '排序必須正確', category: 'assert', inputKind: 'tableRows', defaultOnFail: 'stop',
    description: '檢查表格某一欄是遞增或遞減',
    params: [
      { key: 'from', label: '來源變數（表格）', type: 'text', required: true },
      { key: 'column', label: '欄位名稱', type: 'text', required: true },
      { key: 'direction', label: '方向', type: 'select', options: ['desc', 'asc'], default: 'desc' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'manual'], default: 'stop' },
    ],
  },
  screenshot: {
    label: '截圖', category: 'evidence', defaultOnFail: 'continue',
    description: '存證並附回 Lark TC',
    params: [{ key: 'name', label: '檔名', type: 'text', placeholder: 'tc1_Dashboard' }],
  },
  mark_manual: {
    label: '標記需人工', category: 'evidence',
    description: '沒辦法自動判定的直接標成需人工，不算失敗',
    params: [{ key: 'reason', label: '原因', type: 'text', required: true }],
  },
  builtin_verifier: {
    label: '內建驗證器', category: 'legacy',
    description: '沿用現有寫好的驗證流程，只調參數',
    params: [
      { key: 'name', label: '驗證器', type: 'text', required: true, help: '例如 verifyDashboard' },
      { key: 'options', label: '參數覆寫（JSON）', type: 'textarea', help: '例如 {"tolerancePct":1,"waitMinutes":5}' },
    ],
  },
};

/** 把 textarea 的多行字串拆成陣列；已經是陣列就原樣回傳 */
function toLines(value) {
  if (Array.isArray(value)) return value.filter(v => String(v).trim());
  return String(value ?? '').split('\n').map(v => v.trim()).filter(Boolean);
}

/**
 * 解析 `blueBlock.TotalAvailableEGM` 這種引用。
 * 找不到回 undefined——不要回 null 或 0，那會讓「沒抓到」跟「值就是 0」混在一起，
 * 比對時變成假通過。
 */
function resolveRef(vars, ref) {
  if (ref === undefined || ref === null) return undefined;
  const raw = String(ref);
  // 不是引用就是字面值（數字或字串）
  if (!/^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== '' ? n : raw;
  }
  const parts = raw.split('.');
  let cur = vars;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 從畫面文字取數字：去掉貨幣符號、千分位、百分比 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value).replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** 相對容差比對；絕對誤差至少容許 1（沿用既有 cmp() 的規則，不要另創一套） */
export function numbersEqual(a, b, tolerancePct = 1) {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= Math.max(Math.abs(b) * (tolerancePct / 100), 1);
}

/**
 * 執行一串積木。
 *
 * @param {object} ctx 由 run-lark-tc-backend.js 注入的能力，執行器本身不認識 Playwright
 *   以外的東西：
 *   - page              Playwright page
 *   - openPath(path, waitMs)  導到後台某個路徑（登入沿用）
 *   - resolveSubtypePath(subtype) 子類型 → 路徑
 *   - clickSelector(selector, waitMs)
 *   - typeInto(selector, value)
 *   - applyFilter(field, value, submitSelector, waitMs)
 *   - takeScreenshot(name) → 檔案路徑
 *   - callBuiltin(name, options) → { notes, criticalFails, manual }
 * @returns {{ pass: boolean, notes: string, criticalFails: string[], manual: boolean,
 *             allShotPaths: string[], error: string|null }}
 *   形狀刻意跟 performAction() 對齊，外層的截圖上傳與 Lark 回寫不用改。
 */
export async function runSteps(steps, ctx) {
  const notes = [];
  const criticalFails = [];
  const allShotPaths = [];
  const vars = {};
  let manual = false;
  let manualReason = '';

  /**
   * 失敗處置。三種模式的差別只在「要不要繼續往下跑」，**不在「算不算失敗」**——
   * `continue` 一樣要進 criticalFails，只是繼續執行好把剩下的問題一次看完。
   * 早期版本讓 continue 不計入 criticalFails，結果是「驗證失敗但整筆 TC 顯示通過」，
   * 這種假通過比直接報錯還糟（CodeX review 抓到）。
   * 只有 `manual` 不算 hard fail——那代表「這件事機器判不了」，不是「這件事錯了」。
   */
  const fail = (step, message) => {
    const mode = step.onFail ?? BLOCK_DEFS[step.action]?.defaultOnFail ?? 'stop';
    if (mode === 'manual') {
      manual = true;
      manualReason = manualReason || message;
      notes.push(`⚠️ ${message}`);
      return 'continue';
    }
    notes.push(`❌ ${message}`);
    criticalFails.push(message);
    return mode === 'continue' ? 'continue' : 'stop';
  };

  /**
   * 取變數。找不到一律是 criticalFail 且中止，不受 onFail 影響——
   * 引用了不存在的變數是「積木寫錯了」，不是執行期的狀況，讓它 continue
   * 只會讓後面每一步都失敗、噴一堆看不懂的訊息（CodeX review 建議）。
   */
  const needVar = (step, tag, name, expectKind) => {
    if (!(name in vars)) {
      criticalFails.push(`${tag}：引用了不存在的變數「${name}」`);
      notes.push(`❌ ${tag}：引用了不存在的變數「${name}」`);
      return undefined;
    }
    const entry = vars[name];
    if (expectKind && entry.kind !== expectKind) {
      criticalFails.push(`${tag}：變數「${name}」是 ${entry.kind}，這顆積木要的是 ${expectKind}`);
      notes.push(`❌ ${tag}：變數「${name}」型別不符（${entry.kind} → 需要 ${expectKind}）`);
      return undefined;
    }
    return entry.value;
  };

  /**
   * 存變數。重名預設報錯——靜默覆寫會讓後面引用的到底是哪一份完全看不出來。
   * 真的要覆寫（例如同一個區塊在篩選前後各讀一次）就明確寫 overwrite: true。
   */
  const setVar = (step, tag, name, kind, value) => {
    if (name in vars && step.overwrite !== true) {
      criticalFails.push(`${tag}：變數名「${name}」重複`);
      notes.push(`❌ ${tag}：變數名「${name}」重複。換個名字，或加上 overwrite: true 明確覆寫`);
      return false;
    }
    vars[name] = { kind, value };
    return true;
  };

  /**
   * 參數檢查。少填必填欄位在寫積木時很常見，訊息要指名是哪一顆積木的哪個欄位，
   * 不然只會看到後面一連串莫名其妙的失敗（CodeX review 建議）。
   */
  const checkParams = (step, tag, def) => {
    const missing = (def.params ?? [])
      .filter(prm => prm.required && (step[prm.key] === undefined || String(step[prm.key]).trim() === ''))
      .map(prm => prm.label);
    if (!missing.length) return true;
    criticalFails.push(`${tag}：缺少必填參數 ${missing.join('、')}`);
    notes.push(`❌ ${tag}：缺少必填參數 ${missing.join('、')}`);
    return false;
  };

  for (const [i, step] of (steps ?? []).entries()) {
    const def = BLOCK_DEFS[step.action];
    const tag = `[${i + 1}/${steps.length}] ${def?.label ?? step.action}`;

    // 不認得的積木一定要失敗，不能當沒看到——靜默跳過會讓整筆 TC 看起來通過，
    // 但實際上該檢查的根本沒跑
    if (!def) {
      criticalFails.push(`${tag}：不認得的積木 ${step.action}`);
      notes.push(`❌ ${tag}：不認得的積木「${step.action}」`);
      break;
    }
    if (!checkParams(step, tag, def)) break;

    try {
      if (step.action === 'open_page') {
        const target = step.path || ctx.resolveSubtypePath(step.subtype);
        if (!target) { if (fail(step, `${tag}：對不到路徑（subtype=${step.subtype ?? '-'}）`) === 'stop') break; continue }
        await ctx.openPath(target, Number(step.waitMs) || 1500);
        notes.push(`${tag}：${target}`);

      } else if (step.action === 'click') {
        await ctx.clickSelector(step.selector, Number(step.waitMs) || 800);
        notes.push(`${tag}：${step.selector}`);

      } else if (step.action === 'type_text') {
        await ctx.typeInto(step.selector, String(step.value ?? ''));
        notes.push(`${tag}：${step.selector} ← ${String(step.value ?? '').slice(0, 40)}`);

      } else if (step.action === 'apply_filter') {
        await ctx.applyFilter(step.field, String(step.value ?? ''), step.submitSelector, Number(step.waitMs) || 1500);
        notes.push(`${tag}：${step.field} = ${step.value}`);

      } else if (step.action === 'assert_control_exists') {
        // 既有 verifier 是用 allBtns.some(t => /xxx/i.test(t)) 這種文字比對找按鈕，
        // 這裡沿用同一種語意（預設不分大小寫的 contains），不要另創一套比對規則
        const found = await ctx.page.evaluate(({ text, scope, match }) => {
          const sel = scope === 'button' ? 'button, a, [role="button"], .el-button' : 'button, a, span, div, li, th, td, label';
          const needle = String(text).toLowerCase();
          for (const el of document.querySelectorAll(sel)) {
            const t = (el.innerText || el.textContent || '').trim();
            if (!t) continue;
            const low = t.toLowerCase();
            const hit = match === 'exact' ? low === needle : match === 'startsWith' ? low.startsWith(needle) : low.includes(needle);
            if (hit) return t.slice(0, 60);
          }
          return null;
        }, { text: step.text, scope: step.scope ?? 'button', match: step.match ?? 'contains' });
        if (found === null) { if (fail(step, `${tag}：找不到「${step.text}」`) === 'stop') break; continue }
        notes.push(`✅ ${tag}：${found}`);

      } else if (step.action === 'assert_column_exists') {
        const want = toLines(step.columns);
        const headers = await ctx.page.evaluate(({ selector }) => {
          // 跟 read_table 同一個理由：Element UI 的表頭在 .el-table__header 裡。
          // 沿用既有 getBaseInfo() 的取法（'th, .el-table__header th'），
          // 不要另創一套，不然同一頁兩邊看到的欄位會不一樣。
          const all = [...document.querySelectorAll('th, .el-table__header th')]
            .map(th => (th.innerText || '').trim()).filter(Boolean);
          if (all.length) return all;
          const table = document.querySelector(selector);
          if (!table) return null;
          return [...table.querySelectorAll('thead th, thead td')].map(th => (th.innerText || '').trim()).filter(Boolean);
        }, { selector: step.selector || 'table' });
        if (headers === null) { if (fail(step, `${tag}：找不到表格 ${step.selector || 'table'}`) === 'stop') break; continue }
        const lower = headers.map(h => h.toLowerCase());
        const missing = want.filter(w => !lower.some(h => h.includes(String(w).toLowerCase())));
        if (missing.length) { if (fail(step, `${tag}：缺少欄位 ${missing.join('、')}（表頭有：${headers.join('、').slice(0, 120)}）`) === 'stop') break; continue }
        notes.push(`✅ ${tag}：${want.join('、')}`);

      } else if (step.action === 'assert_option_count') {
        // 實測後台頁面 document.querySelectorAll('select').length === 0——Element UI 用的是
        // 自訂下拉，選項要展開才會出現在 .el-select-dropdown__item。所以先點開再數。
        if (step.selector) {
          await ctx.page.locator(step.selector).first().click({ timeout: 5000 }).catch(() => { /* 不是可點的就算了 */ });
          await ctx.page.waitForTimeout(400);
        }
        const count = await ctx.page.evaluate(({ selector }) => {
          const el = document.querySelector(selector);
          if (el && el.options) return el.options.length;                       // 原生 select
          const inEl = el ? el.querySelectorAll('option, li').length : 0;
          if (inEl) return inEl;
          // Element UI 的下拉面板是掛在 body 底下的，不在原本那個元素裡面
          const panels = [...document.querySelectorAll('.el-select-dropdown')]
            .filter(p => p.style.display !== 'none');
          const items = panels.flatMap(p => [...p.querySelectorAll('.el-select-dropdown__item')]);
          if (items.length) return items.length;
          return el ? 0 : null;
        }, { selector: step.selector });
        if (count === null) { if (fail(step, `${tag}：找不到下拉 ${step.selector}`) === 'stop') break; continue }
        const min = step.min === undefined ? 1 : Number(step.min);
        const max = step.max === undefined || step.max === '' ? null : Number(step.max);
        if (count < min || (max !== null && count > max)) {
          if (fail(step, `${tag}：選項數 ${count} 不在 ${min}~${max ?? '∞'} 之間`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${count} 個選項`);

      } else if (step.action === 'assert_absent') {
        // selector 與 text 至少要有一個，兩個都空的話這顆積木什麼都沒檢查卻會顯示通過
        if (!step.selector && !step.text) {
          criticalFails.push(`${tag}：選擇器與文字都沒填，這顆積木沒有檢查任何東西`);
          notes.push(`❌ ${tag}：選擇器與文字都沒填`);
          break;
        }
        const found = await ctx.page.evaluate(({ selector, text }) => {
          if (selector) {
            const el = document.querySelector(selector);
            if (el && (el.offsetParent !== null || el.getClientRects().length)) return { by: 'selector', shown: (el.innerText || '').slice(0, 80) };
          }
          if (text && (document.body.innerText || '').includes(text)) return { by: 'text', shown: text };
          return null;
        }, { selector: step.selector ?? null, text: step.text ?? null });
        if (found) { if (fail(step, `${tag}：不該出現的${found.by === 'text' ? '文字' : '元素'}出現了（${found.shown}）`) === 'stop') break; continue }
        notes.push(`✅ ${tag}`);

      } else if (step.action === 'read_block') {
        const labels = toLines(step.labels);
        const got = await ctx.page.evaluate(({ selector, labels }) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const text = el.innerText || '';
          const out = {};
          for (const label of labels) {
            const idx = text.indexOf(label);
            out[label] = idx === -1 ? null : (text.slice(idx + label.length, idx + label.length + 40).trim().split('\n')[0] || '');
          }
          return out;
        }, { selector: step.selector, labels });
        if (got === null) { if (fail(step, `${tag}：找不到區塊 ${step.selector}`) === 'stop') break; continue }
        if (!setVar(step, tag, step.as, 'blockFields', got)) break;
        notes.push(`${tag}：${Object.entries(got).map(([k, v]) => `${k}=${v ?? '(缺)'}`).join(', ')}`);

      } else if (step.action === 'read_table') {
        const rows = await ctx.page.evaluate(({ selector, maxRows }) => {
          // Element UI 把表頭與表身拆成兩個 <table>（.el-table__header / .el-table__body），
          // 用單一 table 選擇器只會拿到其中一個——實測後台頁面 querySelector('table')
          // 抓到的是表頭那張，tbody tr 是 0 筆。所以表頭與表身要分開找。
          const headers = [...document.querySelectorAll('.el-table__header th, table thead th')]
            .map(th => (th.innerText || '').trim());
          let body = [...document.querySelectorAll('.el-table__body tr')];
          if (!body.length) {
            const table = document.querySelector(selector);
            if (!table) return null;
            body = [...table.querySelectorAll('tbody tr')];
          }
          if (!headers.length && !body.length) return null;
          return body.slice(0, maxRows).map(tr => {
            const cells = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());
            const row = {};
            cells.forEach((c, idx) => { row[headers[idx] || `col${idx}`] = c });
            return row;
          });
        }, { selector: step.selector || 'table', maxRows: Number(step.maxRows) || 200 });
        if (rows === null) { if (fail(step, `${tag}：找不到表格 ${step.selector || 'table'}`) === 'stop') break; continue }
        if (!setVar(step, tag, step.as, 'tableRows', rows)) break;
        notes.push(`${tag}：讀到 ${rows.length} 列`);

      } else if (step.action === 'assert_filled') {
        const src = needVar(step, tag, step.from, def.inputKind);
        if (src === undefined) break;
        const missing = Object.entries(src).filter(([, v]) => v === null || String(v).trim() === '').map(([k]) => k);
        if (missing.length) { if (fail(step, `${tag}：${missing.join('、')} 沒有值`) === 'stop') break; continue }
        notes.push(`✅ ${tag}`);

      } else if (step.action === 'assert_equals') {
        // 引用不存在的變數要在這裡就攔下來，不然 resolveRef 會回 undefined，
        // 訊息變成「取不到值」，看不出是打錯變數名還是畫面真的沒有那個欄位
        for (const ref of [step.left, step.right]) {
          const root = String(ref).split('.')[0];
          if (/^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(String(ref)) && !(root in vars)) {
            criticalFails.push(`${tag}：引用了不存在的變數「${root}」`);
            notes.push(`❌ ${tag}：引用了不存在的變數「${root}」`);
            return finish();
          }
        }
        const flat = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.value]));
        const l = toNumber(resolveRef(flat, step.left));
        const r = toNumber(resolveRef(flat, step.right));
        if (l === undefined || r === undefined) {
          if (fail(step, `${tag}：取不到值（${step.left}=${l ?? '?'}, ${step.right}=${r ?? '?'}）`) === 'stop') break; continue;
        }
        const tol = step.tolerancePct === undefined ? 1 : Number(step.tolerancePct);
        if (!numbersEqual(l, r, tol)) { if (fail(step, `${tag}：${l} ≠ ${r}（容差 ${tol}%）`) === 'stop') break; continue }
        notes.push(`✅ ${tag}：${l} ≈ ${r}`);

      } else if (step.action === 'assert_sorted') {
        const rows = needVar(step, tag, step.from, def.inputKind);
        if (rows === undefined) break;
        const vals = rows.map(r => toNumber(r[step.column])).filter(v => v !== undefined);
        const desc = (step.direction ?? 'desc') === 'desc';
        const bad = vals.findIndex((v, k) => k > 0 && (desc ? v > vals[k - 1] : v < vals[k - 1]));
        if (bad !== -1) { if (fail(step, `${tag}：第 ${bad + 1} 列開始排序不符（${step.column}）`) === 'stop') break; continue }
        notes.push(`✅ ${tag}：${vals.length} 列排序正確`);

      } else if (step.action === 'screenshot') {
        const shot = await ctx.takeScreenshot(step.name || `step${i + 1}`);
        if (shot) { allShotPaths.push(shot); notes.push(`${tag}：${step.name || `step${i + 1}`}`) }
        else if (fail(step, `${tag}：截圖失敗`) === 'stop') break;

      } else if (step.action === 'mark_manual') {
        manual = true;
        manualReason = step.reason || '需人工確認';
        notes.push(`⚠️ MANUAL: ${manualReason}`);
        break; // 標成需人工就不用再往下跑

      } else if (step.action === 'builtin_verifier') {
        let options = {};
        if (step.options) {
          try { options = typeof step.options === 'string' ? JSON.parse(step.options) : step.options }
          catch { notes.push(`⚠️ ${tag}：參數不是合法 JSON，改用預設值`) }
        }
        const r = await ctx.callBuiltin(step.name, options);
        if (r?.notes) notes.push(r.notes);
        if (r?.criticalFails?.length) criticalFails.push(...r.criticalFails);
        if (r?.manual) { manual = true; manualReason = manualReason || '內建驗證器判定需人工' }
        if (Array.isArray(r?.allShotPaths)) allShotPaths.push(...r.allShotPaths);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (fail(step, `${tag}：執行例外 ${message}`) === 'stop') break;
    }
  }

  return finish();

  /**
   * 判定優先序：有 criticalFails → FAIL；否則有 manual → MANUAL；否則 PASS。
   *
   * ⚠️ 但 `pass` 這個欄位在 run-lark-tc-backend.js 的慣例裡是「**有沒有硬失敗**」，
   * 不是「最終判定是不是 PASS」——manual 的 TC 在既有 verifier 裡回的是
   * `pass: true` 搭配 `manual: true`，外層才用兩者組合出結論：
   *     if (result.pass && result.manual) skipCount++      // 需人工
   *     else if (result.pass) passCount++
   *     else failCount++                                    // ← pass:false 就是失敗
   * 所以這裡不能寫成 `&& !manual`：那會讓每一筆需人工的 TC 被算成失敗、
   * 也會跟同一支測試裡沒拆解的 TC 統計方式不一致。
   * （拆 Dashboard 時用「拆解前後跑同一輪比對」才抓到，光看程式碼看不出來。）
   */
  function finish() {
    return {
      pass: criticalFails.length === 0,
      manual,
      manualReason,
      notes: notes.join(' | '),
      criticalFails,
      allShotPaths,
      error: criticalFails[0] ?? null,
    };
  }
}
