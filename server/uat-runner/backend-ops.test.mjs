/**
 * server/uat-runner/backend-ops.test.mjs
 *
 * 驗「在 H5／PC 腳本中間跑一段後台設定」這支執行器（`backend-ops.js`）。
 *
 * ⚠️ 這裡的重點**不是「照著跑得對」**，是三件會讓人拿到假結果的事：
 *   ① 不支援的動作要在**跑之前**就擋下來並指名——不能跳過（H5 引擎對不認得的
 *      動作是跳過不是失敗，v4.167.0 咬過：腳本照樣 PASS）
 *   ② 帳密**不可以出現在任何一行日誌或錯誤訊息**裡
 *   ③ 失敗時 context 要收掉，不能留著
 *
 * 用假的 browser／page（stub）跑，不開真瀏覽器——要驗的是判斷與收尾，不是 Playwright。
 * 真正點得到後台那件事由使用者實機驗證，這支不宣稱驗過那個。
 *
 * 跑法：node server/uat-runner/backend-ops.test.mjs
 */
import { runBackendOps, unsupportedBackendOps, BACKEND_OP_ACTIONS, createBackendOpContext } from './backend-ops.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const PASSWORD = 'sup3r-secret-pw';
const USERNAME = 'qa-user@toppath.test';

/** 記錄 context 開了幾個、關了幾個——「失敗時有沒有收乾淨」只有這樣看得出來 */
function stubBrowser({ locatorCount = 1, failOn = null } = {}) {
  const state = { opened: 0, closed: 0, goto: [], clicked: [], filled: [], closedPages: 0 };
  const locator = (selector) => ({
    count: async () => (selector.includes('password') || selector.includes('user') ? 1 : locatorCount),
    first() { return this },
    fill: async (value) => { state.filled.push([selector, value]) },
    click: async () => {
      if (failOn && selector.includes(failOn)) throw new Error(`點不到 ${selector}`);
      state.clicked.push(selector);
    },
    selectOption: async () => {},
    press: async () => {},
  });
  const page = {
    locator,
    goto: async (url) => { state.goto.push(url) },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  const browser = {
    newContext: async () => {
      state.opened++;
      return { newPage: async () => page, close: async () => { state.closed++ } };
    },
  };
  return { browser, state, page };
}

// ── ① 不支援的動作要在跑之前就擋，而且指名 ────────────────────────────────
{
  const { browser, state } = stubBrowser();
  const result = await runBackendOps(browser, {
    backendUrl: 'https://cp.example/', username: USERNAME, password: PASSWORD,
    title: '開啟 XX 開關',
    steps: [{ action: 'set_checked', selector: '#sw', checked: true }, { action: 'run_export' }],
  });
  check('① ⚠️ 含不支援的動作 → 失敗（不是跳過）', result.ok === false, JSON.stringify(result));
  check('① 錯誤訊息指名是哪一個動作',
    result.fails.some(f => f.includes('run_export')), JSON.stringify(result.fails));
  check('① 而且列得出支援哪些',
    result.fails.some(f => f.includes('set_checked')), JSON.stringify(result.fails));
  check('① ⚠️ 擋下來時**完全沒有開過瀏覽器**（不能跑到一半才發現）',
    state.opened === 0, `開了 ${state.opened} 個 context`);
}

// ── ② 帳密不可以外流到日誌 ────────────────────────────────────────────────
// ⚠️ 這條**一定要造出「不遮就會外流」的情況**，否則它是空的。第一版只是隨便失敗
//    一下，錯誤訊息裡本來就沒有密碼——把整段遮蔽拿掉也照樣綠（注入測試抓到）。
//    Playwright 的錯誤訊息**真的會把填進去的值印出來**，所以這裡讓 fill 丟出一個
//    含密碼的錯誤，才驗得到遮蔽這件事。
{
  const { browser } = stubBrowser();
  const lines = [];
  const realNewContext = browser.newContext;
  browser.newContext = async () => {
    const context = await realNewContext();
    const realNewPage = context.newPage;
    context.newPage = async () => {
      const page = await realNewPage();
      const realLocator = page.locator.bind(page);
      page.locator = (selector) => {
        const base = realLocator(selector);
        if (selector.includes('password')) {
          return { ...base, fill: async (value) => { throw new Error(`locator.fill: value="${value}" timeout`) } };
        }
        return base;
      };
      return page;
    };
    return context;
  };
  const result = await runBackendOps(browser, {
    backendUrl: 'https://cp.example/', username: USERNAME, password: PASSWORD,
    title: '開啟 XX 開關', onNote: (line) => lines.push(line),
    steps: [{ action: 'set_checked', selector: '#sw', checked: true }],
  });
  const everything = [...lines, ...result.notes, ...result.fails].join('\n');
  check('② fixture：真的產生了一個含密碼的錯誤（否則下面兩條是空的）',
    result.fails.length > 0 && everything.includes('locator.fill'), everything.slice(0, 300));
  check('② ⚠️ 密碼沒有出現在任何一行', !everything.includes(PASSWORD), everything.slice(0, 300));
  check('② ⚠️ 帳號也沒有', !everything.includes(USERNAME), everything.slice(0, 300));
}

// ── ③ 缺帳密要明講，而且不要開瀏覽器 ──────────────────────────────────────
{
  const { browser, state } = stubBrowser();
  const result = await runBackendOps(browser, {
    backendUrl: 'https://cp.example/', username: '', password: '',
    steps: [{ action: 'set_checked', selector: '#sw', checked: true }],
  });
  check('③ 沒有帳密 → 失敗並講清楚怎麼補',
    result.ok === false && result.fails.some(f => f.includes('帳密')), JSON.stringify(result.fails));
  check('③ ⚠️ 而且沒有開瀏覽器', state.opened === 0);
}

// ── ④ 空片段不能算成功 ────────────────────────────────────────────────────
{
  const { browser } = stubBrowser();
  const result = await runBackendOps(browser, {
    backendUrl: 'https://cp.example/', username: USERNAME, password: PASSWORD, title: '空的', steps: [],
  });
  check('④ ⚠️ 沒有步驟的片段要失敗（零操作不等於設定成功）',
    result.ok === false, JSON.stringify(result));
}

// ── ⑤ 跑完要把 context 收掉——成功與失敗都要 ──────────────────────────────
{
  const ok = stubBrowser();
  await runBackendOps(ok.browser, {
    backendUrl: 'https://cp.example/', username: USERNAME, password: PASSWORD,
    steps: [{ action: 'wait', waitMs: 1 }],
  });
  check('⑤ 成功時 context 有收', ok.state.opened === 1 && ok.state.closed === 1,
    `opened=${ok.state.opened} closed=${ok.state.closed}`);

  const bad = stubBrowser({ failOn: 'password' });
  bad.page.goto = async () => { throw new Error('後台連不上') };
  const result = await runBackendOps(bad.browser, {
    backendUrl: 'https://cp.example/', username: USERNAME, password: PASSWORD,
    steps: [{ action: 'wait', waitMs: 1 }],
  });
  check('⑤ ⚠️ 失敗時 context 也要收（不收的話壓測跑久了會把記憶體吃光）',
    bad.state.opened === 1 && bad.state.closed === 1,
    `opened=${bad.state.opened} closed=${bad.state.closed}`);
  check('⑤ 而且失敗有回報', result.ok === false && result.fails.length > 0, JSON.stringify(result.fails));
}

// ── ⑥ 設定操作必須唯一命中 ────────────────────────────────────────────────
// ⚠️ 前端腳本有座標備援（canvas 沒有 DOM 可指），**後台不能有**：
//    按錯位置等於改到別的設定，而且你不會知道。
{
  const ctx = createBackendOpContext(
    stubBrowser({ locatorCount: 3 }).page, { baseUrl: 'https://cp.example/' });
  let threw = '';
  try { await ctx.clickSelector('.btn', 0) } catch (e) { threw = e.message }
  check('⑥ ⚠️ 命中多筆時點擊要拒絕（不做座標備援）',
    threw.includes('必須唯一'), threw || '(沒有拋出)');

  let typeThrew = '';
  try { await ctx.typeInto('.field', 'x') } catch (e) { typeThrew = e.message }
  check('⑥ ⚠️ 輸入也一樣', typeThrew.includes('必須唯一'), typeThrew || '(沒有拋出)');
}

// ── ⑦ allowlist 的內容 ────────────────────────────────────────────────────
{
  check('⑦ ⚠️ 斷言類動作不在允許清單裡（設定片段不該自己判 pass/fail）',
    !BACKEND_OP_ACTIONS.some(a => a.startsWith('assert_')), BACKEND_OP_ACTIONS.join(','));
  check('⑦ ⚠️ 回寫類動作也不在（設定不該去改 Lark 的 TC 結果）',
    !BACKEND_OP_ACTIONS.includes('set_tc_result') && !BACKEND_OP_ACTIONS.includes('mark_manual'),
    BACKEND_OP_ACTIONS.join(','));
  check('⑦ 開關要在（不然這個功能沒有意義）', BACKEND_OP_ACTIONS.includes('set_checked'));
  check('⑦ 空動作名也算不支援', unsupportedBackendOps([{ action: '' }]).length === 1);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
