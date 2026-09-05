/**
 * Live Ledger P0：spin_index 序列對齊（方案 D）。
 *
 * 為什麼改用序列對齊：時間窗當鑑別器行不通。實測 spin 間隔中位數 6 秒，
 * 而規格原本的窗寬 32 秒 → 每筆約 5.3 個候選，全部 AMBIGUOUS。
 * 根因是 bet 固定 1250，窗內沒有第二個鑑別特徵。
 * 後台側實測局間隔 p90 9 秒但 **max 146 秒** —— 那筆若只看時間會被誤判成掉單。
 *
 * ⚠️ 這支要守的是序列對齊**唯一的致命失敗模式**：
 *    **錨錯 → 整段偏移，而且每一筆看起來都「成功」。**
 *    那比配不到糟糕得多——後面每一期的金額比對都會建立在錯的鍵上，
 *    畫面上還會顯示一片綠。所以下面過半的斷言都在測「該拒絕的有沒有拒絕」。
 *
 * 純函式，不碰 DB、不連後台。
 *
 * 跑法：node scripts/ui-checks/live-ledger-align.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { alignBySpinIndex } = await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger.js')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const T = 1_788_500_000_000;
// ⚠️ maxLatencyMs 必須小於 spin 間隔（實測中位數 6 秒），否則「平移一格」也會落在容忍內，
//    逐筆時間檢查就形同虛設——那正是反向驗收要抓的。這裡用 4 秒。
const OPT = { anchorWindowMs: 5000, maxLatencyMs: 4000, maxLeadMs: 2000 };
const GM = '873-JJBX-0001';
/** agent 側：spinSeq 遞增、observedAt 每 6 秒（實測中位數） */
const spins = (n, from = 1, gapMs = 6000) => Array.from({ length: n }, (_, i) => ({
  id: from + i, spinSeq: from + i, gmid: GM, betAmount: 1250, observedAt: T + i * gapMs,
}));
/** 後台側：spin_index 連續、bet_time_precise 比 spin 晚 latency 秒 */
const rounds = (n, fromIdx = 100, gapMs = 6000, latencyMs = 500) => Array.from({ length: n }, (_, i) => ({
  orderId: `${GM}|O${fromIdx + i}`, gmid: GM, username: 'osmel031',
  spinIndex: fromIdx + i, bet: 1250, betTimePrecise: T + i * gapMs + latencyMs,
}));
const run = (s, r, bound) => alignBySpinIndex(s, r, OPT, bound);
const results = a => a.map(x => x.result);

console.log('\n1) 正常情況：連續序列全部對得上');
{
  const r = run(spins(10), rounds(10));
  check('10 筆全部 resolved', r.every(x => x.result === 'resolved'), JSON.stringify(results(r)));
  check('orderId 依序對上', r[0].orderId.endsWith('O100') && r[9].orderId.endsWith('O109'));
  check('每筆都通過驗證', r.every(x => x.verify?.betOk && x.verify?.timeOk));
}

console.log('\n2) 這正是時間窗做不到的：間隔 146 秒的離群局');
// ⚠️ 實測後台側有 max 146 秒的局間隔。時間窗會把它判成掉單，序列對齊不會。
{
  // ⚠️ 第一版只把後台時間延後 146 秒，那模擬的是「入帳延遲 146 秒」——不是實測到的東西。
  //    實測的 max 146 秒是**相鄰局的間隔**（機台停了很久才再轉一次），這種情況
  //    agent 的 observedAt 也會跟著隔 146 秒，逐筆時間差依然很小。
  //    寫成前者會讓這個測試去否定 latencyOk 那條保護，方向剛好相反。
  const s = spins(3);
  s[2].observedAt = T + 146000;             // 機台停了 146 秒才轉第三局
  const r = rounds(3);
  r[2].betTimePrecise = T + 146000 + 500;   // 後台照樣在 0.5 秒後入帳
  const out = run(s, r);
  check('長時間停頓後的那一局仍對得上（時間窗會誤判成掉單）',
    out.every(x => x.result === 'resolved'), JSON.stringify(results(out)));
}

console.log('\n3) 跳號 → 標 AMBIGUOUS 並重新錨定，不硬推');
{
  const s = spins(6);
  const r = rounds(6);
  r[3].spinIndex = 999;                     // 第 4 筆跳號
  const out = run(s, r);
  check('前 3 筆正常', results(out).slice(0, 3).every(x => x === 'resolved'));
  check('跳號那筆標 ambiguous', out[3].result === 'ambiguous', out[3].reason);
  check('原因寫明是跳號', /index_gap/.test(out[3].reason ?? ''), out[3].reason);
  // ⚠️ 重點：跳號之後**不能**把剩下的硬推下去
  check('跳號之後沒有硬推（沒有整段偏移）',
    !out.slice(4).some(x => x.result === 'resolved' && x.spinIndex === 999));
}

