/**
 * Live Ledger P0：拉取後的 username 防呆與欄位正規化。
 *
 * ⚠️ 這道防呆是規格方**升格為必做**的，理由是實測到的行為：
 *    `playerId` 傳 username 時後台**不報錯，直接回傳未過濾的全部 16,824 筆**。
 *    少了它，一個參數打錯就會讓整套對帳靜默地對到別人的資料上，而畫面一片正常。
 *
 * 跑法：node scripts/ui-checks/live-ledger-guard.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { guardFetchedRows, normalizeBackendRow } =
  await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger.js')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

// 欄位名照真實 API 回應（實測樣本）
const row = (o = {}) => ({
  order_id: '873-JJBX-0001|6A9A89B7575', uid: '873-JJBX-0001', username: 'osmel031',
  userid: '328807', spin_index: 594, bet: 1250, win: 0, bet_time_precise: 1788512695.42, ...o,
});

console.log('\n1) 正規化');
{
  const n = normalizeBackendRow(row());
  check('order_id 帶出來', n.orderId === '873-JJBX-0001|6A9A89B7575');
  check('uid 當 gmid', n.gmid === '873-JJBX-0001');
  // ⚠️ bet_time_precise 是 epoch「秒」（帶小數），當成毫秒用會差 1000 倍
  check('bet_time_precise 轉成 epoch ms', n.betTimePrecise === 1788512695420, String(n.betTimePrecise));
  check('沒有 order_id 就回 null', normalizeBackendRow({ username: 'x' }) === null);
}

console.log('\n2) 防呆：回傳含別人的帳號 → 整批擋下');
{
  const g = guardFetchedRows([row(), row({ username: 'osmel999', order_id: 'X|1' })], 'osmel031');
  check('不通過', g.ok === false);
  check('errKind = wrong_account', g.errKind === 'wrong_account');
  check('整批不進綁定（rows 是空的）', g.rows.length === 0);
  check('訊息說得出期待值與實際值', /osmel031/.test(g.message) && /osmel999/.test(g.message), g.message);
}
{
  // 這正是「playerId 傳錯值」的實際樣子：回傳一大堆別人的局
  const many = Array.from({ length: 50 }, (_, i) => row({ username: 'other' + i, order_id: 'X|' + i }));
  const g = guardFetchedRows([row(), ...many], 'osmel031');
  check('大量混入時一樣整批擋下', g.ok === false && g.rows.length === 0, `${g.message?.slice(0, 40)}…`);
}

console.log('\n3) 全部都是目標帳號 → 放行');
{
  const g = guardFetchedRows([row(), row({ order_id: 'A|2', spin_index: 595 })], 'osmel031');
  check('通過', g.ok === true);
  check('兩筆都留下', g.rows.length === 2);
}

console.log('\n4) 序列對齊依賴的欄位缺一不可');
{
  const g = guardFetchedRows([row({ spin_index: undefined })], 'osmel031');
  check('缺 spin_index → 擋下', g.ok === false && g.errKind === 'bad_shape', g.message);
}
{
  const g = guardFetchedRows([row({ bet_time_precise: 'abc' })], 'osmel031');
  check('bet_time_precise 壞掉 → 擋下', g.ok === false && g.errKind === 'bad_shape', g.message);
}

console.log('\n5) 邊界');
check('空回應 → 通過但沒有資料', (() => { const g = guardFetchedRows([], 'osmel031'); return g.ok && g.rows.length === 0 })());
check('全部沒有 order_id → 視同空', (() => { const g = guardFetchedRows([{ username: 'osmel031' }], 'osmel031'); return g.ok && g.rows.length === 0 })());

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
