/**
 * scripts/ui-checks/live-ledger-sls.mjs
 *
 * 驗 L6 G2S／MML **服務健康偵測**的判定邏輯。
 *
 * ⚠️ **為什麼是純函式測試**：`judge()` 與 `countSignals()` 刻意不碰網路，
 * 因為「會不會誤報」這件事不能靠在線上等它出事來驗證——線上大部分時間
 * 一切正常，等於永遠沒測到。
 *
 * 🚨 這條線最容易死的方式是**天天假警報**：30 個 logstore 裡大部分平常就沒流量，
 * 「近 10 分鐘 0 筆」對它們是常態。把常態報成異常，一週內就沒有人會再看它。
 * 所以下面花最多篇幅在「什麼時候**不准**報」。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { judge, countSignals } = await import(
  pathToFileURL(path.join(root, 'dist-server/server/live-ledger-sls.js')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

console.log('1) 訊號辨識（字串都是實測從 SLS 撈到的形狀）');
const mmlLines = [
  '已连接上的客户端信息: 总数:12 握手完成:12 登录完成:12, 当前线程数:4 groupId: 113',
  'build cmd 4101 4487 {"linkId":3,"jackpot_data":[{"level":1,"dbId":504,"amount":948.24}]}',
  'build cmd 4101 4022 {"linkId":1,"jackpot_data":[]}',
  '一些無關的日誌',
];
let s = countSignals('mml', mmlLines);
check('MML 心跳認得出來', s.heartbeat === 1, JSON.stringify(s));
check('MML JP 廣播認得出來', s.jpBroadcast === 2, JSON.stringify(s));
// ⚠️ 登录完成 是判斷「該不該有廣播」的關鍵；抓不到它就只能一律放過
check('心跳行裡的「登录完成」數字抓得出來', s.loggedIn === 12, JSON.stringify(s));

const g2sLines = [
  '[State: onLine] machine 2065',
  '[HTTP UpdateJP] 收到服务器彩金更新',
  '{"errorCode": "G2S_none", "statusCode": 200}',
];
s = countSignals('g2s', g2sLines);
check('G2S onLine 認得出來', s.onLine === 1, JSON.stringify(s));
check('G2S 彩金更新認得出來', s.updateJp === 1, JSON.stringify(s));
// ⚠️ G2S_none 是**正常值**，不可以被算成協議錯
check('errorCode 是 G2S_none 時不算協議錯', s.protocolError === 0, JSON.stringify(s));
s = countSignals('g2s', ['{"errorCode": "G2S_APX999", "statusCode": 500}']);
check('errorCode 不是 G2S_none 時算協議錯', s.protocolError === 1, JSON.stringify(s));
s = countSignals('g2s', ['[State: offLine] machine 2065']);
check('offLine 認得出來', s.offLine === 1, JSON.stringify(s));

console.log('\n2) 🚨 什麼時候不准報（假警報防線）');
// 兩個窗都沒資料 = 這個遊戲本來就沒在跑
let v = judge('mml', 0, 0, { heartbeat: 0, jpBroadcast: 0 });
check('近窗 0 + 長窗 0 → idle，不是異常', v.verdict === 'idle', v.verdict);
// ⚠️ 長窗只有零星幾行 = 只有 PM2 雜訊。實測 wlzbhelix 那支 72 小時只有 10 筆
v = judge('mml', 0, 4, { heartbeat: 0, jpBroadcast: 0 });
check('長窗只有 4 行（低於門檻 20）→ 仍是 idle，不報「安靜了」', v.verdict === 'idle', v.verdict);
check('說明講明是門檻問題不是服務問題', v.note.includes('門檻'), v.note.slice(0, 40));

console.log('\n3) 🚨 什麼時候一定要報');
v = judge('mml', 0, 500, { heartbeat: 0, jpBroadcast: 0 });
check('長窗有大量資料、近窗 0 → went_silent', v.verdict === 'went_silent', v.verdict);
check('說明講明「服務掛掉不會印錯誤」這個判斷依據',
  v.note.includes('不會印錯誤'), v.note.slice(0, 50));

// ⚠️ 有輸出但心跳停了 = 連線層死了、程序還活著。這種最陰：不會有錯誤訊息
v = judge('mml', 150, 0, { heartbeat: 0, jpBroadcast: 0 });
check('有 150 行輸出但心跳與廣播都 0 → went_silent（不是 ok）', v.verdict === 'went_silent', v.verdict);
check('說明指出是連線層死了', v.note.includes('連線層'), v.note.slice(0, 40));

v = judge('g2s', 100, 0, { onLine: 0, offLine: 3, updateJp: 5, protocolError: 0 });
check('G2S 出現 offLine → degraded', v.verdict === 'degraded', v.verdict);
check('degraded 說明講得出斷線幾次', v.note.includes('3'), v.note);
v = judge('g2s', 100, 0, { onLine: 9, offLine: 0, updateJp: 8, protocolError: 2 });
check('G2S 協議錯 → degraded', v.verdict === 'degraded', v.verdict);
v = judge('g2s', 100, 0, { onLine: 0, offLine: 0, updateJp: 0, protocolError: 0 });
check('G2S 有輸出但完全沒有協議訊號 → went_silent', v.verdict === 'went_silent', v.verdict);

/**
 * 4) 🚨 有客戶端登入但完全沒有 JP 廣播
 *
 * 2026-09-17 實測真的抓到的形狀：`dfdcgrand-mml-v8` 心跳 3 筆、`登录完成:1`，
 * JP 廣播 **0**；同一時間其他 8 台同樣「登录完成 ≥ 1」的全都是 48~50 次。
 *
 * ⚠️ 第一版判定是「心跳或廣播其一 > 0 就算 ok」，**這台被判成正常**——
 *    連線層活著蓋過了「獎池根本沒下發」。機台連得上、看得到畫面，
 *    但池值不會更新，而監控說一切正常。
 */
