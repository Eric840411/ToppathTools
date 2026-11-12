/**
 * scripts/ui-checks/batch-retarget-route.mjs（v5.82.0）
 * 打真的 osm-uat router 驗批次改綁：預覽不改東西、套用只套 ready、預覽後被改過擋下、別人的腳本擋下。
 * 用法：node scripts/ui-checks/batch-retarget-route.mjs "<新表 Lark 網址>"（會真的讀那張 Lark 表，只讀）
 * 跑在本機 data.db：動到的腳本先整列備份、結尾寫回；改綁備份列與現發 session 結尾刪除。
 */
import path from 'path'; import { pathToFileURL, fileURLToPath } from 'url'; import Database from 'better-sqlite3'
import express from 'express'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const imp = p => import(pathToFileURL(path.join(root, p)).href)
const { devSidHash } = await imp('scripts/ui-checks/lib/dev-session.mjs')
const mod = await imp('dist-server/server/routes/osm-uat.js')
const { fetchLarkTcList } = mod
const router = mod.default ?? mod.router
const db = new Database(path.join(root, 'server/data.db'))
const NEW_URL = process.argv[2]
if (!NEW_URL) { console.log('要帶新表網址'); process.exit(2) }

const admin = db.prepare("SELECT email FROM jira_accounts WHERE role='admin'").get()?.email
const user = db.prepare("SELECT email FROM jira_accounts WHERE role<>'admin'").get()?.email
const mk = (sid, email) => db.prepare('INSERT INTO auth_sessions (sid,email,created_at,expires_at) VALUES (?,?,?,?)').run(devSidHash(sid), email, Date.now(), Date.now() + 600000)
mk('brt_admin', admin); mk('brt_user', user)

const ids = db.prepare("SELECT id FROM frontend_auto_scripts WHERE deleted_at IS NULL AND bindings NOT IN ('', '[]') ORDER BY id LIMIT 40").all().map(r => r.id)
const backup = ids.map(id => db.prepare('SELECT * FROM frontend_auto_scripts WHERE id=?').get(id))
const t0 = Date.now()

const app = express(); app.use(express.json()); app.use(router)
app.use((err, _q, res, _n) => res.status(500).json({ ok: false, message: String(err) }))
const srv = app.listen(0); const port = srv.address().port
const call = async (p, body, sid) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { cookie: `toppath_auth=${sid}` } : {}) }, body: JSON.stringify(body) }); return [r.status, await r.json().catch(() => null)] }
let fail = 0; const ck = (n, ok, x = '') => { console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!ok) fail++ }
const snap = () => JSON.stringify(ids.map(id => db.prepare('SELECT table_id, bindings, steps, updated_at FROM frontend_auto_scripts WHERE id=?').get(id)))

