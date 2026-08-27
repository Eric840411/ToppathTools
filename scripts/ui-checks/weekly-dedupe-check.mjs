/**
 * 防重複機制的驗證。**故意不碰 Lark**——按鈕按下去就真的寫進團隊共用的週報表、收不回來，
 * 所以這裡只驗「先搶再送」那個 claim 的行為，用合成資料直接對 DB 操作。
 *
 * 要驗的是 CodeX 指出的那個 race：不能「送出前查、送出後寫」，中間兩個 request 會同時
 * 查到不存在。正確做法是先 INSERT 搶 unique key，搶到的人才去送。
 *
 * 跑法：node scripts/ui-checks/weekly-dedupe-check.mjs
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

const db = new Database('../../server/data.db');
const KEY_PREFIX = '__dedupe_test__';

const key = (week, person, content, project) =>
  createHash('sha256').update([week, person, content, project].join(' ')).digest('hex').slice(0, 32);

const claim = db.prepare(`
  INSERT INTO weekly_report_submissions
    (dedupe_key, week_start, person, content, project, status, source, actor, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'processing', 'test', ?, ?, ?)
`);

const week = KEY_PREFIX + '2026/08/21';
const k = key(week, 'TestPerson', 'test content', 'P7-005-OSM');
let pass = 0; const fails = [];
const check = (name, cond) => cond ? pass++ : fails.push(name);

// 先清乾淨，避免上次沒清掉的殘留影響結果
db.prepare('DELETE FROM weekly_report_submissions WHERE week_start LIKE ?').run(KEY_PREFIX + '%');

// ① 第一次搶得到
let first = false;
try { claim.run(k, week, 'TestPerson', 'test content', 'P7-005-OSM', 'a', Date.now(), Date.now()); first = true } catch { /* */ }
check('第一次 claim 搶得到', first);

// ② 第二次一定要撞掉——這就是連按/多人按的防線
let second = false;
try { claim.run(k, week, 'TestPerson', 'test content', 'P7-005-OSM', 'b', Date.now(), Date.now()); second = true } catch { /* 預期撞 unique */ }
check('第二次 claim 被擋下（撞 unique）', !second);

// ③ 內容不同就是不同筆，不能被誤擋
const k2 = key(week, 'TestPerson', 'another content', 'P7-005-OSM');
let third = false;
try { claim.run(k2, week, 'TestPerson', 'another content', 'P7-005-OSM', 'a', Date.now(), Date.now()); third = true } catch { /* */ }
check('內容不同 → 視為不同筆，不會被誤擋', third);

// ④ 同內容但不同人也是不同筆
const k3 = key(week, 'OtherPerson', 'test content', 'P7-005-OSM');
let fourth = false;
try { claim.run(k3, week, 'OtherPerson', 'test content', 'P7-005-OSM', 'a', Date.now(), Date.now()); fourth = true } catch { /* */ }
check('人不同 → 視為不同筆', fourth);

// ⑤ failed 的要能被清掉重試，否則失敗一次就永遠卡住
db.prepare("UPDATE weekly_report_submissions SET status='failed' WHERE dedupe_key = ?").run(k);
const cleared = db.prepare("DELETE FROM weekly_report_submissions WHERE (status = 'failed' OR (status = 'processing' AND updated_at < ?)) AND week_start LIKE ?")
  .run(Date.now() - 600000, KEY_PREFIX + '%').changes;
check('failed 的可以被清掉重試', cleared === 1);
let retry = false;
try { claim.run(k, week, 'TestPerson', 'test content', 'P7-005-OSM', 'a', Date.now(), Date.now()); retry = true } catch { /* */ }
check('清掉之後同一筆可以重新 claim', retry);

// ⑥ 卡在 processing 但還很新的不能被清掉——那可能是另一個請求正在跑
const stillFresh = db.prepare("DELETE FROM weekly_report_submissions WHERE status = 'processing' AND updated_at < ? AND week_start LIKE ?")
  .run(Date.now() - 600000, KEY_PREFIX + '%').changes;
check('新的 processing 不會被誤清（可能有人正在跑）', stillFresh === 0);

// 清掉測試資料
const removed = db.prepare('DELETE FROM weekly_report_submissions WHERE week_start LIKE ?').run(KEY_PREFIX + '%').changes;

console.log(`\n通過 ${pass} 項，清掉 ${removed} 筆測試資料`);
if (fails.length) { console.log('失敗：'); for (const f of fails) console.log('  ❌ ' + f); process.exit(1) }
console.log('全部通過 ✅（沒有碰到 Lark）');
