/**
 * scripts/ui-checks/live-ledger-sls-machine.mjs
 *
 * 驗「把 SLS 綁到單一機台」這條線 —— 使用者要的是
 * 「操作 A 獎池就只監控 A 獎池的 LOG 就好，其餘不管」。
 *
 * 🚨 這裡最容易出的錯不是算錯，是**對應到別台機器的 log**。
 * 那種錯的症狀是「畫面說 A 機台服務正常」，而你看的其實是 B 的 log——
 * 比沒有這個功能還糟。所以對應一律走 `groupId`，不走名稱比對。
 *
 * ⚠️ 實測過名稱比對為什麼不能用（2026-09-17）：
 *   · `873-DFDC-*` 會被前綴配到 `dfdcgrand-*`（不同遊戲）
 *   · `897-BIGFULINK-2065` 的 log 其實在 `bigfucash`——名稱完全不像
 *   · 23 種遊戲代號只有 12 種配得上
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const m = await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger-sls-machine.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const now = Date.now();
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};
const line = (text, tsOffsetSec = 0) => ({ ts: now - tsOffsetSec * 1000, text });

console.log('1) 事件判定：MML');
// 有客戶端登入、心跳正常、但一次廣播都沒有 → 獎池沒下發
let ev = m.detectEvents('mml', 'ls', [
  line('已连接上的客户端信息: 总数:1 握手完成:1 登录完成:1, 当前线程数:5 groupId: 132', 30),
  line('其他日誌', 20),
], now);
check('有登入卻沒廣播 → broadcast_stopped',
  ev.some(e => e.kind === 'broadcast_stopped'), JSON.stringify(ev.map(e => e.kind)));
// ⚠️ 沒有客戶端時 0 廣播是正常的，報了就是所有閒置機台天天假警報
ev = m.detectEvents('mml', 'ls', [
  line('已连接上的客户端信息: 总数:0 握手完成:0 登录完成:0, 当前线程数:5 groupId: 132', 30),
], now);
check('沒有客戶端登入時沒廣播 → 不報', ev.length === 0, JSON.stringify(ev.map(e => e.kind)));
// 心跳完全沒有 = 連線層死了，程序還活著所以不會有錯誤訊息
ev = m.detectEvents('mml', 'ls', [line('build cmd 4101 4487 {}', 10), line('隨便一行', 5)], now);
check('有輸出但沒有心跳 → heartbeat_stopped',
  ev.some(e => e.kind === 'heartbeat_stopped'), JSON.stringify(ev.map(e => e.kind)));
// 正常
ev = m.detectEvents('mml', 'ls', [
  line('已连接上的客户端信息: 总数:1 握手完成:1 登录完成:1, 当前线程数:5 groupId: 132', 30),
  line('build cmd 4101 4487 {}', 10),
], now);
check('心跳與廣播都有 → 無事件', ev.length === 0, JSON.stringify(ev.map(e => e.kind)));

console.log('\n2) 事件判定：G2S');
ev = m.detectEvents('g2s', 'ls', [line('[State: offLine] x', 40), line('[State: offLine] y', 20)], now);
check('offLine × 2 → offline 事件、count=2',
  ev.some(e => e.kind === 'offline' && e.count === 2), JSON.stringify(ev.map(e => [e.kind, e.count])));
check('事件要帶時間點（報告要顯示「什麼時候」）',
  (ev.find(e => e.kind === 'offline')?.times || []).length === 2);
ev = m.detectEvents('g2s', 'ls', [line('{"errorCode": "G2S_none"}', 10)], now);
check('errorCode 是 G2S_none → 不算協議錯', !ev.some(e => e.kind === 'protocol_error'));
ev = m.detectEvents('g2s', 'ls', [line('{"errorCode": "G2S_APX9"}', 10)], now);
check('errorCode 非 G2S_none → protocol_error', ev.some(e => e.kind === 'protocol_error'));

console.log('\n3) 完全沒有輸出');
ev = m.detectEvents('mml', 'ls', [], now);
check('沒有任何 log → no_output 事件', ev.length === 1 && ev[0].kind === 'no_output');

console.log('\n4) 🚨 機台 → logstore 的對應（真實資料，不是造的）');
const cases = [
  ['897-BIGFULINK-2065', 'bigfucash', '名稱完全不像，前綴比對永遠配不到'],
  ['873-LIONLINK-1337', 'lionlink', ''],
  ['666-DFDCGRAND-0148', 'dfdcgrand-mml-v8', ''],
];
for (const [machine, expectStore, why] of cases) {
  const gids = m.groupIdsForMachine('qat', machine);
  const stores = m.logstoresForGroups(gids).map(x => x.logstore);
  check(`${machine} → ${expectStore}${why ? `（${why}）` : ''}`,
    stores.some(s => s.includes(expectStore)), `groupId=[${gids}] stores=${stores.join(',')}`);
}
// ⚠️ 反例：確認不會配到別的遊戲去
const dfdcStores = m.logstoresForGroups(m.groupIdsForMachine('qat', '666-DFDCGRAND-0148')).map(x => x.logstore);
check('DFDCGRAND 的 groupId 不會配到 lionlink',
  !dfdcStores.some(s => s.includes('lionlink')), dfdcStores.join(','));

console.log('\n5) 🚨 查不到對應時要說「查不了」，不可以說「沒問題」');
const st = await m.machineSlsStatus('qat', '__no_such_machine__', now - 600_000, now);
check('不存在的機台 → unmapped', st.unmapped === true, JSON.stringify(st.unmapped));
check('說明要講明「無法定位」而不是「正常」',
  /無法定位|找不到/.test(st.note) && !/正常/.test(st.note), st.note.slice(0, 60));

console.log('\n6) 索引表真的有資料（不然上面全是空跑）');
const n = db.prepare('SELECT COUNT(*) n FROM recon_sls_logstore_group').get().n;
check('recon_sls_logstore_group 有索引資料', n > 0, `${n} 筆`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
