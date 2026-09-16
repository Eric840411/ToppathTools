/**
 * 錄製腳本共用之後的授權：誰讀得到、誰刪得掉。
 *
 *   node scripts/ui-checks/recorded-script-authz.mjs      （需要本機 server 在跑）
 *
 * CodeX 要求在 A 放行前補上真正的授權實測，而不只是讀程式碼。
 * 用**隔離的測試帳號**走真正的 cookie，不碰正式使用者的 session。
 *
 * ⚠️ 會在 DB 建測試帳號、測試 session 與一份測試腳本，跑完全部刪掉。
 */
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const BASE = process.env.UAT_BASE || 'http://127.0.0.1:3000'
const db = new Database('server/data.db')
let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

const tag = randomUUID().slice(0, 8)
const alice = `__authz_a_${tag}@example.com`
const bob = `__authz_b_${tag}@example.com`
const admin = `__authz_admin_${tag}@example.com`
const sids = {}
const scriptId = '__authz_' + randomUUID()

const mkAccount = (email, role) => {
  db.prepare('INSERT OR REPLACE INTO jira_accounts (email, token, label, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(email, '', email.split('@')[0], role, 'active')
  const sid = randomUUID()
  db.prepare('INSERT INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sid, email, Date.now(), Date.now() + 60 * 60 * 1000)
  sids[email] = sid
  return sid
}
const as = (email, init = {}) => fetch(BASE + init.path, {
  ...init,
  headers: { ...(init.headers || {}), ...(email ? { Cookie: `toppath_auth=${sids[email]}` } : {}) },
})
const json = async (email, path, init = {}) => {
  const r = await as(email, { ...init, path })
  let body = null
  try { body = await r.json() } catch { /* 非 JSON */ }
  return { status: r.status, body }
}

try {
  mkAccount(alice, 'qa'); mkAccount(bob, 'qa'); mkAccount(admin, 'admin')
  const doc = { id: scriptId, title: '授權檢查 ' + tag, larkUrl: 'https://x/base/app?table=tbl', tableId: 'tbl', bindings: [], steps: [] }
  db.prepare('INSERT INTO uat_recorded_scripts(id, owner, title, document, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(scriptId, alice, doc.title, JSON.stringify(doc), Date.now(), alice)
  db.prepare('INSERT INTO uat_recorded_script_runs(id, script_id, owner, executed_by, script_revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), scriptId, alice, alice, 1, JSON.stringify({ results: [{ recordId: 'r1', outcome: 'pass' }] }), Date.now())

  // ── 未登入一律擋 ──
  eq('未登入讀清單 → 401', (await json(null, '/api/osm-uat/recorded-scripts')).status, 401)
  eq('未登入讀結果 → 401', (await json(null, `/api/osm-uat/recorded-scripts/${scriptId}/results`)).status, 401)
  eq('未登入刪除 → 401', (await json(null, `/api/osm-uat/recorded-scripts/${scriptId}`, { method: 'DELETE' })).status, 401)

  // ── 另一個登入者讀得到共用的腳本與結果 ──
  const listB = await json(bob, '/api/osm-uat/recorded-scripts')
  eq('B 讀清單 → 200', listB.status, 200)
  ok('B 看得到 A 建立的腳本（共用）',
    (listB.body?.scripts ?? []).some(s => s.id === scriptId))
  const mine = (listB.body?.scripts ?? []).find(s => s.id === scriptId)
  eq('而且看得出建立者是誰', mine?.createdBy, alice)

  const runsB = await json(bob, `/api/osm-uat/recorded-scripts/${scriptId}/results`)
  eq('B 讀得到 A 跑出來的結果（含截圖路徑）', runsB.status, 200)
  ok('結果內容真的拿得到', (runsB.body?.runs ?? []).length === 1, JSON.stringify(runsB.body?.runs?.length))
  eq('而且看得出是誰跑的', runsB.body?.runs?.[0]?.executedBy, alice)

  // ── 刪除：不是建立者也不是管理員 → 擋 ──
  const delB = await json(bob, `/api/osm-uat/recorded-scripts/${scriptId}`, { method: 'DELETE' })
  eq('B（非建立者、非管理員）刪除 → 403', delB.status, 403)
  ok('而且訊息說得出誰才能刪', /建立者|管理員/.test(delB.body?.message ?? ''), delB.body?.message)

  // ── 人工解鎖：只有管理員 ──
  const unlockB = await json(bob, `/api/osm-uat/recorded-scripts/${scriptId}/force-unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'x' }),
  })
  eq('B 人工解鎖 → 403（救援只給管理員）', unlockB.status, 403)
  const unlockA = await json(admin, `/api/osm-uat/recorded-scripts/${scriptId}/force-unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'x' }),
  })
  eq('管理員解一個沒有鎖的腳本 → 404（不是 403）', unlockA.status, 404)

  // ── 管理員刪得掉（建立者離職時的唯一出路）──
  const delAdmin = await json(admin, `/api/osm-uat/recorded-scripts/${scriptId}`, { method: 'DELETE' })
  eq('管理員刪除 → 200', delAdmin.status, 200)
  const listAfter = await json(bob, '/api/osm-uat/recorded-scripts')
  ok('刪除後清單看不到', !(listAfter.body?.scripts ?? []).some(s => s.id === scriptId))
  const runsAfter = await json(bob, `/api/osm-uat/recorded-scripts/${scriptId}/results`)
  ok('但歷史結果仍讀得到（軟刪除）', (runsAfter.body?.runs ?? []).length === 1)
} finally {
  db.prepare('DELETE FROM uat_recorded_script_runs WHERE script_id = ?').run(scriptId)
  db.prepare('DELETE FROM uat_recorded_scripts WHERE id = ?').run(scriptId)
  db.prepare('DELETE FROM uat_recorded_script_locks WHERE script_id = ?').run(scriptId)
  for (const email of [alice, bob, admin]) {
    db.prepare('DELETE FROM auth_sessions WHERE email = ?').run(email)
    db.prepare('DELETE FROM jira_accounts WHERE email = ?').run(email)
  }
  db.close()
  console.log('\n測試帳號、session 與腳本都已刪除')
}

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }
