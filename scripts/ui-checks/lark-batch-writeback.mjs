/**
 * 批次回寫（`multiWritebackLarkBatch`）的行為驗證。
 *
 * 為什麼要有這支：舊的 `multiWritebackLark` 是「一欄一次 API、循序」，
 * 對帳補回填 131 列 × 5 欄 = 655 次呼叫，實測超過反向代理 60 秒被切斷
 * （使用者 2026-09-03 回報，前端拿到 HTML 錯誤頁爆 SyntaxError）。
 *
 * ⚠️ 這支**用假 fetch**，不會連到 Lark、不會寫任何 Sheet。
 *    真正的 `values_batch_update` 承載格式另外用「指向不存在的 sheet」的請求驗
 *    （見 `lark-batch-shape-probe`，那個會失敗但不會寫到任何地方）。
 *
 * 這裡守的是三件靠讀程式碼看不出來的事：
 *   ① 呼叫次數真的降下來了（不然這整個改動沒有意義）
 *   ② **整批失敗時要退回逐列重送**——不做的話一列壞掉會把同批全部誤標失敗
 *   ③ 每列結果即時回報，讓呼叫端能落 DB。連線斷掉時那個「回傳值」根本送不出去，
 *      逐列回報才是唯一救得回來的路徑。
 *
 * 跑法：node scripts/ui-checks/lark-batch-writeback.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

// ── 攔掉 fetch，記下每一次呼叫 ────────────────────────────────────────────
const calls = [];
/** 讓某些 range 寫入失敗，用來驗逐列退回 */
let failRanges = new Set();
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, method: init?.method ?? 'GET', body });
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (u.includes('/auth/v3/tenant_access_token')) return json({ code: 0, tenant_access_token: 'T', expire: 7200 });
  // 表頭：A~E 五欄剛好對上要寫的欄位名
  if (u.includes('/values/') && (init?.method ?? 'GET') === 'GET') {
    return json({ code: 0, data: { valueRange: { values: [['Jira issue key', 'Jira URL', '處理階段', '處理時間', '單子標題貼這']] } } });
  }
  if (u.includes('values_batch_update')) {
    const ranges = (body?.valueRanges ?? []).map(v => v.range);
    if (ranges.some(r => failRanges.has(r))) return json({ code: 1, msg: 'boom' });
    return json({ code: 0 });
  }
  return json({ code: 0 });
};

const { multiWritebackLarkBatch } = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/integrations.js')).href);

const SHEET = 'https://x.larksuite.com/sheets/SPREADSHEETTOKEN?sheet=sh1';
const mkWrites = (n, from = 2) => Array.from({ length: n }, (_, i) => ({
  rowIndex: from + i,
  columns: {
    'Jira issue key': `DSFT-${8200 + i}`,
    'Jira URL': `https://j/browse/DSFT-${8200 + i}`,
    '處理階段': '已開單',
    '處理時間': '2026-09-03 15:00',
    '單子標題貼這': { type: 'richtext', segments: [{ text: `DSFT-${8200 + i}`, link: 'https://j' }, { text: '\n標題' }] },
  },
}));
const reset = () => { calls.length = 0; failRanges = new Set() };
const batchCalls = () => calls.filter(c => c.url.includes('values_batch_update'));

console.log('\n1) 呼叫次數要真的降下來（這是整個改動的目的）');
{
  reset();
  const reported = [];
  const res = await multiWritebackLarkBatch(SHEET, mkWrites(131), { onRowResult: r => reported.push(r) });
  const n = batchCalls().length;
  check('131 列只用了 7 次 batch 呼叫（原本 655 次）', n === 7, `實際 ${n} 次`);
  check('131 列全部回報成功', res.length === 131 && res.every(r => r.ok));
  check('逐列即時回報過 131 次', reported.length === 131);
  // 每次呼叫 20 列 × 5 欄 = 100 個 range
  check('每批最多 100 個 range', batchCalls().every(c => c.body.valueRanges.length <= 100));
}

console.log('\n2) 整批失敗要退回逐列，不能把整批標成失敗');
// ⚠️ 這條是重點：不退回的話，一列有問題會讓同批另外 19 列被誤標成失敗，
//    使用者會以為那 19 列沒寫進去而重送。
{
  reset();
  failRanges = new Set(['sh1!A5:A5']); // 只有第 5 列的第一格會失敗
  const res = await multiWritebackLarkBatch(SHEET, mkWrites(20), { rowsPerCall: 20 });
  const bad = res.filter(r => !r.ok);
  check('只有 1 列失敗', bad.length === 1, `實際 ${bad.length} 列`);
  check('失敗的正是第 5 列', bad[0]?.rowIndex === 5);
  check('失敗的那列帶錯誤訊息', /boom/.test(bad[0]?.error ?? ''));
  check('同批其他 19 列仍標成功', res.filter(r => r.ok).length === 19);
  // 1 次整批 + 20 次逐列
  check('退回逐列時每列各送一次', batchCalls().length === 21, `實際 ${batchCalls().length}`);
}

console.log('\n3) 逐列回報要在過程中就發生，不是最後才一次給');
// 連線被逾時切斷時，函式的「回傳值」根本送不到前端；能救的只有過程中落 DB 的那些。
{
  reset();
  const seen = [];
  await multiWritebackLarkBatch(SHEET, mkWrites(60), { rowsPerCall: 20, onRowResult: r => seen.push({ ...r, at: batchCalls().length }) });
  check('第一批回報時後面兩批還沒送出', seen[0]?.at === 1, `at=${seen[0]?.at}`);
  check('最後一列回報時已送出 3 批', seen[seen.length - 1]?.at === 3);
}

console.log('\n4) 缺少的欄位要先建好，而且建在批次寫入之前');
// 建欄位會改動表頭；混在批次中間做，欄位位置會在寫到一半時變動
{
  reset();
  const w = mkWrites(3).map(x => ({ ...x, columns: { ...x.columns, '新欄位': 'v' } }));
  await multiWritebackLarkBatch(SHEET, w);
  const idxCreate = calls.findIndex(c => c.method === 'PUT' && JSON.stringify(c.body).includes('新欄位'));
  const idxFirstBatch = calls.findIndex(c => c.url.includes('values_batch_update'));
  check('有建立新欄位', idxCreate !== -1);
  check('建欄位發生在第一次批次寫入之前', idxCreate !== -1 && idxCreate < idxFirstBatch);
  check('新欄位只建一次（3 列共用）',
    calls.filter(c => c.method === 'PUT' && JSON.stringify(c.body).includes('新欄位')).length === 1);
}

console.log('\n5) 送出的內容要正確');
{
  reset();
  await multiWritebackLarkBatch(SHEET, mkWrites(1, 7));
  const vr = batchCalls()[0].body.valueRanges;
  check('range 帶 sheetId 前綴', vr.every(v => v.range.startsWith('sh1!')));
  check('列號正確（第 7 列）', vr.every(v => /\d+/.exec(v.range.split('!')[1])[0] === '7'));
  check('欄位對到 A~E', vr.map(v => v.range[4]).join('') === 'ABCDE', vr.map(v => v.range).join(','));
  // richtext 要被展開成 segment 陣列，不是原樣送出去
  const rich = vr[4].values[0][0];
  check('richtext 已序列化成 segment 陣列', Array.isArray(rich) && rich[0]?.type === 'url');
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
