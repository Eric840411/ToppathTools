/**
 * 驗證「修為累計」整條接線：request context → addHistory → account_cultivation。
 *
 * 為什麼不用打真的 API：會寫 history 的端點都是真實操作（開單、跑測試、送週報），
 * 不能為了測試去動真的 Jira/Lark。這支直接載入編譯後的 server 模組，
 * 用真實的 context 呼叫 addHistory，驗證的是同一條程式路徑。
 *
 * 三件要驗的事：
 *   1. 有登入身分 → total_actions 會加
 *   2. 沒有登入身分（背景工作 / cron）→ **不會**加
 *   3. header 影響不了記在誰頭上（用 authEmail 不是 ctx.user）
 *
 * 跑完會自己清掉測試資料。
 *
 * ⚠️ 必須從 **repo 根目錄** 跑：dist-server/server/shared.js 是用相對路徑開
 *    server/data.db 的，在別的工作目錄下會開到不存在的路徑而直接拋錯。
 * 跑法：node scripts/ui-checks/cultivation-action-check.mjs
 */
import Database from 'better-sqlite3';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// 從這支檔案自己的位置往上兩層找 repo 根，不依賴呼叫者的工作目錄
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctxMod = await import(pathToFileURL(path.join(root, 'dist-server/server/request-context.js')).href);
const sharedMod = await import(pathToFileURL(path.join(root, 'dist-server/server/shared.js')).href);

const TEST_EMAIL = '__cultivation_probe__@test.local';
const db = new Database(path.join(root, 'server/data.db'));
const read = () => db.prepare('SELECT total_actions, today_actions, today_date FROM account_cultivation WHERE operator_key = ?').get(TEST_EMAIL);
const cleanup = () => {
  db.prepare('DELETE FROM account_cultivation WHERE operator_key = ?').run(TEST_EMAIL);
  db.prepare("DELETE FROM operation_history WHERE feature = '__probe__'").run();
};

cleanup();
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const baseCtx = { user: 'someone-else@spoofed.local', userDisplay: 'X', ip: '127.0.0.1', path: '/x', method: 'POST', operation: 'probe' };

console.log('1) 有登入身分時應該累加');
ctxMod.runWithRequestContext({ ...baseCtx, authEmail: TEST_EMAIL }, () => {
  sharedMod.addHistory('__probe__', 't', 's', {});
  sharedMod.addHistory('__probe__', 't', 's', {});
});
let row = read();
check('total_actions 累加到 2', row?.total_actions === 2, `實際 ${row?.total_actions}`);
check('today_actions 同步為 2', row?.today_actions === 2, `實際 ${row?.today_actions}`);

console.log('\n2) 沒有登入身分（背景工作）不該累加');
const before = read().total_actions;
ctxMod.runWithRequestContext({ ...baseCtx, authEmail: undefined }, () => {
  sharedMod.addHistory('__probe__', 't', 's', {});
});
check('total_actions 沒有變動', read().total_actions === before, `${before} → ${read().total_actions}`);

console.log('\n3) 記在登入帳號上，不是 header 給的 ctx.user');
const spoofed = db.prepare('SELECT total_actions FROM account_cultivation WHERE operator_key = ?').get('someone-else@spoofed.local');
check('被冒用的那個 email 沒有拿到修為', !spoofed, spoofed ? `竟然有 ${spoofed.total_actions}` : '（查無此列，正確）');

console.log('\n4) 讀取端算得出功課與副稱號');
const info = sharedMod.getCultivationInfo(TEST_EMAIL);
check('todayActions 讀回 2', info.todayActions === 2, `實際 ${info.todayActions}`);
check('還沒到 3 次所以沒有完成功課', info.questDone === null, `questDone=${info.questDone}`);
check('下一階段是「吐納」(3)', info.nextQuest?.name === '吐納' && info.nextQuest?.at === 3);
check('修為 2 → 副稱號「閉關中」', info.epithet === '閉關中', `實際 ${info.epithet}`);

cleanup();
console.log(`\n測試資料已清除。${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