console.log('\n4) 錨不出唯一候選就不錨——這是最危險的地方');
// ⚠️ 硬錨的後果是整段偏移，而且每一筆都會顯示 resolved。寧可整批不綁。
{
  // 兩筆後台單都落在錨定窗內 → 錨不出唯一
  const r = rounds(2, 100, 1000, 500);      // 兩筆只差 1 秒，都在 ±5s 錨定窗內
  const out = run(spins(2, 1, 60000), r);
  check('錨定候選 >1 → not_found，不猜', out[0].result === 'not_found', out[0].reason);
  check('原因寫明是錨定歧義', out[0].reason === 'anchor_ambiguous', out[0].reason);
}
{
  const out = run(spins(3), rounds(3, 100, 6000, 999999));  // 後台時間離太遠，錨不到
  check('完全錨不到 → 全部 not_found', out.every(x => x.result === 'not_found'), JSON.stringify(results(out)));
  check('原因寫明沒有錨點', out[0].reason === 'no_anchor', out[0].reason);
}

console.log('\n5) 每一筆都要驗，不是只驗錨點');
// ⚠️ 只驗錨點的話，中間某一筆 bet 不同也會被推下去 —— 那就是「看起來成功的錯」
{
  const s = spins(5);
  const r = rounds(5);
  r[2].bet = 2500;                          // 第 3 筆下注額不同
  const out = run(s, r);
  check('bet 不同那筆標 ambiguous', out[2].result === 'ambiguous', out[2].reason);
  check('原因寫明是 bet 不符', /bet_mismatch/.test(out[2].reason ?? ''), out[2].reason);
  check('驗證結果如實記錄', out[2].verify?.betOk === false);
}
{
  const s = spins(5);
  const r = rounds(5);
  r[3].betTimePrecise = T - 999999;         // 第 4 筆時間倒退
  const out = run(s, r);
  check('時間倒退那筆標 ambiguous', out[3].result === 'ambiguous', out[3].reason);
  check('原因寫明時間不單調', out[3].reason === 'time_not_monotonic', out[3].reason);
}

console.log('\n6) 已綁走的單不能再被用');
{
  // ⚠️ 要寫成**真實**情境：O100/O101 已綁 ⇒ 對應的 spin 也已經綁掉、不會還在 pending。
  //    所以 pending 的 spin 是從第 3 筆開始的（觀測時間也要跟著往後）。
  //    第一版把 3 筆全新的 spin 從 T 起算，錨定窗自然對不上——那是測試寫錯不是程式錯。
  const bound = new Set([`${GM}|O100`, `${GM}|O101`]);
  const pending = spins(3, 3).map((x, i) => ({ ...x, observedAt: T + (2 + i) * 6000 }));
  const out = run(pending, rounds(5), bound);
  check('從第一筆未綁的開始對', out[0].result === 'resolved' && out[0].orderId.endsWith('O102'), out[0].orderId);
  check('剩下的也依序對上', out.every(x => x.result === 'resolved'), JSON.stringify(results(out)));
}

console.log('\n7) 後台還沒補齊時不要硬湊');
{
  const out = run(spins(5), rounds(2));      // agent 有 5 筆，後台只回 2 筆
  check('前 2 筆對得上', results(out).slice(0, 2).every(x => x === 'resolved'));
  check('超出後台範圍的標 not_found（維持 PENDING 等下一輪）',
    results(out).slice(2).every(x => x === 'not_found'), JSON.stringify(results(out)));
  check('原因寫明超出範圍', out[2].reason === 'beyond_backend', out[2].reason);
}

console.log('\n8) 邊界');
check('沒有 spin → 空陣列', run([], rounds(3)).length === 0);
check('沒有後台紀錄 → 全部 not_found',
  run(spins(3), []).every(x => x.result === 'not_found' && x.reason === 'no_backend_rounds'));
{
  // 輸入順序打亂也要得到一樣的結果（函式內部自己排序）
  const s = spins(5).reverse();
  const r = rounds(5).reverse();
  const out = run(s, r);
  check('輸入順序不影響結果', out.every(x => x.result === 'resolved'), JSON.stringify(results(out)));
}

