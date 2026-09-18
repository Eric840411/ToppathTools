/**
 * scripts/ui-checks/uat-backend-snippets.mjs
 *
 * 驗「後台設定片段」的儲存（`server/uat-backend-snippets.ts`）。
 *
 * ## 這在守什麼
 * 片段是「把後台改成某個狀態」的一段操作，給 H5/PC 腳本引用。它**刻意不是**
 * 後台錄製腳本——那個一定綁 Lark TC、跑完會回寫 TC 結果。所以這支要守住的是：
 *
 *   ① **不支援的動作存不進去，而且要指名是哪一個**（偷偷過濾掉的話，
 *      使用者會存下一份「看起來錄好了、跑起來少做事」的片段）
 *   ② **斷言與回寫類動作一律拒絕**（設定片段不該自己判 pass/fail，更不該改 Lark）
 *   ③ **並行存檔不能靜默覆蓋**（錄製腳本那邊踩過：後存的直接蓋掉前一個，沒有提示）
 *   ④ **刪除只有建立者**（讀寫共用不代表誰都能刪）
 *   ⑤ **刪除是軟刪除**（H5 腳本可能還引用著，硬刪會讓那顆積木指向空氣）
 *
 * 真的把 router 掛進 express 打，request context 建法跟 `worker.ts` 一致。
 *
 * 跑法：node scripts/ui-checks/uat-backend-snippets.mjs
 * ⚠️ 需要先 `npm run build`。
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const express = (await import('express')).default;
const mod = await load('dist-server/server/uat-backend-snippets.js');
const { db } = await load('dist-server/server/shared.js');

const ALICE = 'snippet-test-alice@toppath.invalid';
const BOB = 'snippet-test-bob@toppath.invalid';

/**
 * ⚠️ **走真正的登入 session，不去 stub `getAuthAccount`。**
 *    ES module 的 export 是唯讀的，改不了；而且就算改得了，stub 掉身分來源等於
 *    連「這支端點有沒有在檢查身分」都一起繞過——那正是要驗的東西之一。
 *
 * 所以插兩個**測試專用帳號**與對應的 session，跑完刪掉。
 * ⚠️ 開頭也先清一次同前綴的殘留，免得上一次跑到一半掛掉留下東西。
 */
const CLEAN = "email LIKE 'snippet-test-%@toppath.invalid'";
db.prepare(`DELETE FROM auth_sessions WHERE ${CLEAN}`).run();
db.prepare(`DELETE FROM jira_accounts WHERE ${CLEAN}`).run();
const sids = {};
for (const email of [ALICE, BOB]) {
  db.prepare('INSERT INTO jira_accounts (email, token, label, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(email, '', email.split('@')[0], 'user', 'active');
  const sid = `snippet-test-${email.split('@')[0]}-${Date.now()}`;
  db.prepare('INSERT INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sid, email, Date.now(), Date.now() + 10 * 60_000);
  sids[email] = sid;
}

const app = express();
app.use(express.json());
const router = express.Router();
mod.registerBackendSnippetRoutes(router);
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, url, { as, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  // `as: 'none'` = 不帶 cookie，也就是沒登入
  if (as && as !== 'none' && sids[as]) headers.cookie = `toppath_auth=${encodeURIComponent(sids[as])}`;
  const response = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json() } catch { /* 有些路徑不回 JSON */ }
  return { status: response.status, ok: response.ok, json };
};

const made = [];
try {
  // ── ① 存得起來的最小片段 ────────────────────────────────────────────────
  const created = await call('PUT', '/api/osm-uat/backend-snippets', {
    as: ALICE,
    body: { title: '開啟 XX 開關', note: '記得用另一份關回去',
      steps: [{ action: 'open_page', path: '/settings' }, { action: 'set_checked', selector: '#sw', checked: true }] },
  });
  check('① 正常片段存得起來', created.ok && !!created.json?.id, JSON.stringify(created.json));
  const id = created.json?.id;
  if (id) made.push(id);
  check('① 第一版 revision 是 1', created.json?.revision === 1, JSON.stringify(created.json));

  // ── ② 不支援的動作要被擋，而且指名 ──────────────────────────────────────
  const bad = await call('PUT', '/api/osm-uat/backend-snippets', {
    as: ALICE,
    body: { title: '混了斷言', steps: [{ action: 'set_checked', selector: '#sw' }, { action: 'assert_text', selector: '#x' }] },
  });
  check('② ⚠️ 含斷言類動作 → 存不進去', bad.status === 400, `HTTP ${bad.status}`);
  check('② ⚠️ 而且指名是哪一個（不能偷偷過濾掉）',
    String(bad.json?.message ?? '').includes('assert_text'), bad.json?.message);

  const writeBack = await call('PUT', '/api/osm-uat/backend-snippets', {
    as: ALICE, body: { title: '想改 TC 結果', steps: [{ action: 'set_tc_result', outcome: 'pass' }] },
  });
  check('② ⚠️ 回寫 TC 結果的動作也存不進去（設定片段不該改 Lark）',
    writeBack.status === 400 && String(writeBack.json?.message ?? '').includes('set_tc_result'),
    writeBack.json?.message);

  const empty = await call('PUT', '/api/osm-uat/backend-snippets', { as: ALICE, body: { title: '空的', steps: [] } });
  check('② 零步驟的片段存不進去（零操作不等於設定成功）', empty.status === 400, `HTTP ${empty.status}`);

  // ── ③ 並行存檔不得靜默覆蓋 ──────────────────────────────────────────────
  if (id) {
    const first = await call('PUT', '/api/osm-uat/backend-snippets', {
      as: ALICE, body: { id, title: 'A 改的', revision: 1, steps: [{ action: 'set_checked', selector: '#sw', checked: true }] },
    });
    check('③ 帶著正確 revision 存得進去', first.ok && first.json?.revision === 2, JSON.stringify(first.json));
    const stale = await call('PUT', '/api/osm-uat/backend-snippets', {
      as: BOB, body: { id, title: 'B 改的（拿的是舊版）', revision: 1, steps: [{ action: 'set_checked', selector: '#sw', checked: false }] },
    });
    check('③ ⚠️ 拿舊版本存檔要被擋（不能靜默蓋掉對方）', stale.status === 409, `HTTP ${stale.status}`);
    check('③ 而且要講得出版本差在哪',
      /版本|revision/.test(String(stale.json?.message ?? '')), stale.json?.message);
    const after = await call('GET', `/api/osm-uat/backend-snippets/${id}`, { as: ALICE });
    check('③ ⚠️ 被擋下來之後內容仍然是 A 的（沒有被覆蓋）',
      after.json?.snippet?.title === 'A 改的', JSON.stringify(after.json?.snippet?.title));
  }

  // ── ④ 讀寫共用，但刪除只有建立者 ────────────────────────────────────────
  if (id) {
    const list = await call('GET', '/api/osm-uat/backend-snippets', { as: BOB });
    check('④ 別人看得到（團隊共用）',
      (list.json?.snippets ?? []).some(s => s.id === id), JSON.stringify(list.json?.snippets?.length));
    check('④ 清單有回支援哪些動作（前端才講得出為什麼存不起來）',
      Array.isArray(list.json?.supportedActions) && list.json.supportedActions.includes('set_checked'),
      JSON.stringify(list.json?.supportedActions));

    const bobDelete = await call('DELETE', `/api/osm-uat/backend-snippets/${id}`, { as: BOB });
    check('④ ⚠️ 不是建立者不能刪', bobDelete.status === 403, `HTTP ${bobDelete.status}`);
    const stillThere = await call('GET', `/api/osm-uat/backend-snippets/${id}`, { as: BOB });
    check('④ ⚠️ 而且真的沒被刪掉', stillThere.ok, `HTTP ${stillThere.status}`);
  }

  // ── ⑤ 刪除是軟刪除 ──────────────────────────────────────────────────────
  if (id) {
    const del = await call('DELETE', `/api/osm-uat/backend-snippets/${id}`, { as: ALICE });
    check('⑤ 建立者刪得掉', del.ok, `HTTP ${del.status}`);
    const gone = await call('GET', `/api/osm-uat/backend-snippets/${id}`, { as: ALICE });
    check('⑤ 刪掉之後讀不到', gone.status === 404, `HTTP ${gone.status}`);
    const row = db.prepare('SELECT deleted_at FROM uat_backend_snippets WHERE id = ?').get(id);
    check('⑤ ⚠️ 但資料列還在（軟刪除——H5 腳本可能還引用著它）',
      !!row && row.deleted_at, JSON.stringify(row));
  }

  // ── ⑥ 沒登入一律擋 ──────────────────────────────────────────────────────
  const anon = await call('GET', '/api/osm-uat/backend-snippets', { as: 'none' });
  check('⑥ 沒登入看不到清單', anon.status === 401, `HTTP ${anon.status}`);
  const anonWrite = await call('PUT', '/api/osm-uat/backend-snippets', {
    as: 'none', body: { title: 'x', steps: [{ action: 'set_checked', selector: '#a' }] },
  });
  check('⑥ 沒登入也存不了', anonWrite.status === 401, `HTTP ${anonWrite.status}`);
} finally {
  for (const id of made) {
    try { db.prepare('DELETE FROM uat_backend_snippets WHERE id = ?').run(id) } catch { /* 清不掉就算了 */ }
  }
  // ⚠️ 測試帳號一定要清掉——留著的話它們會出現在權限管理頁面的帳號清單裡
  try {
    db.prepare(`DELETE FROM auth_sessions WHERE ${CLEAN}`).run();
    db.prepare(`DELETE FROM jira_accounts WHERE ${CLEAN}`).run();
  } catch { /* 清不掉就算了 */ }
  server.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
