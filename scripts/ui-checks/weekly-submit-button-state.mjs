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

console.log('\n6) pending 一定要在所有出口都被清掉（CodeX review 點名的風險）');
// ⚠️ 這條沒辦法靠跑一次證明——要證明的是「**任何**出口都會清」，而出口會隨著
//    之後改動增加。所以改成驗結構：清除必須寫在 finally 裡，而不是每個出口各寫一次。
//    靠擺放位置成立的性質，之後有人加一個 early return 就會靜默失效，
//    症狀是「這次正常收尾了，下次重啟卻把有結果的卡片覆蓋成『上一次送出中斷了』」。
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(root, 'server/weekly-report-bot.ts'), 'utf8');
  const handler = src.slice(src.indexOf('Events.InteractionCreate'), src.indexOf('Events.Error'));
  const sets = [...handler.matchAll(/writePending\(\{/g)].length;
  const clears = [...handler.matchAll(/writePending\(null\)/g)].length;
  check('handler 裡只有一處設定 pending', sets === 1, `${sets} 處`);
  check('handler 裡只有一處清除 pending（不是每個出口各清一次）', clears === 1, `${clears} 處`);
  // finally 到清除之間只允許註解與空白
  const inFinally = new RegExp('\\}\\s*finally\\s*\\{(?:\\s*\\/\\/[^\\n]*\\n)*\\s*writePending\\(null\\)').test(handler);
  check('那一處在 finally 裡', inFinally);
  // 設定 pending 之後、進 try 之前不能有 return——那段沒有 finally 保護。
  // ⚠️ 一定要先剝掉註解再比：這段的說明文字裡就有「early return 就會漏掉」，
  //    不剝的話這條永遠是紅的（第一次跑就被自己的註解咬到）。
  // ⚠️ 剝註解要用 [^\r\n] 不能用 `.*$`：這個 repo 的檔案是 CRLF，而 JS 的 `.`
  //    不匹配 \r，`$` 沒有 m 旗標時又只認字串結尾——兩個加起來就是一行都剝不掉。
  const between = handler
    .slice(handler.indexOf('writePending({'), handler.indexOf('try {'))
    .replace(/\/\/[^\r\n]*/g, '');
  check('設定 pending 之後到進 try 之前沒有 return', !new RegExp('\\breturn\\b').test(between));
}

// ── 還原 ──
if (original) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PENDING_KEY, original.value);
else db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_KEY);
const after = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY);
check('測試資料已還原', JSON.stringify(after) === JSON.stringify(original));

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