console.log('\n4) 🚨 連線正常但獎池沒下發（實測抓到的形狀）');
v = judge('mml', 100, 0, { heartbeat: 3, jpBroadcast: 0, loggedIn: 1 });
check('有登入、心跳正常、廣播 0 → degraded（不是 ok）', v.verdict === 'degraded', v.verdict);
check('說明講得出是「沒有下發給機台」而不是只說「廣播 0」',
  v.note.includes('沒有下發'), v.note.slice(0, 60));
// ⚠️ 反面：沒有客戶端時 0 廣播是正常的，不看 loggedIn 會把所有閒置機台都報成異常
v = judge('mml', 100, 0, { heartbeat: 3, jpBroadcast: 0, loggedIn: 0 });
check('沒有客戶端登入時廣播 0 → ok（不可以誤報）', v.verdict === 'ok', v.verdict);
check('ok 的說明要解釋為什麼沒廣播是正常的',
  v.note.includes('沒有客戶端登入'), v.note.slice(0, 50));

console.log('\n5) 正常情況要判 ok');
v = judge('mml', 100, 0, { heartbeat: 3, jpBroadcast: 49, loggedIn: 1 });
check('MML 心跳與廣播都有 → ok', v.verdict === 'ok', v.verdict);
check('ok 也要把數字講出來（不是只說「正常」）',
  v.note.includes('3') && v.note.includes('49'), v.note);
v = judge('g2s', 100, 0, { onLine: 9, offLine: 0, updateJp: 8, protocolError: 0 });
check('G2S onLine + 彩金更新 → ok', v.verdict === 'ok', v.verdict);

console.log('\n6) 🚨 degraded 的優先序高於「有訊號就算 ok」');
// 同時有正常訊號與 offLine 時，不可以因為 onLine 有值就判 ok
v = judge('g2s', 100, 0, { onLine: 9, offLine: 1, updateJp: 8, protocolError: 0 });
check('onLine 正常但出現 1 次 offLine → 仍判 degraded', v.verdict === 'degraded', v.verdict);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
