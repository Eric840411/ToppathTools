/**
 * 補寫與移出的真 HTTP 並發（v5.12.2，CodeX review 1e123a9 [P2]）：
 *   修改分頁「重試」會先等「核對單子所屬空間」（真的打一次 Meegle get，約 1 秒），這段期間另一個分頁按「移出清單」要被擋。
 *   原本標記只包在後面的補寫，這段等待期間移出會成功、等待結束後照樣寫 Sheet。
 *
 * 做法：在本機 DB 塞一列假的「修改」紀錄（真的測試空間單號，前面三步都 done、回填 failed、來源是假的 Sheet）。
 * 重試時只會：讀一次單子（唯讀）→ 寫假 Sheet（必定失敗）。不會改到 Meegle 任何東西。結束一定刪掉。
 * 跑法：node scripts/ui-checks/backfill-dismiss-race.mjs
 */
import Database from 'better-sqlite3'

const HOST = 'http://192.168.3.41:3000'
const db = new Database('server/data.db')
const ADMIN = 'eric.wu@toppath.tw'
const { sid } = db.prepare('SELECT sid FROM auth_sessions WHERE email = ? AND expires_at > ? ORDER BY created_at DESC').get(ADMIN, Date.now())
const BATCH = 'dddddddd-dddd-4ddd-8ddd-' + String(Date.now()).slice(-12)
const WID = '15194995'   // 測試空間的單（只會被讀，不會被改）
const old = Date.now() - 10 * 60_000

db.prepare(`INSERT INTO meegle_edit_rows (batch_id, row_key, source_key, sheet_url, sheet_row, summary, work_item_id, owner_email, payload, space, created_at, updated_at)
  VALUES (?, ?, 'lark:RACETEST:race', '', 3, '並發測試', ?, ?, '{"raws":[],"baseline":{},"planHash":"","images":[]}', 'test', ?, ?)`).run(BATCH, WID, WID, ADMIN, old, old)
for (const [st, ph] of [['fields', 'done'], ['roles', 'done'], ['verify', 'done'], ['writeback', 'failed']]) {
  db.prepare('INSERT INTO meegle_edit_steps (batch_id, row_key, step, phase, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(BATCH, WID, st, ph, ph === 'failed' ? '模擬回填失敗' : null, old)
}

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const post = (path, body) => fetch(HOST + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `toppath_auth=${sid}` }, body: JSON.stringify(body) })
const item = { tool: 'edit', batchId: BATCH, rowKey: WID }
try {
  const pending = await (await fetch(`${HOST}/api/meegle/backfill/pending`, { headers: { cookie: `toppath_auth=${sid}` } })).json()
  check('假的列在待補清單裡', pending.items?.some(i => i.batchId === BATCH))

  const t0 = Date.now()
  const retry = post('/api/meegle/edit/row/retry', { batchId: BATCH, rowKey: WID })
  await new Promise(r => setTimeout(r, 250))   // 重試還在等「核對空間」
  const d1 = await (await post('/api/meegle/backfill/dismiss', { items: [item] })).json()
  const retryRes = await retry
  const elapsed = Date.now() - t0
  check('重試還在前置等待時移出 → 擋下', d1.results?.[0]?.ok === false && /正在補寫/.test(d1.results?.[0]?.message ?? ''), JSON.stringify(d1.results?.[0]?.message))
  check('重試確實有前置等待（> 400ms，否則這個測試沒有測到空窗）', elapsed > 400, `${elapsed}ms`)
  check('移出被擋時沒有寫入移出紀錄', !db.prepare('SELECT 1 FROM meegle_backfill_dismissed WHERE batch_id = ?').get(BATCH))
  check('重試請求本身有回應', retryRes.status < 500, String(retryRes.status))

  const d2 = await (await post('/api/meegle/backfill/dismiss', { items: [item] })).json()
  check('重試結束後（回填仍失敗）可以移出', d2.results?.[0]?.ok === true, JSON.stringify(d2.results?.[0]))
} finally {
  db.prepare('DELETE FROM meegle_edit_steps WHERE batch_id = ?').run(BATCH)
  db.prepare('DELETE FROM meegle_edit_rows WHERE batch_id = ?').run(BATCH)
  db.prepare('DELETE FROM meegle_backfill_dismissed WHERE batch_id = ?').run(BATCH)
  db.prepare("DELETE FROM operation_history WHERE feature = 'meegle-backfill' AND detail LIKE ?").run(`%${BATCH}%`)
}
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)
