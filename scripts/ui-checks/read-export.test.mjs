/**
 * 「讀取匯出檔」積木的測試。
 *
 *   node scripts/ui-checks/read-export.test.mjs
 *
 * 這顆積木補的是一個真實的缺口：原本 Daily Dashboard 那支**寫死的驗證器**做的是
 * 三方比對（Dashboard 色塊 ↔ 另一頁 DayCount 表格 ↔ 匯出的 xlsx，六個欄位一起對），
 * 而積木這邊只有 `assert_export_matches_screen`——一個鍵欄對一個值欄、而且只能對
 * 同一頁的畫面。差別在於**匯出的數字沒有地方可以放**。讀成變數之後，就能用既有的
 * 「兩值必須相等」任意組合。
 *
 * 所以這裡釘住的重點是：
 *   ① 讀進來的值**真的能被後面的比對引用**（端到端跑 read → assert_equals）
 *   ② 日期欄常常帶時間（2026-09-20 00:00:00），要吃得下「開頭相符」
 *   ③ **沒拿到檔案 ≠ 內容不符**——訊息要講「沒有拿到可解析的檔案」，
 *      不然後面每顆比對都會變成「引用了不存在的變數」，看起來像變數名打錯
 *   ④ 找不到欄位／找不到那一列，都要指名是哪一個
 */
import assert from 'node:assert/strict';
import { runSteps } from '../../server/uat-runner/block-engine.js';

const HEADERS = ['Date', 'Bet User', 'Total Bet', 'Win Or Lose'];
const ROWS = [
  ['2026-09-19 00:00:00', '120', '3,500.5', '-220'],
  ['2026-09-20 00:00:00', '138', '4,120.25', '310'],
];

/** 假 ctx：只提供積木會用到的那幾個能力 */
const ctx = (over = {}) => ({
  page: { evaluate: async () => ({}), waitForTimeout: async () => {} },
  runExport: async () => ({ hasButton: true, file: 'daily.xlsx', headers: HEADERS, rows: ROWS }),
  screenshot: async () => null,
  ...over,
});

