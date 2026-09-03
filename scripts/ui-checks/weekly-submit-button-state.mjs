/**
 * 週報 Discord 送出按鈕：「發送中…」不能變成永遠鎖死。
 *
 * ⚠️ 這次改動本身是為了防呆（按下就 disable），但它引進一個更糟的壞法：
 *    process 死在送出途中 → 卡片永遠停在「發送中…」→ 從 Discord 再也按不了。
 *    原本至少還停在可點狀態。所以復原路徑跟防呆本身一樣重要（CodeX：不要永遠鎖死）。
 *
 * 這支不連 Discord，用假的 client 驗 recoverStuckSubmit 的行為，
 * 以及 pending 紀錄的讀寫。**跑完會還原 settings 表**。
 *
 * 跑法：node scripts/ui-checks/weekly-submit-button-state.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(path.join(root, 'dist-server/server/weekly-report-bot.js')).href);
const T = mod.__testables;
const { readPending, writePending, recoverStuckSubmit, enabledRow, disabledRow, PENDING_KEY, setClientForTest } = T;

const db = new Database(path.join(root, 'server/data.db'));
// ⚠️ 一定要先存下原本的值，跑完還原——這支會真的寫 settings 表
const original = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

/** 假的 Discord client：只記下 edit 被呼叫時傳了什麼 */
function fakeClient({ channelMissing = false, messageMissing = false } = {}) {
  const edits = [];
  return {
    edits,
    channels: {
      fetch: async () => {
        if (channelMissing) throw new Error('Unknown Channel');
        return {
          messages: {
            fetch: async () => {
              if (messageMissing) throw new Error('Unknown Message');
              return { edit: async (payload) => { edits.push(payload); } };
            },
          },
        };
      },
    },
  };
}

console.log('\n1) 按鈕列的形狀');
const dis = disabledRow('發送中…');
const en = enabledRow('重試送出');
check('發送中是 disabled', dis.components[0].disabled === true);
check('發送中的文字對', dis.components[0].label === '發送中…');
check('可點的那顆沒有 disabled 旗標', en.components[0].disabled === undefined);
check('兩者 custom_id 相同（同一顆按鈕的不同狀態）',
  dis.components[0].custom_id === en.components[0].custom_id);

console.log('\n2) pending 紀錄讀寫');
writePending(null);
check('沒有紀錄時回 null', readPending() === null);
const rec = { channelId: 'C1', messageId: 'M1', startedAt: Date.now() - 5 * 60_000, userTag: 'tester#1' };
writePending(rec);
check('寫進去讀得回來', JSON.stringify(readPending()) === JSON.stringify(rec));
writePending(null);
check('清掉之後回 null', readPending() === null);

console.log('\n3) 復原：有遺骸就把卡片改回可重試');
writePending(rec);
const c1 = fakeClient();
setClientForTest(c1);
await recoverStuckSubmit();
check('編輯了那則訊息', c1.edits.length === 1);
check('按鈕改回可點', c1.edits[0]?.components?.[0]?.components?.[0]?.disabled === undefined);
check('按鈕文字是「重試送出」', c1.edits[0]?.components?.[0]?.components?.[0]?.label === '重試送出');
// ⚠️ 送到一半掛掉時前面那幾筆是真的寫進 Lark 了，文案不能說成「沒有送出」
check('文案講明「不確定完成到哪一筆」', /不確定完成到哪一筆/.test(c1.edits[0]?.content ?? ''));
check('文案講明重試不會重複', /不會重複送/.test(c1.edits[0]?.content ?? ''));
check('復原後 pending 已清掉（不會每次啟動都改一次）', readPending() === null);

console.log('\n4) 沒有遺骸就什麼都不做');
writePending(null);
const c2 = fakeClient();
setClientForTest(c2);
await recoverStuckSubmit();
check('完全沒有動任何訊息', c2.edits.length === 0);

console.log('\n5) 復原失敗不能讓 bot 起不來');
// 訊息可能已被刪除、頻道權限可能變了——這些都不該往外拋
writePending(rec);
setClientForTest(fakeClient({ messageMissing: true }));
let threw = false;
try { await recoverStuckSubmit() } catch { threw = true }
check('訊息不存在時不拋例外', !threw);
check('就算改不動也要清掉 pending（不然每次啟動都重試一次）', readPending() === null);

writePending(rec);
setClientForTest(fakeClient({ channelMissing: true }));
threw = false;
try { await recoverStuckSubmit() } catch { threw = true }
check('頻道抓不到時不拋例外', !threw);

// ── 還原 ──
if (original) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PENDING_KEY, original.value);
else db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_KEY);
const after = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY);
check('測試資料已還原', JSON.stringify(after) === JSON.stringify(original));

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
