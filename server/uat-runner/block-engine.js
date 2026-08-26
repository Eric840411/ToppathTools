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
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_column_exists: {
    label: '表格必須有這一欄', category: 'assert', defaultOnFail: 'stop',
    description: '表頭要有指定的欄位名稱',
    params: [
      { key: 'columns', label: '欄位名稱（一行一個）', type: 'textarea', required: true },
      { key: 'selector', label: '表格 selector', type: 'text', default: 'table', placeholder: 'table' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_option_count: {
    label: '下拉選項數量', category: 'assert', defaultOnFail: 'stop',
    description: '下拉選單要存在，選項數量要符合',
    params: [
      { key: 'labelText', label: '用欄位標籤定位（建議）', type: 'text', placeholder: 'Channel ID', help: '同一頁常有好幾個下拉，抓「第一個」會抓錯。填標籤文字就會找那個標籤旁邊的下拉' },
      { key: 'selector', label: '下拉 selector', type: 'text', placeholder: '.el-select .el-input__inner', help: '沒填標籤時才用' },
      { key: 'min', label: '至少幾個', type: 'number', default: 1 },
      { key: 'max', label: '最多幾個（留空不限）', type: 'number' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_labels_contain: {
    label: '表單控制項必須有這些', category: 'assert', defaultOnFail: 'stop',
    description: '搜尋欄位／勾選框／單選鈕裡要有指定的項目',
    params: [
      { key: 'source', label: '找哪一種控制項', type: 'select', required: true, default: 'formLabel',
        options: ['formLabel', 'checkboxLabel', 'radioLabel'],
        help: 'formLabel=搜尋欄位標籤、checkboxLabel=勾選框、radioLabel=單選鈕。表格欄位請用「表格必須有這一欄」' },
      { key: 'expect', label: '該有的項目（一行一個）', type: 'textarea', required: true },
      { key: 'match', label: '比對方式', type: 'select', options: ['exact', 'contains'], default: 'exact',
        help: '既有 verifier 用的是完全相等（labels.includes），改成 contains 會比較鬆' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_element_count: {
    label: '元素數量', category: 'assert', defaultOnFail: 'stop',
    description: '畫面上符合這個選擇器的元素要有幾個',
    params: [
      { key: 'selector', label: '選擇器', type: 'text', required: true, placeholder: '.el-date-editor' },
      { key: 'label', label: '這是什麼（錯誤訊息用）', type: 'text', placeholder: '日期篩選',
        help: '不填的話錯誤訊息只會出現選擇器，讀的人要自己去猜那是什麼' },
      { key: 'min', label: '至少幾個', type: 'number', default: 1 },
      { key: 'max', label: '最多幾個（留空不限）', type: 'number' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_row_buttons: {
    label: '表格列要有這些按鈕', category: 'assert', defaultOnFail: 'stop',
    description: '看表格第一列有沒有 Edit／Delete／View 這些操作按鈕',
    params: [
      { key: 'buttons', label: '每一個都要有（一行一個）', type: 'textarea', required: true, placeholder: 'Edit / Delete' },
      { key: 'rows', label: '要檢查哪些列', type: 'select', options: ['first', 'all'], default: 'first',
        help: 'first 只看第一列（快）；all 每一列都要有——「每一列都可以編輯／刪除」這種規格要用 all，只看第一列會漏掉後面壞掉的列' },
      { key: 'anyOf', label: '這些至少要有一個（一行一個，選填）', type: 'textarea',
        help: '有些頁面是 Hidden 或 Show 二選一，那種放這裡' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
      { key: 'onEmptyTable', label: '表格沒資料時', type: 'select', options: ['warn', 'continue', 'stop', 'manual'], default: 'warn',
        help: '沒有列就看不到列上的按鈕。既有驗證器是直接跳過不擋（rowCount > 0 才判定），這裡預設記成 warn' },
    ],
  },
  assert_row_count: {
    label: '表格筆數', category: 'assert', defaultOnFail: 'warn',
    description: '表格至少要有幾筆。預設是 warn——沒資料通常代表當下環境沒樣本，不是功能壞了',
    params: [
      { key: 'min', label: '至少幾筆', type: 'number', default: 1 },
      { key: 'max', label: '最多幾筆（留空不限）', type: 'number', help: '例如「只能新增一個廣告配置」就填 1' },
      { key: 'onFail', label: '不符時', type: 'select', options: ['warn', 'stop', 'continue', 'manual'], default: 'warn' },
    ],
  },
  assert_api_called: {
    label: '這支 API 必須被呼叫', category: 'assert', defaultOnFail: 'stop',
    description: '這一步要打到指定的後端 API，而且狀態碼要符合',
    params: [
      { key: 'urlPattern', label: 'API 網址（可用 * 當萬用字元）', type: 'text', required: true,
        placeholder: 'http://uat-cp.osmslot.org/api/egm/update/*',
        help: '從錄製畫面的 API 清單點過來時會自動填。id／token 那些位置要用 *，不然換一筆資料就對不上' },
      { key: 'expectStatus', label: '狀態碼要求', type: 'select', options: ['2xx', 'any', 'exact'], default: '2xx' },
      { key: 'statusCode', label: '指定狀態碼（上面選 exact 才用）', type: 'number', placeholder: '200' },
      { key: 'minCount', label: '至少被呼叫幾次', type: 'number', default: 1 },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  submit_search: {
    label: '送出查詢', category: 'nav', defaultOnFail: 'stop',
    description: '按報表頁的 View／Search 送出查詢。很多頁面要查過之後才會出現資料與匯出按鈕',
    params: [
      { key: 'waitMs', label: '查完等待（毫秒）', type: 'number', default: 2500 },
      { key: 'onFail', label: '找不到查詢按鈕時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  run_export: {
    label: '執行匯出', category: 'evidence', defaultOnFail: 'stop',
    description: '點 Export／CSV／Excel 按鈕，有確認視窗就按 Sure，並等下載',
    params: [
      { key: 'onFail', label: '找不到匯出按鈕時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
      { key: 'onNoDownload', label: '等不到下載時', type: 'select', options: ['warn', 'continue', 'stop', 'manual'], default: 'warn',
        help: '原本的驗證器把「等不到下載」記成成功。它不是失敗條件，但確實是可觀測的異常——預設用 warn 記下來，判定不受影響' },
      { key: 'timeoutMs', label: '等下載幾毫秒', type: 'number', default: 10000 },
    ],
  },
  assert_dialog_fields: {
    label: '開對話框檢查欄位', category: 'assert', defaultOnFail: 'stop',
    description: '點一個按鈕把對話框叫出來，確認裡面有這些欄位，然後關掉',
    params: [
      { key: 'trigger', label: '要點的按鈕文字', type: 'text', required: true, placeholder: 'Add' },
      { key: 'fields', label: '對話框裡該有的欄位（一行一個）', type: 'textarea', required: true },
      { key: 'scope', label: '按鈕在哪', type: 'select', options: ['page', 'firstRow', 'openDialog'], default: 'page', help: 'firstRow 只在表格第一列裡找（例如每列各自的 Edit）；openDialog 在前一步打開的面板裡找' },
      { key: 'onFail', label: '對話框開不起來時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
      // 「對話框沒開」跟「對話框開了但少一個欄位」是不同等級的問題：前者代表功能壞了，
      // 後者可能只是規格調整。既有 verifier 就是這樣分的（前者 criticalFail、後者只寫 ⚠️），
      // 一顆 onFail 管兩種會逼人在「全都擋」跟「全都不擋」之間選，兩個都不對。
      { key: 'onMissingFields', label: '欄位缺少時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], help: '留空就跟上面一樣' },
    ],
  },
  assert_absent: {
    label: '不能出現', category: 'assert', defaultOnFail: 'stop',
    description: '這個元素不能存在，或這段文字不能出現在畫面上',
    params: [
      { key: 'selector', label: '不能出現的選擇器', type: 'text', placeholder: '.el-message--error' },
      { key: 'text', label: '不能出現的文字', type: 'text', placeholder: '查無資料' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
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
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
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
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
    ],
  },
  assert_sorted: {
    label: '排序必須正確', category: 'assert', inputKind: 'tableRows', defaultOnFail: 'stop',
    description: '檢查表格某一欄是遞增或遞減',
    params: [
      { key: 'from', label: '來源變數（表格）', type: 'text', required: true },
      { key: 'column', label: '欄位名稱', type: 'text', required: true },
      { key: 'direction', label: '方向', type: 'select', options: ['desc', 'asc'], default: 'desc' },
      { key: 'onFail', label: '失敗時', type: 'select', options: ['stop', 'continue', 'warn', 'manual'], default: 'stop' },
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
/**
 * 把「只有 * 是萬用字元」的字面樣式轉成 RegExp。
 * 其餘字元全部逸出，使用者不會不小心寫出一個真的 regex 然後被自己的 . 或 ? 咬到。
 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern).split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export async function runSteps(steps, ctx) {
  const notes = [];
  const criticalFails = [];
  const warnings = [];   // warn 級別：有檢查、有異常，但不影響 pass 判定
  /** 網路斷言的時間界線。每次 open_page 之後往前推，只問「這之後打了什麼」 */
  let netMark = Date.now();
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
    // warn：有檢查、有異常、但不擋流程。既有 verifier 裡大量存在的
    // `notes.push(ok ? '✅' : '⚠️未找到')` 就是這個語意——少了這一種，轉換時只能
    // 在「當成一般斷言」跟「不拆」之間二選一，而選前者會讓 verifier 悄悄變嚴格。
    //
    // 刻意不影響 pass 判定，也刻意不做「同一筆超過 N 個 warn 就升級成 fail」
    // （跟 CodeX 討論定案）：那會變成隱性 fail——畫面顯示 PASS，卻可能被一條
    // 數量規則翻掉，規則變得不能解釋。真的需要門檻的話應該做成獨立的報表 gate，
    // 不是塞進單筆執行結果裡。
    if (mode === 'warn') {
      warnings.push(message);
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
        // ⚠️ 界線要設在導頁**之前**。
        // openPath 會等到 networkidle 才回來——設在它後面的話，頁面載入時打的 API
        // 全部落在界線之前，assert_api_called 會永遠看到 0 支。而「開這頁時打了哪些
        // 後端」正是最常要驗的東西。實測才發現（單元測試是直接餵假資料，蓋不到這段）。
        netMark = Date.now();
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
        // 有 labelText 就照 verifier 的做法：先找那個標籤，再取它同一個 form-item 裡的下拉。
        // 抓「頁面第一個 .el-select」會在多下拉的頁面抓錯——EGM JP Percent 就是這樣數到 0 個選項的。
        const opened = await ctx.page.evaluate(({ labelText, selector }) => {
          let el = null;
          if (labelText) {
            const label = [...document.querySelectorAll('label, span, .el-form-item__label')]
              .find(l => (l.innerText || '').trim() === labelText);
            el = label?.closest('.el-form-item, div')?.querySelector('.el-select .el-input__inner, select');
          }
          if (!el && selector) el = document.querySelector(selector);
          if (!el) return false;
          el.click();
          window.__uatOptionTarget = el;
          return true;
        }, { labelText: step.labelText || '', selector: step.selector || '' });
        if (!opened) { if (fail(step, `${tag}：找不到下拉（${step.labelText || step.selector || '未指定'}）`) === 'stop') break; continue }
        await ctx.page.waitForTimeout(500);
        const count = await ctx.page.evaluate(() => {
          const el = window.__uatOptionTarget;
          if (el && el.options) return el.options.length;                       // 原生 select
          const inEl = el ? el.querySelectorAll('option, li').length : 0;
          if (inEl) return inEl;
          // Element UI 的下拉面板是掛在 body 底下的，不在原本那個元素裡面
          const panels = [...document.querySelectorAll('.el-select-dropdown')]
            .filter(p => p.style.display !== 'none');
          const items = panels.flatMap(p => [...p.querySelectorAll('.el-select-dropdown__item')]);
          if (items.length) return items.length;
          return 0;
        });
        const min = step.min === undefined ? 1 : Number(step.min);
        const max = step.max === undefined || step.max === '' ? null : Number(step.max);
        if (count < min || (max !== null && count > max)) {
          if (fail(step, `${tag}：選項數 ${count} 不在 ${min}~${max ?? '∞'} 之間`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${count} 個選項`);

      } else if (step.action === 'assert_labels_contain') {
        // verifyMeterPage 裡 8 筆有 6 筆是這個形狀，只差集合來源不同：
        //   filterLabels   = .el-form-item__label   （Machine Name / Machine No）
        //   checkboxLabels = .el-checkbox__label    （Gaming Day）
        //   radioLabels    = .el-radio__label       （06:00:00-06:00:00 / 00:00:00-00:00:00）
        // 所以做成一顆帶 source 的通用積木，不是三顆各寫一次
        const SOURCES = {
          formLabel: '.el-form-item__label',
          checkboxLabel: '.el-checkbox__label',
          radioLabel: '.el-radio__label',
        };
        const sel = SOURCES[step.source ?? 'formLabel'];
        if (!sel) { if (fail(step, `${tag}：不認得的控制項種類「${step.source}」`) === 'stop') break; continue }
        const found = await ctx.page.evaluate(
          (s) => [...document.querySelectorAll(s)].map(l => (l.innerText || '').trim()).filter(Boolean), sel);
        const want = toLines(step.expect);
        const exact = (step.match ?? 'exact') === 'exact';
        const missing = want.filter(w => exact
          ? !found.includes(String(w))
          : !found.some(f => f.toLowerCase().includes(String(w).toLowerCase())));
        if (missing.length) {
          if (fail(step, `${tag}：缺少 ${missing.join('、')}（實際有：${found.join('、').slice(0, 120) || '（空的）'}）`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${want.join('、')}`);

      } else if (step.action === 'assert_element_count') {
        // ⚠️ 這顆驗的是「畫面上有幾個這種元素」這個 DOM 事實，不是抽象的功能正確。
        // 例：日期篩選查 .el-date-editor >= 2（From/To 兩個框）。頁面之後若改成
        // 單一 range picker，數量會從 2 變 1 但功能其實沒壞——那時要改的是這裡的
        // 期待值，不是把它當成「日期功能壞了」。失敗訊息也照這個講法寫。
        const count = await ctx.page.evaluate(
          (sel) => document.querySelectorAll(sel).length, step.selector);
        const min = step.min === undefined ? 1 : Number(step.min);
        const max = step.max === undefined || step.max === '' ? null : Number(step.max);
        const what = step.label || step.selector;
        if (count < min || (max !== null && count > max)) {
          if (fail(step, `${tag}：${what} 目前 ${count} 個，預期 ${min}${max !== null ? `~${max}` : ' 個以上'}（驗的是 DOM 元素數量；頁面改版導致數量變動時要改的是這個期待值）`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${what} ${count} 個`);

      } else if (step.action === 'assert_row_buttons') {
        // 既有 verifier 的形狀是：讀第一列的所有 button innerText，再檢查該有的在不在。
        // 有些頁面是 Hidden／Show 二選一，所以除了「每個都要有」還要支援「至少有一個」。
        // 「每一列都要有」跟「第一列有就好」是不同的規格。既有 verifier 兩種都有：
        //   .every(row => ...)                    → 每一列（可以編輯/刪除獎池額度）
        //   document.querySelector('...tr')       → 只看第一列（視頻可以編輯/刪除/預覽）
        // 只做第一列的話，後面某一列缺按鈕會漏掉。
        const allRows = await ctx.page.evaluate(() =>
          [...document.querySelectorAll('.el-table__body tr')]
            .map(row => [...row.querySelectorAll('button, .el-button')].map(b => (b.innerText || '').trim()).filter(Boolean)));
        const rowBtns = allRows.length ? allRows[0] : null;
        if (rowBtns === null) {
          // 沒有列就看不到列上的按鈕。既有 verifier 是 rowCount > 0 才判定，等於直接跳過
          const empty = { ...step, onFail: step.onEmptyTable ?? 'warn' };
          if (fail(empty, `${tag}：表格目前沒有資料，看不到列上的按鈕`) === 'stop') break; continue;
        }
        const need = toLines(step.buttons);
        const anyOf = toLines(step.anyOf);
        const scanRows = (step.rows ?? 'first') === 'all' ? allRows : [rowBtns];
        const okRow = (btns) => need.every(b => btns.includes(String(b)))
          && (!anyOf.length || anyOf.some(b => btns.includes(String(b))));
        const badIdx = scanRows.findIndex(btns => !okRow(btns));
        const bad = badIdx >= 0 ? scanRows[badIdx] : null;
        const missing = bad ? need.filter(b => !bad.includes(String(b))) : [];
        const anyOk = !bad || !anyOf.length || anyOf.some(b => bad.includes(String(b)));
        if (bad) {
          const why = [
            missing.length ? `缺少 ${missing.join('、')}` : '',
            anyOk ? '' : `${anyOf.join(' 或 ')} 一個都沒有`,
          ].filter(Boolean).join('；');
          const where = (step.rows ?? 'first') === 'all' ? `第 ${badIdx + 1} 列` : '第一列';
          if (fail(step, `${tag}：${where}${why}（該列實際有：${bad.join('、') || '（沒有按鈕）'}）`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${[...need, ...(anyOf.length ? [anyOf.join('/')] : [])].join('、')}（檢查了 ${scanRows.length} 列）`);

      } else if (step.action === 'assert_row_count') {
        const rowCount = await ctx.page.evaluate(() =>
          document.querySelectorAll('.el-table__body tr, table tbody tr').length);
        const min = step.min === undefined ? 1 : Number(step.min);
        const rowMax = step.max === undefined || step.max === '' ? null : Number(step.max);
        if (rowCount < min) {
          if (fail(step, `${tag}：只有 ${rowCount} 筆，少於 ${min} 筆`) === 'stop') break; continue;
        }
        if (rowMax !== null && rowCount > rowMax) {
          if (fail(step, `${tag}：有 ${rowCount} 筆，超過上限 ${rowMax} 筆`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${rowCount} 筆`);

      } else if (step.action === 'assert_api_called') {
        // 很多成功／失敗根本不在 DOM，在 API 有沒有送出、回什麼碼。這顆補的就是那一層。
        //
        // 只看「這一步之後」打的：netMark 每次 open_page 之後往前推，所以問的是
        // 「開了這頁、做了這些操作之後有沒有打到它」，不是整輪跑下來有沒有出現過。
        if (typeof ctx.netCallsSince !== 'function') {
          if (fail(step, `${tag}：這個執行環境沒有網路紀錄可查（runner 版本太舊）`) === 'stop') break; continue;
        }
        const calls = ctx.netCallsSince(netMark) ?? [];
        const rx = wildcardToRegExp(step.urlPattern);
        const matched = calls.filter(c => rx.test(String(c.url ?? '')) || rx.test(String(c.urlPattern ?? '')));
        const mode = step.expectStatus ?? '2xx';
        const statusOk = (c) => {
          if (mode === 'any') return true;
          if (mode === 'exact') return Number(c.status) === Number(step.statusCode);
          return Number(c.status) >= 200 && Number(c.status) < 300;
        };
        const good = matched.filter(statusOk);
        const need = step.minCount === undefined ? 1 : Number(step.minCount);
        if (good.length < need) {
          const why = matched.length
            ? `打到了 ${matched.length} 次但狀態碼不符（實際：${[...new Set(matched.map(c => c.status))].join('、')}）`
            : `完全沒有打到這支 API（這一步總共打了 ${calls.length} 支）`;
          if (fail(step, `${tag}：${step.urlPattern} —— ${why}`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${step.urlPattern}（${good.length} 次，狀態 ${[...new Set(good.map(c => c.status))].join('、')}）`);

      } else if (step.action === 'submit_search') {
        // 報表頁要先送出查詢才會有資料與匯出按鈕。View／Search 兩種字都要試——
        // 不同報表頁用的不一樣，逐頁去猜是錯的做法（原本的 screenshot_date_search 就是兩個都試）
        if (typeof ctx.submitSearch !== 'function') {
          if (fail(step, `${tag}：這個執行環境不支援送出查詢（runner 版本太舊）`) === 'stop') break; continue;
        }
        const searched = await ctx.submitSearch(Number(step.waitMs) || 2500);
        if (!searched) { if (fail(step, `${tag}：找不到 View／Search 按鈕`) === 'stop') break; continue }
        notes.push(`${tag}：已送出`);

      } else if (step.action === 'run_export') {
        // doExport() 在 run-lark-tc-backend.js 裡已經是單一共用函式，14 個呼叫點
        // 完全同形、零參數——所以這顆積木也不需要參數，只是把它包成積木。
        // 語意照原本的：只有「按鈕找不到」才是失敗。
        if (typeof ctx.runExport !== 'function') {
          if (fail(step, `${tag}：這個執行環境沒有匯出能力（runner 版本太舊）`) === 'stop') break; continue;
        }
        const ex = await ctx.runExport(Number(step.timeoutMs) || 10000);
        if (!ex.hasButton) {
          if (fail(step, `${tag}：找不到 Export／CSV／Excel 按鈕`) === 'stop') break; continue;
        }
        if (!ex.file) {
          // 按鈕在、也點了，只是沒等到檔案。原本記成 ✅——判定不變，但要記成 warn，
          // 不然看報告的人會以為檔案一定成功落地了
          const noDl = { ...step, onFail: step.onNoDownload ?? 'warn' };
          if (fail(noDl, `${tag}：按鈕有、也點下去了，但在 ${Number(step.timeoutMs) || 10000}ms 內沒等到下載`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：已下載 ${ex.file}`);

      } else if (step.action === 'assert_dialog_fields') {
        // 這是既有 verifier 裡重複最多次的一段：點 Add/Edit → 等對話框 → 讀
        // .el-form-item__label → 比對該有的欄位 → 關掉。八支 verifier 各抄了一份，
        // 所以做成一顆積木而不是讓使用者用 click + 三顆斷言自己拼。
        const want = toLines(step.fields);
        const opened = await ctx.page.evaluate(({ trigger, scope }) => {
          // 後台登入後有一個站台層級的警告彈窗（「Currently N machines are abnormal」）
          // 會一直開著。不先把「現在已經開著的」標記起來，等一下就會抓到它而不是我們
          // 點開的那個——症狀是欄位讀成空的，看起來像對話框沒有欄位。
          for (const d of document.querySelectorAll('.el-dialog, .el-drawer')) {
            if (d.getBoundingClientRect().width > 0) d.setAttribute('data-uat-preexisting', '1');
          }
          const needle = String(trigger).trim().toLowerCase();
          const label = b => (b.innerText || '').trim().toLowerCase();
          // 先找完全相同的再退到包含。不這樣的話「Add」會先命中「Add Reservation」——
          // 既有 verifier 用的就是 === 精準比對，包含只是沒對到時的退路
          const pick = (root) => {
            const buttons = [...root.querySelectorAll('button, .el-button, a')];
            return buttons.find(b => label(b) === needle) ?? buttons.find(b => label(b).includes(needle)) ?? null;
          };

          let btn = null;
          if (scope === 'firstRow') {
            const row = document.querySelector('.el-table__body tr');
            if (!row) return 'no-row';
            btn = pick(row);
          } else if (scope === 'openDialog') {
            // 有些按鈕（例如 VIP 名單的 Add）只存在於前一步打開的面板裡，整頁範圍會
            // 抓到主頁上同名的那顆。
            //
            // 但也不能只取「最後一個開著的對話框」——站台層級的警告彈窗一直開著，
            // 它在 DOM 裡的位置不固定，.pop() 有時候拿到的是它。改成「在所有開著的
            // 面板裡找這顆按鈕」，找到的那個自然就是對的面板，不用猜。
            const panels = [...document.querySelectorAll('.el-dialog, .el-drawer')]
              .filter(d => d.getBoundingClientRect().width > 0);
            if (!panels.length) return 'no-dialog';
            for (const panel of panels) { btn = pick(panel); if (btn) break }
          } else {
            btn = pick(document);
          }
          if (!btn) return 'no-button';
          btn.click();
          return 'ok';
        }, { trigger: step.trigger, scope: step.scope ?? 'page' });
        if (opened !== 'ok') {
          const reason = opened === 'no-row' ? '表格沒有任何列'
            : opened === 'no-dialog' ? '前一步沒有打開任何面板（scope=openDialog 需要先有開著的對話框）'
            : `找不到按鈕「${step.trigger}」`;
          if (fail(step, `${tag}：${reason}`) === 'stop') break; continue;
        }
        await ctx.page.waitForTimeout(800);
        // 對話框可能疊很多層，且關掉的那些還留在 DOM 裡（display 不一定是 none），
        // 所以用「畫得出寬度」來判斷哪個是真的開著的，取最後一個＝最上層
        const labels = await ctx.page.evaluate(() => {
          const dialogs = [...document.querySelectorAll('.el-dialog, .el-drawer')]
            .filter(d => d.getBoundingClientRect().width > 0 && !d.hasAttribute('data-uat-preexisting'));
          const dialog = dialogs[dialogs.length - 1];
          if (!dialog) return null;
          return [...dialog.querySelectorAll('.el-form-item__label, label')]
            .map(l => (l.innerText || '').replace(/[\s*:：]/g, '')).filter(Boolean);
        });
        const closeDialog = async () => {
          await ctx.page.evaluate(() => {
            const dialogs = [...document.querySelectorAll('.el-dialog, .el-drawer')]
              .filter(d => d.getBoundingClientRect().width > 0 && !d.hasAttribute('data-uat-preexisting'));
            const dialog = dialogs[dialogs.length - 1];
            if (!dialog) return;
            const x = dialog.querySelector('.el-dialog__headerbtn, .el-drawer__close-btn');
            if (x) { x.click(); return }
            const btn = [...dialog.querySelectorAll('button')]
              .find(b => /^(close|cancel|取消|關閉)$/i.test((b.innerText || '').trim()));
            btn?.click();
          });
          await ctx.page.waitForTimeout(400);
        };
        if (labels === null) { await closeDialog(); if (fail(step, `${tag}：點了「${step.trigger}」但對話框沒開起來`) === 'stop') break; continue }
        const missing = want.filter(w => !labels.some(l => l.toLowerCase().includes(String(w).replace(/[\s*:：]/g, '').toLowerCase())));
        await closeDialog();
        if (missing.length) {
          // 欄位缺少走自己那一檔（沒設就跟 onFail 一樣），不跟「對話框開不起來」同級
          const fieldsStep = { ...step, onFail: step.onMissingFields ?? step.onFail };
          if (fail(fieldsStep, `${tag}：對話框缺少 ${missing.join('、')}（實際有：${labels.join('、').slice(0, 120)}）`) === 'stop') break; continue;
        }
        notes.push(`✅ ${tag}：${step.trigger} 對話框有 ${want.join('、')}`);

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
      // warn 刻意不進這個判定：畫面顯示 PASS 就真的是 PASS，不會被別的規則翻掉。
      // 它的價值是「有檢查、有記錄」變成結構化資料（可以統計、可以在畫面上列），
      // 而不是原本散在 notes 字串裡的一句話。
      pass: criticalFails.length === 0,
      manual,
      manualReason,
      notes: notes.join(' | '),
      criticalFails,
      warnings,
      allShotPaths,
      error: criticalFails[0] ?? null,
    };
  }
}
