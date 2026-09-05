/**
 * Live Ledger P0：對帳鍵的綁定規則。
 *
 * 這是整套設計的成敗所在。舊工具的四個數字說明了為什麼：
 *   30 份後台對帳報告完成雙向比對的有 0 份｜1,860 筆三路對帳 match 只有 17%
 *   mismatch 歷史上出現過 0 次｜只比一個欄位，而那還是我們自己設的常數
 *
 * ⚠️ 這支要守的**不是「綁得到」，是「該拒絕的有沒有拒絕」**。
 *    綁錯會產生「看起來對上了、其實是別一局」的假對帳——那比配不到更糟，
 *    因為後面每一期的金額比對都會建立在錯的鍵上，而且完全沒有徵兆。
 *
 * 用假資料跑純函式，不碰 DB、不連後台。
 *
 * 跑法：node scripts/ui-checks/live-ledger-bind.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bindSpins } = await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger.js')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const CFG = { beforeMs: 2000, afterMs: 30000 };   // 規格：−2s ~ +30s
const GM = '873-BULLBLITZ-0136';
const T = 1_788_500_000_000;
const spin = (id, at, bet = 1250, gmid = GM) => ({ id, gmid, betAmount: bet, observedAt: at });
const rec = (orderId, at, bet = 1250, gmid = GM) => ({ orderId, gmid, bet, dateTime: at });
const one = (spins, recs, bound) => bindSpins(spins, recs, CFG, bound);

console.log('\n1) 唯一候選才綁');
{
  const r = one([spin(1, T)], [rec('O1', T + 5000)]);
  check('窗內唯一候選 → resolved', r[0].result === 'resolved' && r[0].orderId === 'O1');
  check('記下時間差（之後校準門檻要用）', r[0].timeDeltaMs === 5000, `${r[0].timeDeltaMs}`);
}
{
  const r = one([spin(1, T)], []);
  check('沒有候選 → not_found（維持 PENDING，不是失敗）', r[0].result === 'not_found' && r[0].candidateCount === 0);
}
{
  const r = one([spin(1, T)], [rec('O1', T + 1000), rec('O2', T + 2000)]);
  check('兩筆候選 → ambiguous，不猜', r[0].result === 'ambiguous' && r[0].candidateCount === 2);
}

console.log('\n2) 時間窗邊界（−2s ~ +30s）');
check('後台比 spin 早 2 秒仍在窗內', one([spin(1, T)], [rec('O1', T - 2000)])[0].result === 'resolved');
check('早 2.001 秒就出窗', one([spin(1, T)], [rec('O1', T - 2001)])[0].result === 'not_found');
check('晚 30 秒仍在窗內', one([spin(1, T)], [rec('O1', T + 30000)])[0].result === 'resolved');
check('晚 30.001 秒就出窗', one([spin(1, T)], [rec('O1', T + 30001)])[0].result === 'not_found');

console.log('\n3) bet 必須相等');
check('bet 不同 → 不是候選', one([spin(1, T, 1250)], [rec('O1', T + 3000, 2500)])[0].result === 'not_found');
check('浮點誤差要容忍', one([spin(1, T, 1250)], [rec('O1', T + 3000, 1250.001)])[0].result === 'resolved');
// ⚠️ 容差不能寬到跨檔位——1250 跟 1251 是不同下注額，不是誤差
check('差 1 元不算誤差', one([spin(1, T, 1250)], [rec('O1', T + 3000, 1251)])[0].result === 'not_found');

console.log('\n4) 機台要對得上');
check('不同 gmid 不綁', one([spin(1, T, 1250, 'A')], [rec('O1', T + 3000, 1250, 'B')])[0].result === 'not_found');

console.log('\n5) 反向：兩筆 spin 搶同一張單 → 兩邊都退回');
// ⚠️ 只看「一筆 spin 對到幾張單」抓不到這種。spin 間隔短時很容易發生：
//    兩筆 spin 的窗都涵蓋同一張後台單，各自都「唯一」。
{
  const r = one([spin(1, T), spin(2, T + 1000)], [rec('O1', T + 2000)]);
  check('兩筆都變 ambiguous', r[0].result === 'ambiguous' && r[1].result === 'ambiguous');
  check('標記為 contested（跟「多筆候選」是不同原因）', r[0].contested === true && r[1].contested === true);
  check('candidateCount 仍如實是 1，沒有假裝找不到', r[0].candidateCount === 1);
}
{
  // 只有一筆搆得到就正常綁
  const r = one([spin(1, T), spin(2, T + 120000)], [rec('O1', T + 2000)]);
  check('只有一筆搆得到時正常綁', r[0].result === 'resolved' && r[1].result === 'not_found');
}

console.log('\n6) 已綁走的單不能再當候選');
// ⚠️ 一筆後台局號只能被綁定一次（規格書明訂）。少了這條，重跑一輪就會把
//    同一張單綁給第二筆 spin，而且兩邊看起來都「成功」。
{
  const r = one([spin(9, T)], [rec('O1', T + 3000)], new Set(['O1']));
  check('已綁走的單被排除', r[0].result === 'not_found' && r[0].candidateCount === 0);
}
{
  const r = one([spin(9, T)], [rec('O1', T + 3000), rec('O2', T + 4000)], new Set(['O1']));
  check('排除之後剩唯一候選 → 正常綁', r[0].result === 'resolved' && r[0].orderId === 'O2');
}

console.log('\n7) 真實節奏（實測 BULLBLITZ 約 3~4 秒一輪）');
{
  // 每 4 秒一次 spin、後台延遲 5 秒。窗是 +30s，所以每筆 spin 的窗會涵蓋多張單 → 全部 ambiguous
  const spins = [0, 1, 2, 3, 4].map(i => spin(i + 1, T + i * 4000));
  const recs = [0, 1, 2, 3, 4].map(i => rec(`O${i}`, T + i * 4000 + 5000));
  const r = one(spins, recs);
  const amb = r.filter(x => x.result === 'ambiguous').length;
  check('窗太寬時全部拒絕而不是亂綁', amb === 5, `ambiguous ${amb}/5`);
  check('沒有任何一筆被誤綁', r.every(x => x.result !== 'resolved'));
}
{
  // ⚠️ 這說明 +30s 這個上界對高頻 spin 是危險的。bet 相同時只有時間能區分，
  //    而 30 秒內會有 7~10 局。真實壓測時得靠實測延遲分布把上界收窄——
  //    規格書要求記三個時間戳就是為了這件事。
  const spins = [0, 1, 2].map(i => spin(i + 1, T + i * 4000));
  const recs = [0, 1, 2].map(i => rec(`O${i}`, T + i * 4000 + 500));
  const tight = bindSpins(spins, recs, { beforeMs: 2000, afterMs: 1500 }, new Set());
  check('把上界收到 1.5s 之後全部綁得上', tight.every(x => x.result === 'resolved'),
    JSON.stringify(tight.map(x => x.result)));
}

console.log('\n8) 邊界');
check('沒有 spin 時回空陣列', one([], [rec('O1', T)]).length === 0);
check('沒有後台紀錄時全部 not_found', one([spin(1, T), spin(2, T)], []).every(x => x.result === 'not_found'));

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
