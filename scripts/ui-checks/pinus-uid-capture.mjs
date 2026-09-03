/**
 * pinus 補丁的 uid 擷取：**只能認登入回應**。
 *
 * ⚠️ 這條的失敗方式比原本的 bug 更危險。原本是「uid 空的 → 撈不到資料」，
 *    如果改成「看到任何帶 uid 的封包就記」，會變成「撈到**別人**的戰績」——
 *    而且看起來完全正常，數字對得上、沒有錯誤，只是那不是這台機器的資料。
 *    使用者的真實日誌裡同時出現過 325599 與 328980 兩個 uid，
 *    所以這不是理論上的風險（CodeX review 特別點名）。
 *
 * 這支**從 `toppath-agent.py` 直接抽出那段 JS 來跑**，不是複製一份到測試裡。
 * 複製的話，之後有人放寬條件，這裡照樣是綠的。
 *
 * 跑法：node scripts/ui-checks/pinus-uid-capture.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ⚠️ 一定要先正規化換行。這個 repo 的檔案是 CRLF，而 regex 裡的 `\n` 對不上 `\r\n`
//    ——不處理的話這支永遠抽不到程式碼、永遠報「找不到」。今天第三次踩到同一個。
const src = fs.readFileSync(path.join(root, 'server/python/toppath-agent.py'), 'utf8').replace(/\r\n/g, '\n');

// 抽出注入腳本裡那段 uid 擷取。
// ⚠️ 錨點是 `__pinusUid` **不是路由字串**。第一版綁死 'gate.gateHandler.loginReq'，
//    結果把條件放寬成「任何封包都認」時，regex 直接抽不到 → 報「找不到程式碼」。
//    那雖然也是紅的，但理由是錯的：真正要抓的是「邏輯變寬鬆」，而不是「字串不見了」。
//    現在改成抓「內容含 __pinusUid 的那個 if 區塊」，條件怎麼改都抽得到，
//    由下面的行為斷言去判斷對不對。
// ⚠️ 用字串定位不用花俏的 regex。`(?:[^\n]*\n)*?` 那種寫法會從檔案裡**更早**的
//    某個 `if (` 開始匹配，抽出一整段完全不相干的程式碼還顯示成功——
//    第二版就是這樣抽到 WebSocket 重連那段的（量測工具自己先錯）。
const assignIdx = src.indexOf('window.__pinusUid = String(');
const ifIdx = assignIdx === -1 ? -1 : src.lastIndexOf('if (', assignIdx);
const endIdx = assignIdx === -1 ? -1 : src.indexOf('\n', src.indexOf('}', assignIdx));
if (assignIdx === -1 || ifIdx === -1 || endIdx === -1) {
  console.log('FAIL  找不到 uid 擷取那段（原始碼結構變了，這支檢查要跟著更新）');
  process.exit(1);
}
// 從外層 if 開始（lastIndexOf 會先命中內層的 `if (u)`，往前再找一個）
const outerIf = src.lastIndexOf('if (', ifIdx - 1);
const snippet = src.slice(outerIf, endIdx);
console.log('抽出的程式碼：\n' + snippet.split('\n').map(l => '    ' + l.trim()).join('\n') + '\n');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

/** 把抽出來的片段當成 (route, resp) => window.__pinusUid 來跑 */
const capture = new Function('route', 'resp', 'window', snippet + '\nreturn window.__pinusUid;');
const run = (pairs, start = undefined) => {
  const w = { __pinusUid: start };
  for (const [route, resp] of pairs) capture(route, resp, w);
  return w.__pinusUid;
};

// 以下 payload 取自使用者真實日誌的形狀
const LOGIN = ['gate.gateHandler.loginReq', { uid: '325599', expiretime: 1788419542770, logintoken: 'x' }];
const BROADCAST = ['status.statusHandler.broadcastReq', { gameid: 'bullblitz', uid: '328980', type: 1, amount: 104000 }];
const ENTER = ['connector.entryHandler.enterReq', { uid: '325599', clientip: '127.0.0.1' }];
const SPIN = ['hall.hallHandler.dealGMActionReq', { gameid: 'bullblitz', actionid: 7 }];

console.log('1) 只認登入回應');
check('登入回應會被記下來', run([LOGIN]) === '325599');
check('broadcast 帶的 uid 不會被記（那可能是別的玩家）', run([BROADCAST]) === undefined);
check('enterReq 帶的 uid 也不記（只認 login）', run([ENTER]) === undefined);
check('沒有 uid 的封包不影響', run([SPIN]) === undefined);

console.log('\n2) 最危險的情境：登入之後又收到別人的 uid');
// 這正是實際日誌的順序——登入拿到 325599，之後 broadcast 陸續帶 328980 進來
check('登入後再收到別人的 broadcast，不會被蓋掉',
  run([LOGIN, BROADCAST, BROADCAST, SPIN, BROADCAST]) === '325599');
check('先收到別人的 broadcast 再登入，結果仍是自己的',
  run([BROADCAST, BROADCAST, LOGIN]) === '325599');

console.log('\n3) 重連：新的登入要更新成新 uid');
check('第二次登入會覆蓋', run([LOGIN, ['gate.gateHandler.loginReq', { uid: '999' }]]) === '999');

console.log('\n4) 容錯');
check('uid 包在 data 裡也讀得到', run([['gate.gateHandler.loginReq', { data: { uid: '777' } }]]) === '777');
check('登入回應沒有 uid 時不覆蓋既有值',
  run([['gate.gateHandler.loginReq', { errcode: 3 }]], '325599') === '325599');
check('回應是 null 不會炸', run([['gate.gateHandler.loginReq', null]]) === undefined);
check('uid 是數字也轉成字串', run([['gate.gateHandler.loginReq', { uid: 325599 }]]) === '325599');

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
