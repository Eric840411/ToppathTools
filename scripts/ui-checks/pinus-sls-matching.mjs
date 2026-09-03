/**
 * 三路對帳的 SLS ↔ Pinus 配對規則：**寧可 unmatched，不要假相符**。
 *
 * 背景：Pinus 的 historyListReq **根本沒有 order id**（實測 BULLBLITZ 2026-09-03，
 * 回傳欄位只有 `time/gameid/gmid/bet/win/gmname`），所以原本的精確比對
 * `pinusByOrderId.get(sls.roundId)` 永遠不可能命中。只剩「同機台 + 時間相近」可用。
 *
 * ⚠️ 時間配對本質上是模糊的。**配錯會產生「看起來相符、其實是別輪」的結果，
 *    那比顯示「缺資料」更糟**——缺資料只是沒有結論，假相符是錯誤的結論，
 *    而且沒有任何徵兆。所以這支測的重點不是「配得到」，是「該拒絕的有沒有拒絕」。
 *
 * 跑法：node scripts/ui-checks/pinus-sls-matching.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const m = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/autospin.js')).href);
const { matchPinusRounds, pinusRecordTimeToMs, PINUS_MATCH_WINDOW_MS } = m;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const GM = '873-BULLBLITZ-0136';
/** 本地時間字串（UTC+8），跟真實資料同格式 */
const local = (hhmmss) => `2026-09-03 ${hhmmss}`;
/** 同一時刻的 epoch 秒（UTC+8 → UTC） */
const sec = (hhmmss) => {
  const [h, mi, s] = hhmmss.split(':').map(Number);
  return (Date.UTC(2026, 8, 3, h, mi, s) - 8 * 3600_000) / 1000;
};
/** epoch 秒 → Pinus 那種本地時間字串（UTC+8） */
const toLocal = (epochSec) => new Date((epochSec + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
const pinus = (hhmmss, extra = {}) => ({ gmid: GM, recordTime: local(hhmmss), bet: 1250, win: 0, ...extra });
const sls = (hhmmss, gmid = GM) => ({ timeSec: sec(hhmmss), gmid });

// ⚠️ 測試一律用「相對於窗寬」表達，不要寫死秒數。窗是用實測分布定的、會再調
//    （第一版 ±3000ms 依真實資料改成 ±1000ms），寫死的話每次調窗都要重寫一批
//    fixture，而且很容易把「規則錯了」誤判成「fixture 過期」。
const W = PINUS_MATCH_WINDOW_MS / 1000;   // 窗寬（秒）
const IN = W;                             // 窗內邊緣
const OUT = W + 1;                        // 剛好出窗（時間戳是秒級）
const at = (baseSec, offsetSec) => baseSec + offsetSec;

console.log(`\n時間窗 ±${PINUS_MATCH_WINDOW_MS}ms（W=${W}s）\n`);

console.log('1) 時間換算（UTC+8 字串 ↔ epoch）');
check('本地字串換算成 UTC 正確', pinusRecordTimeToMs(local('15:42:48')) === sec('15:42:48') * 1000);
check('格式不對回 null', pinusRecordTimeToMs('not a time') === null);
check('空值回 null', pinusRecordTimeToMs(null) === null);
// ⚠️ 用 new Date("...") 會依伺服器本地時區解讀，同一份資料在不同機器算出不同時間
check('T 分隔也吃得下', pinusRecordTimeToMs('2026-09-03T15:42:48') === sec('15:42:48') * 1000);

console.log('\n2) 唯一候選才配對');
{
  const r = matchPinusRounds([sls('15:42:48')], [pinus('15:42:48')]);
  check('時間完全相同 → 配對成功', r[0].matched !== null && r[0].candidateCount === 1);
  check('時間差記錄下來（之後調窗才不是黑箱）', r[0].timeDeltaMs === 0);
}
{
  const r = matchPinusRounds([{ timeSec: at(sec('15:42:48'), -IN), gmid: GM }], [pinus('15:42:48')]);
  check(`差 ${IN} 秒（窗內邊緣）仍配得上`, r[0].matched !== null, `delta=${r[0].timeDeltaMs}`);
}
{
  const r = matchPinusRounds([{ timeSec: at(sec('15:42:48'), -OUT), gmid: GM }], [pinus('15:42:48')]);
  check(`差 ${OUT} 秒（出窗）→ 配不到`, r[0].matched === null && r[0].candidateCount === 0);
}

console.log('\n3) 多筆候選一律拒絕，不要猜');
// ⚠️ 這是「假相符」最容易發生的地方
{
  const base = sec('15:42:48');
  const r = matchPinusRounds([{ timeSec: base, gmid: GM }],
    [{ gmid: GM, recordTime: local('15:42:48'), bet: 1250, win: 0 },
     { gmid: GM, recordTime: toLocal(base + IN), bet: 1250, win: 0 }]);
  check('窗內 2 筆 → 不配對', r[0].matched === null);
  check('候選數如實記錄', r[0].candidateCount === 2);
}
{
  // bet/win 完全一樣是常態（連續同注額），拿它縮候選只會製造精準的錯覺
  const base = sec('15:42:48');
  const r = matchPinusRounds([{ timeSec: base, gmid: GM }],
    [{ gmid: GM, recordTime: local('15:42:48'), bet: 1250, win: 0 },
     { gmid: GM, recordTime: toLocal(base + IN), bet: 1250, win: 0 }]);
  check('bet/win 相同也不拿來挑（不當配對鍵）', r[0].matched === null);
}

console.log('\n4) 反向：同一筆 Pinus 被兩輪搶走也要拒絕');
// ⚠️ 只看「一輪對到幾筆」抓不到這種：兩輪各自都「唯一」對到中間那一筆，
//    方向相反但一樣是猜。
{
  const base = sec('15:42:48');
  const r = matchPinusRounds(
    [{ timeSec: base - IN, gmid: GM }, { timeSec: base + IN, gmid: GM }], [pinus('15:42:48')]);
  check('兩輪都拒絕配對', r[0].matched === null && r[1].matched === null);
  check('兩輪都標記 contested', r[0].contested === true && r[1].contested === true);
  check('candidateCount 仍如實是 1（沒有假裝找不到）', r[0].candidateCount === 1);
}
{
  // 只有一輪搆得到就正常配
  const base = sec('15:42:48');
  const r = matchPinusRounds(
    [{ timeSec: base - IN, gmid: GM }, { timeSec: base + 600, gmid: GM }], [pinus('15:42:48')]);
  check('只有一輪搆得到時正常配對', r[0].matched !== null && r[0].contested === false);
  check('另一輪配不到', r[1].matched === null && r[1].candidateCount === 0);
}

console.log('\n5) 機台要對得上');
{
  const r = matchPinusRounds([sls('15:42:48', GM)], [pinus('15:42:48', { gmid: '873-OTHER-0001' })]);
  check('不同機台不配對', r[0].matched === null && r[0].candidateCount === 0);
}
{
  // 舊資料可能沒有 gmid，這時只靠時間；不要因此整批配不到
  const r = matchPinusRounds([sls('15:42:48', GM)], [pinus('15:42:48', { gmid: '' })]);
  check('Pinus 沒有 gmid 時退回只比時間', r[0].matched !== null);
}

console.log('\n6) 節奏模擬（實測 BULLBLITZ 約 3~4 秒一輪）');
{
  // 間隔 = 窗寬 × 4，兩邊完全對齊 → 應該全配得上且沒有爭用
  const base = sec('15:42:40');
  const ts = [0, 1, 2, 3, 4].map(i => base + i * IN * 4);
  const r = matchPinusRounds(ts.map(t => ({ timeSec: t, gmid: GM })),
    ts.map(t => ({ gmid: GM, recordTime: toLocal(t), bet: 1250, win: 0 })));
  check('5 輪全部配對成功', r.every(x => x.matched !== null), JSON.stringify(r.map(x => x.candidateCount)));
  check('沒有任何一輪爭用', r.every(x => !x.contested));
}
{
  // ⚠️ spin 間隔一旦縮到窗寬（使用者可以調 Spin 間隔），窗內必然出現多筆 → 全部拒絕。
  //    這正是「窗要保守、而且要留診斷欄位」的原因：調窗前先看實測分布。
  const base2 = sec('15:42:40');
  const ts2 = [0, 1, 2].map(i => base2 + i * IN);
  const r = matchPinusRounds(ts2.map(t => ({ timeSec: t, gmid: GM })),
    ts2.map(t => ({ gmid: GM, recordTime: toLocal(t), bet: 1250, win: 0 })));
  check(`間隔縮到 ${IN} 秒時全部拒絕配對（寧可 unmatched）`, r.every(x => x.matched === null),
    JSON.stringify(r.map(x => x.candidateCount)));
}

console.log('\n7) 邊界');
check('沒有 Pinus 資料時全部配不到',
  matchPinusRounds([sls('15:42:48')], []).every(x => x.candidateCount === 0 && x.matched === null));
check('沒有 SLS 資料時回空陣列', matchPinusRounds([], [pinus('15:42:48')]).length === 0);
check('recordTime 壞掉的那筆直接被排除，不影響其他',
  matchPinusRounds([sls('15:42:48')], [{ gmid: GM, recordTime: 'garbage' }, pinus('15:42:48')])[0].matched !== null);

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