try {
  let r = await call('/api/osm-uat/retarget/batch-plan', { scriptIds: ids, newLarkUrl: NEW_URL })
  ck('沒登入 → 401', r[0] === 401, String(r[0]))
  // 模擬「新表是從舊表複製的」：取 4 支腳本，綁定改成新表的編號＋內容、但 recordId／tableId 是假的舊表。
  //    第一支故意挑新表裡編號重複（靠內容區分）的 TC，驗「編號＋內容」消歧在真資料上能配。
  const live = await fetchLarkTcList(NEW_URL)
  const numCount = {}; for (const t of live.tcs) numCount[t.number] = (numCount[t.number] ?? 0) + 1
  const dupTcs = live.tcs.filter(t => t.number && numCount[t.number] > 1 && t.text).slice(0, 3)
  const uniqTcs = live.tcs.filter(t => t.number && numCount[t.number] === 1 && t.text)
  const fakeSets = [dupTcs, uniqTcs.slice(0, 2), uniqTcs.slice(2, 4), uniqTcs.slice(4, 6)]
  ids.slice(0, 4).forEach((id, i) => {
    const bindings = fakeSets[i].map((t, j) => ({ recordId: `recOLD${i}_${j}`, tableId: 'tblCOPYTEST', number: t.number, text: t.text, sub: t.sub ?? '' }))
    const steps = bindings.map(bd => ({ id: `s_${bd.recordId}`, type: 'wait', ms: 1, tcId: bd.recordId }))
    db.prepare("UPDATE frontend_auto_scripts SET table_id='tblCOPYTEST', bindings=?, steps=? WHERE id=?").run(JSON.stringify(bindings), JSON.stringify(steps), id)
  })
  // 本機舊腳本 owner_email 都是空的（非管理員會被擋成 no-owner）→ 先全部記成測試用帳號的
  for (const id of ids) db.prepare('UPDATE frontend_auto_scripts SET owner_email=? WHERE id=?').run(user, id)
  const noOwnerId = ids[ids.length - 1]
  db.prepare("UPDATE frontend_auto_scripts SET owner_email='' WHERE id=?").run(noOwnerId)
  r = await call('/api/osm-uat/retarget/batch-plan', { scriptIds: ids, newLarkUrl: NEW_URL }, 'brt_user')
  ck('非管理員：沒記擁有者的舊腳本 → no-owner', r[1]?.scripts?.find(x => x.scriptId === noOwnerId)?.status === 'no-owner')
  const before = snap()
  r = await call('/api/osm-uat/retarget/batch-plan', { scriptIds: ids, newLarkUrl: NEW_URL }, 'brt_admin')
  ck('預覽 200', r[0] === 200 && r[1]?.ok, JSON.stringify(r[1]).slice(0, 200))
  const plan = r[1]?.scripts ?? []
  const count = s => plan.filter(p => p.status === s).length
  console.log(`    目標表 ${r[1]?.newTableId}（${r[1]?.newTcCount} 筆）；ready ${count('ready')}／needs-review ${count('needs-review')}／same-table ${count('same-table')}／其他 ${plan.length - count('ready') - count('needs-review') - count('same-table')}`)
  ck('預覽不改任何腳本', snap() === before)
  ck('ready 的每一筆都有建議', plan.filter(p => p.status === 'ready').every(p => p.rows.every(x => x.reason === 'matched' && x.suggestion)))

  const ready = plan.filter(p => p.status === 'ready')
  ck('模擬的 4 支（含編號重複靠內容配）都是 ready', ids.slice(0, 4).every(id => ready.some(p => p.scriptId === id)),
    JSON.stringify(plan.filter(p => ids.slice(0, 4).includes(p.scriptId)).map(p => p.status)))
  ck('編號重複那支的配對理由寫「編號＋內容」', (plan.find(p => p.scriptId === ids[0])?.rows ?? []).every(x => x.note.includes('編號＋內容')))
  const review = plan.find(p => p.status === 'needs-review')
  if (ready.length >= 2) {
    // 第一支在預覽後被改過 → 要擋下
    ready.sort((x, y) => ids.indexOf(x.scriptId) - ids.indexOf(y.scriptId))
    const [a, b] = ready
    db.prepare('UPDATE frontend_auto_scripts SET updated_at = updated_at + 1 WHERE id=?').run(a.scriptId)
    const items = [a, b].map(p => ({ scriptId: p.scriptId, expectedUpdatedAt: p.updatedAt, expectedPlanKey: p.planKey }))
    if (review) items.push({ scriptId: review.scriptId, expectedUpdatedAt: review.updatedAt, expectedPlanKey: review.planKey })
    // 非管理員對 owner 不同的腳本（本機舊腳本 owner_email 都是空 → 改一支成別人的）
    const c = ready[2]
    if (c) { db.prepare("UPDATE frontend_auto_scripts SET owner_email='someone-else@x' WHERE id=?").run(c.scriptId); items.push({ scriptId: c.scriptId, expectedUpdatedAt: c.updatedAt, expectedPlanKey: c.planKey }) }
    const d = ready[3]
    if (d) items.push({ scriptId: d.scriptId, expectedUpdatedAt: d.updatedAt, expectedPlanKey: d.planKey.replace('rec', 'reX') })
    r = await call('/api/osm-uat/retarget/batch-apply', { newLarkUrl: NEW_URL, items }, 'brt_user')
    const res = Object.fromEntries((r[1]?.results ?? []).map(x => [x.scriptId, x]))
    ck('套用 200', r[0] === 200 && r[1]?.ok, JSON.stringify(r[1]).slice(0, 300))
    ck('預覽後被改過 → conflict、沒改', res[a.scriptId]?.status === 'conflict' && db.prepare('SELECT table_id FROM frontend_auto_scripts WHERE id=?').get(a.scriptId).table_id !== r[1].newTableId)
    ck('ready 的 → applied、表格與每筆綁定都換成新表、步驟歸屬跟著搬', res[b.scriptId]?.status === 'applied' && (() => {
      const row = db.prepare('SELECT table_id, bindings, steps FROM frontend_auto_scripts WHERE id=?').get(b.scriptId)
      const bs = JSON.parse(row.bindings), st = JSON.parse(row.steps)
      return row.table_id === r[1].newTableId && bs.every(x => x.tableId === r[1].newTableId)
        && st.every(x => bs.some(bd => bd.recordId === x.tcId)) && live.tcs.some(t => t.recordId === bs[0].recordId)
    })())
    if (review) ck('needs-review 的不套用', res[review.scriptId]?.status === 'needs-review')
    if (c) ck('別人的腳本（非管理員）→ forbidden', res[c.scriptId]?.status === 'forbidden')
    if (d) ck('預覽後配對變了（摘要不同）→ plan-changed、沒改', res[d.scriptId]?.status === 'plan-changed')
    ck('套用的有寫備份', db.prepare('SELECT COUNT(*) n FROM uat_tc_retarget_backups WHERE script_id=? AND created_at >= ?').get(b.scriptId, t0).n >= 1)
  } else {
    console.log('    （ready 少於 2 支，套用段跳過）')
  }
} finally {
  const cols = Object.keys(backup[0] ?? {})
  for (const row of backup) db.prepare(`UPDATE frontend_auto_scripts SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map(c => row[c]), row.id)
  const nb = db.prepare('DELETE FROM uat_tc_retarget_backups WHERE created_at >= ? AND script_id IN (' + ids.map(() => '?').join(',') + ')').run(t0, ...ids).changes
  db.prepare('DELETE FROM auth_sessions WHERE sid IN (?,?)').run(devSidHash('brt_admin'), devSidHash('brt_user'))
  srv.close()
  console.log(`  (還原 ${backup.length} 支腳本、刪 ${nb} 筆改綁備份)`)
}
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)