const run = (steps, over) => runSteps(steps, ctx(over), {});

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`);
  ok ? pass++ : fail++;
};

console.log('讀取匯出檔（read_export）');

// ① 端到端：讀出來的值要能被「兩值必須相等」引用
{
  const r = await run([
    { action: 'read_export', name: '讀匯出', as: 'exported', keyColumn: 'Date', keyValue: '2026-09-20' },
    { action: 'assert_equals', name: '投注人數要一致', left: 'exported.BetUser', right: '138', tolerancePct: 0, absoluteTolerance: 0 },
  ]);
  check('① 讀到的值能被後面的比對引用（欄名有空格時用去空格的別名）', r.criticalFails.length === 0, r.criticalFails[0] ?? r.notes);
}
{
  const r = await run([
    { action: 'read_export', name: '讀匯出', as: 'exported', keyColumn: 'Date', keyValue: '2026-09-20' },
    { action: 'assert_equals', name: '故意對錯', left: 'exported.TotalBet', right: '999', tolerancePct: 0, absoluteTolerance: 0 },
  ]);
  check('① 對不上時要紅（不是沉默通過）', r.criticalFails.length > 0, r.notes);
  check('① 千分位吃得下（4,120.25 → 4120.25）', /4120\.25/.test(r.notes), r.notes);
}

// ② 日期帶時間
{
  const r = await run([{ action: 'read_export', name: '讀匯出', as: 'e', keyColumn: 'Date', keyValue: '2026-09-19' }]);
  check('② 日期欄帶時間也挑得到那一列', r.criticalFails.length === 0, r.criticalFails[0]);
}

// 整份讀成表格
{
  const r = await run([
    { action: 'read_export', name: '讀整份', as: 'all' },
    { action: 'assert_equals', name: '第二列的投注人數', left: 'all.1.BetUser', right: '138', tolerancePct: 0, absoluteTolerance: 0 },
  ]);
  check('不指定挑列時整份存成表格（可用 變數.1.欄位名）', r.criticalFails.length === 0, r.criticalFails[0] ?? r.notes);
}

// ③ 沒拿到檔案
{
  const r = await run([{ action: 'read_export', name: '讀匯出', as: 'e' }],
    { runExport: async () => ({ hasButton: true, file: null, headers: null, rows: null }) });
  check('③ 沒拿到檔案要明講（不是說內容不符）', /沒有拿到可解析的檔案/.test(r.notes), r.notes);
  check('③ 而且要算失敗（後面比對沒資料可用）', r.criticalFails.length > 0, r.notes);
}
{
  const r = await run([{ action: 'read_export', name: '讀匯出', as: 'e' }],
    { runExport: async () => ({ hasButton: false, file: null, headers: null, rows: null }) });
  check('③ 找不到匯出按鈕要分開講', /找不到 Export/.test(r.notes), r.notes);
}

// ④ 欄位／列找不到
{
  const r = await run([{ action: 'read_export', name: '讀匯出', as: 'e', keyColumn: 'NoSuchCol', keyValue: 'x' }]);
  check('④ 找不到欄位時指名是哪一欄', /找不到欄位「NoSuchCol」/.test(r.notes), r.notes);
}
{
  const r = await run([{ action: 'read_export', name: '讀匯出', as: 'e', keyColumn: 'Date', keyValue: '1999-01-01' }]);
  check('④ 找不到那一列時指名是哪一列', /找不到「Date=1999-01-01」/.test(r.notes), r.notes);
}

// 變數重名要擋（跟其他 read 積木同一條規則）
{
  const r = await run([
    { action: 'read_export', name: '讀一次', as: 'e' },
    { action: 'read_export', name: '再讀一次', as: 'e' },
  ]);
  check('變數重名要擋下來', r.criticalFails.some(m => /重複/.test(m)), r.criticalFails.join('｜'));
}


// ── 讀取表格的「挑列」：兩張報表要對同一列，不能靠列序 ──────────────────
{
  const PAGE_ROWS = [
    { Date: '2026-09-18', 'Total Bet': '1,408' },
    { Date: '2026-09-17', 'Total Bet': '88' },
  ]
  const tableCtx = () => ({
    page: {
      evaluate: async () => PAGE_ROWS,
      waitForTimeout: async () => {},
      locator: () => ({ count: async () => 1, first: () => ({}), elementHandle: async () => ({}) }),
    },
    runExport: async () => ({ hasButton: true, file: 'x.xlsx', headers: ['Date', 'Total Bet'], rows: [['2026-09-18 00:00:00', '1,408']] }),
  })
  const runT = (steps) => runSteps(steps, tableCtx(), {})

  const okRow = await runT([
    { action: 'read_table', name: '讀畫面', as: 'screen', selector: 'table', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'read_export', name: '讀匯出', as: 'xls', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'assert_equals', name: '對同一天', left: 'xls.TotalBet', right: 'screen.TotalBet', tolerancePct: 0, absoluteTolerance: 0 },
  ])
  check('挑列：兩邊用日期對同一列（不靠列序）', okRow.criticalFails.length === 0, okRow.criticalFails[0] ?? okRow.notes)

  const missRow = await runT([{ action: 'read_table', name: '讀畫面', as: 'screen', selector: 'table', keyColumn: 'Date', keyValue: '1999-01-01' }])
  check('挑列：找不到那一列時講清楚是哪一列', /找不到「Date=1999-01-01」/.test(missRow.notes), missRow.notes)

  const missCol = await runT([{ action: 'read_table', name: '讀畫面', as: 'screen', selector: 'table', keyColumn: 'NoSuch', keyValue: 'x' }])
  check('挑列：找不到欄位時列出現有欄位', /找不到欄位「NoSuch」/.test(missCol.notes), missCol.notes)
}


// ── 比率換算：同一個勝負率，一邊是 14.06%、一邊是 0.1406 ────────────────
{
  const ratioCtx = {
    page: { evaluate: async () => [{ Date: '2026-09-18', 'Win Lose Ratio': '14.06%' }], waitForTimeout: async () => {},
      locator: () => ({ count: async () => 1, first: () => ({}), elementHandle: async () => ({}) }) },
    runExport: async () => ({ hasButton: true, file: 'x.xlsx', headers: ['Date', 'Win Lose Ratio'], rows: [['2026-09-18', '0.1406']] }),
  }
  const base = [
    { action: 'read_table', name: '讀畫面', as: 'screen', selector: 'table', keyColumn: 'Date', keyValue: '2026-09-18' },
    { action: 'read_export', name: '讀匯出', as: 'xls', keyColumn: 'Date', keyValue: '2026-09-18' },
  ]
  const noScale = await runSteps([...base,
    { action: 'assert_equals', name: '比率（沒換算）', left: 'xls.WinLoseRatio', right: 'screen.WinLoseRatio', tolerancePct: 0, absoluteTolerance: 0 },
  ], ratioCtx, {})
  check('比率：不換算就是紅的（0.1406 ≠ 14.06）', noScale.criticalFails.length > 0, noScale.notes)

  const scaled = await runSteps([...base,
    { action: 'assert_equals', name: '比率（左值 ×100）', left: 'xls.WinLoseRatio', right: 'screen.WinLoseRatio', leftScale: 100, tolerancePct: 0, absoluteTolerance: 0 },
  ], ratioCtx, {})
  check('比率：左值 ×100 之後相符', scaled.criticalFails.length === 0, scaled.criticalFails[0] ?? scaled.notes)
  check('比率：日誌要看得到換算前後', /0\.1406×100=14\.06/.test(scaled.notes), scaled.notes)

  // 換算之後仍然不同的，必須照樣紅——不能因為有倍率就變寬鬆
  const stillWrong = await runSteps([...base,
    { action: 'assert_equals', name: '比率（倍率填錯）', left: 'xls.WinLoseRatio', right: 'screen.WinLoseRatio', leftScale: 10, tolerancePct: 0, absoluteTolerance: 0 },
  ], ratioCtx, {})
  check('比率：倍率填錯照樣紅，而且訊息帶得出換算前的值', stillWrong.criticalFails.length > 0 && /換算前/.test(stillWrong.notes), stillWrong.notes)
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`);
assert.equal(fail, 0, 'read_export 測試有失敗項');