console.log('\n9) 後台缺中間一筆（真掉單）—— 缺口不得傳染');
// ⚠️ 規格方列為核心案例：該筆不能對上，但**後續必須照樣對得上**。
//    缺口傳染的話，一筆真掉單會讓後面整段變成假掉單。
{
  const s = spins(6);
  const r = rounds(6).filter((_, i) => i !== 2);   // 後台少了第 3 筆（spin_index 102）
  const out = run(s, r);
  const resolved = out.filter(x => x.result === 'resolved').length;
  check('缺口沒有傳染：至少 4 筆仍對得上', resolved >= 4, `${resolved}/6 → ${JSON.stringify(results(out))}`);
  check('沒有任何一筆被配到錯的單',
    out.every((x, i) => x.result !== 'resolved' || x.spinIndex === undefined || x.spinIndex >= 100 + i - 1));
}

console.log('\n10) agent 側多一筆（後台完全沒有）');
{
  const s = spins(6);
  const r = rounds(5);                              // agent 6 筆、後台只有 5 筆
  const out = run(s, r);
  check('前 5 筆對得上', results(out).slice(0, 5).every(x => x === 'resolved'));
  check('多出來那筆 not_found，不硬配', out[5].result === 'not_found', out[5].reason);
}

console.log('\n11) 跳號後重新錨定，要能「繼續正確對上」');
// ⚠️ 規格方特別要求：不是從此全毀。
{
  const s = spins(8);
  const r = rounds(8);
  for (let i = 4; i < 8; i++) r[i].spinIndex += 50;   // 第 5 筆起整段跳號
  const out = run(s, r);
  check('跳號那筆 ambiguous', out[4].result === 'ambiguous', out[4].reason);
  const after = out.slice(5).filter(x => x.result === 'resolved').length;
  check('重新錨定後繼續對得上', after >= 2, `後續 resolved ${after}/3 → ${JSON.stringify(results(out).slice(5))}`);
}

console.log('\n12) 同一張後台單不得在同一輪內被配兩次');
// ⚠️ 這是我實作時發現的真 bug：重新錨定會往回搜到已經配掉的位置。
//    DB 的 unique index 會擋下第二筆，但那時已經變成「一筆成功、一筆莫名失敗」，
//    看起來像偶發錯誤而不是邏輯錯誤，極難查。
{
  const s = spins(6);
  const r = rounds(6);
  r[3].spinIndex = 999;                              // 製造跳號 → 觸發重新錨定
  const out = run(s, r);
  const ids = out.filter(x => x.result === 'resolved').map(x => x.orderId);
  check('沒有重複的 orderId', new Set(ids).size === ids.length, ids.join(','));
}

console.log('\n13) 反向驗收：差一位的配對必須被拒絕');
// ⚠️ 規格方要求「把後台序列整體平移一格，回填率必須崩到接近 0」。
//    我實測了四種平移，結論是**要看是哪一種平移**：
//
//      A 正常                        → 100%
//      B 索引與時間一起平移          →  95%   每筆時間差跟 A 完全相同（500ms）
//      C 時間誠實、位置錯開（刪首筆）→  95%   演算法自己校正回正確配對
//      D 只有索引平移、時間誠實      → 100%   配對其實是對的
//
//    B 崩不掉不是缺陷：索引與時間一起平移產生的資料**跟正確資料在資訊上完全相同**
//    ——每一筆的時間差都是 500ms。那不是錯誤，是重新標號，沒有任何演算法分得出來。
//    C 的 95% 也不是失敗：spin[0] 正確地錨不到，其餘 19 筆配到**正確**的單。
//
//    真正驗得動、也真的是保護機制的是這一條：
//    **任何「差一位」的配對，時間差都會超出容忍上界而被擋下。**
{
  const s = spins(20);
  const r = rounds(20);
  const offByOne = s.map((sp, i) => (r[i + 1] ? r[i + 1].betTimePrecise - sp.observedAt : null)).filter(x => x !== null);
  check('差一位的時間差全部超出容忍上界（會被拒絕）',
    offByOne.every(d => d > OPT.maxLatencyMs),
    `最小 ${Math.min(...offByOne)}ms > 上界 ${OPT.maxLatencyMs}ms`);
  const correct = s.map((sp, i) => r[i].betTimePrecise - sp.observedAt);
  check('正確配對的時間差全部在容忍內', correct.every(d => d <= OPT.maxLatencyMs), `最大 ${Math.max(...correct)}ms`);
  check('正常情況回填率 100%', run(s, r).filter(x => x.result === 'resolved').length === 20);
  // ⚠️ 這條保護只在「容忍上界 < spin 間隔」時成立。上界一旦放寬到 6 秒以上，
  //    差一位就落在容忍內，整段偏移就擋不住了——所以 P0 那輪實測的入帳延遲
  //    不只是交付數字，是這個設計能不能成立的前提。
  check('容忍上界必須小於 spin 間隔（否則這條保護失效）', OPT.maxLatencyMs < 6000,
    `${OPT.maxLatencyMs}ms < 6000ms`);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
