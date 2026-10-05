/**
 * 補寫與移出的真 HTTP 並發（v5.12.3，CodeX review 1e123a9／074271b [P2]）。
 *
 * 修改分頁「重試」會先等「核對單子所屬空間」（真的打一次 Meegle get，約 1 秒），再寫 Sheet。要證明：
 *   A 重試還在**前置等待**時移出 → 被擋
 *   B 重試還在前置等待時**瀏覽器斷線** → 移出仍被擋；handler 真的跑完才解鎖
 *
 * ⚠️ 不能用「總耗時 > N ms」當證據（CodeX：那包含 Sheet 補寫和 dismiss，證明不了打 dismiss 時還在核對空間）。改成：
 *   1 輪詢待補清單的 busy，**確認請求已經進到 handler** 才打 dismiss
 *   2 打 dismiss 的當下，DB 裡 writeback 那一步**還沒開始**（phase 仍是 failed、updated_at 沒動）——證明是在前置等待，不是在寫 Sheet
 *   拿掉路由的標記（只剩寫 Sheet 那段的標記）時，busy 只會在寫 Sheet 期間出現 → 第 2 點必定失敗
 *
 * 做法：本機 DB 塞一列假的「修改」紀錄（真的測試空間單號、前三步 done、回填 failed、假的 Sheet）。
 * 重試只會：讀一次單子（唯讀）→ 寫假 Sheet（必定失敗）。不會改到 Meegle。結束一定刪掉。
 * 跑法：node scripts/ui-checks/backfill-dismiss-race.mjs
 */
import Database from 'better-sqlite3'

const HOST = 'http://192.168.3.41:3000'
const db = new Database('server/data.db')
const ADMIN = 'eric.wu@toppath.tw'
const { sid } = db.prepare('SELECT sid FROM auth_sessions WHERE email = ? AND expires_at > ? ORDER BY created_at DESC').get(ADMIN, Date.now())
const WID = '15194995'   // 測試空間的單（只會被讀）
const cookie = { cookie: `toppath_auth=${sid}` }
const post = (path, body, signal) => fetch(HOST + path, { method: 'POST', headers: { 'content-type': 'application/json', ...cookie }, body: JSON.stringify(body), signal })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

function seed(tag) {
  const batch = `dddddddd-dddd-4ddd-8ddd-${tag}${String(Date.now()).slice(-11)}`
  const old = Date.now() - 10 * 60_000
  db.prepare(`INSERT INTO meegle_edit_rows (batch_id, row_key, source_key, sheet_url, sheet_row, summary, work_item_id, owner_email, payload, space, created_at, updated_at)
    VALUES (?, ?, 'lark:RACETEST:race', '', 3, '並發測試', ?, ?, '{"raws":[],"baseline":{},"planHash":"","images":[]}', 'test', ?, ?)`).run(batch, WID, WID, ADMIN, old, old)
  for (const [st, ph] of [['fields', 'done'], ['roles', 'done'], ['verify', 'done'], ['writeback', 'failed']]) {
    db.prepare('INSERT INTO meegle_edit_steps (batch_id, row_key, step, phase, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(batch, WID, st, ph, ph === 'failed' ? '模擬回填失敗' : null, old)
  }
  return { batch, old }
}
const wbStep = batch => db.prepare("SELECT phase, updated_at FROM meegle_edit_steps WHERE batch_id = ? AND row_key = ? AND step = 'writeback'").get(batch, WID)
async function busyNow(batch) {
  const j = await (await fetch(`${HOST}/api/meegle/backfill/pending`, { headers: cookie })).json()
  return !!j.items?.find(i => i.batchId === batch)?.busy
}
async function waitBusy(batch, want, ms = 4000) {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await busyNow(batch) === want) return true; await sleep(25) }
  return false
}
const dismiss = batch => post('/api/meegle/backfill/dismiss', { items: [{ tool: 'edit', batchId: batch, rowKey: WID }] }).then(r => r.json())

const seeded = []
try {
  // ── A 前置等待時移出 ──
  console.log('[A] 重試卡在前置等待時移出')
  const A = seed('a'); seeded.push(A.batch)
  let retryDone = false
  const retry = post('/api/meegle/edit/row/retry', { batchId: A.batch, rowKey: WID }).then(r => { retryDone = true; return r })
  check('請求已進到 handler（待補清單顯示 busy）', await waitBusy(A.batch, true))
  const before = wbStep(A.batch)
  check('打移出當下：寫 Sheet 那一步還沒開始（證明在前置等待）', before.phase === 'failed' && before.updated_at === A.old, JSON.stringify(before))
  const d1 = await dismiss(A.batch)
  check('打移出當下重試還沒結束', !retryDone)
  check('前置等待時移出 → 擋下', d1.results?.[0]?.ok === false && /正在補寫/.test(d1.results?.[0]?.message ?? ''), JSON.stringify(d1.results?.[0]?.message))
  await retry
  check('移出被擋時沒有寫入移出紀錄', !db.prepare('SELECT 1 FROM meegle_backfill_dismissed WHERE batch_id = ?').get(A.batch))
  const d2 = await dismiss(A.batch)
  check('重試結束後（回填仍失敗）可以移出', d2.results?.[0]?.ok === true, JSON.stringify(d2.results?.[0]))

  // ── B 前置等待時斷線 ──
  console.log('[B] 重試卡在前置等待時瀏覽器斷線')
  const B = seed('b'); seeded.push(B.batch)
  const ac = new AbortController()
  const retryB = post('/api/meegle/edit/row/retry', { batchId: B.batch, rowKey: WID }, ac.signal).catch(() => null)
  check('請求已進到 handler', await waitBusy(B.batch, true))
  ac.abort(); await retryB
  await sleep(50)
  const st = wbStep(B.batch)
  check('斷線後：寫 Sheet 那一步還沒開始', st.phase === 'failed' && st.updated_at === B.old, JSON.stringify(st))
  const d3 = await dismiss(B.batch)
  check('斷線後 handler 還在跑 → 移出仍被擋', d3.results?.[0]?.ok === false && /正在補寫/.test(d3.results?.[0]?.message ?? ''), JSON.stringify(d3.results?.[0]?.message))
  check('handler 跑完才解鎖', await waitBusy(B.batch, false, 15000))
  check('handler 真的跑完了（寫 Sheet 那一步有嘗試過）', wbStep(B.batch).updated_at !== B.old)
} finally {
  for (const b of seeded) {
    db.prepare('DELETE FROM meegle_edit_steps WHERE batch_id = ?').run(b)
    db.prepare('DELETE FROM meegle_edit_rows WHERE batch_id = ?').run(b)
    db.prepare('DELETE FROM meegle_backfill_dismissed WHERE batch_id = ?').run(b)
    db.prepare("DELETE FROM operation_history WHERE feature = 'meegle-backfill' AND detail LIKE ?").run(`%${b}%`)
  }
}
console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)
