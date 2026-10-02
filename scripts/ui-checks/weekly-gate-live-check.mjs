/**
 * 週報 API 後端關卡（v5.1.1，CodeX review 2afdaeb [P1]）上線驗證：打真的伺服器。
 * 建一個暫時帳號（verify-weekly-gate@toppath.tw，qa 角色＝本機預設沒有週報權限），直接塞一筆登入 session，
 * 依序驗：沒登入／沒權限／給權限／停權。驗完刪帳號與 session。跑法：node scripts/ui-checks/weekly-gate-live-check.mjs
 * ⚠️ 打 batch-submit 時 body 故意不合格式——關卡失效的話會回 400（格式錯），不會真的寫進 Lark。
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'

const H = 'http://192.168.3.41:3000'
const db = new Database('server/data.db')
const { sid: adminSid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const T = 'verify-weekly-gate@toppath.tw'
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const req = async (method, path, body, sid) => {
  const r = await fetch(H + path, { method, headers: { 'Content-Type': 'application/json', ...(sid ? { Cookie: `toppath_auth=${sid}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j = null; try { j = await r.json() } catch { /* 非 JSON */ } return { status: r.status, j }
}
const ENDPOINTS = [['POST', '/api/weekly-report/batch-submit', { bad: 1 }], ['GET', '/api/weekly-report/week-range'], ['GET', '/api/weekly-report/reminder'], ['POST', '/api/weekly-report/reminder/test', {}]]

const sid = randomBytes(24).toString('hex')
try {
  await req('POST', '/api/accounts', { email: T, label: '驗證用-請忽略', role: 'qa', pin: '9999' })
  db.prepare('INSERT INTO auth_sessions (sid, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, T, Date.now(), Date.now() + 3600_000)

  console.log('== 沒登入')
  for (const [m, p, b] of ENDPOINTS) { const r = await req(m, p, b); check(`${m} ${p} → 401`, r.status === 401, String(r.status)) }

  console.log('== 登入但沒週報權限（qa 預設沒有）')
  for (const [m, p, b] of ENDPOINTS) { const r = await req(m, p, b, sid); check(`${m} ${p} → 403`, r.status === 403 && /權限/.test(r.j?.message ?? ''), `${r.status} ${r.j?.message ?? ''}`) }

  console.log('== 管理員給他週報權限')
  const g = await req('PUT', `/api/admin/accounts/${encodeURIComponent(T)}/permissions`, { overrides: { 'weekly-report': true } }, adminSid)
  check('給權限', g.status === 200, JSON.stringify(g.j))
  const ok1 = await req('GET', '/api/weekly-report/week-range', undefined, sid)
  check('有權限 → 過關（week-range 200）', ok1.status === 200, String(ok1.status))
  const ok2 = await req('POST', '/api/weekly-report/batch-submit', { bad: 1 }, sid)
  check('有權限 → batch-submit 進到 handler（格式錯，不是 401/403）', ok2.status !== 401 && ok2.status !== 403, `${ok2.status} ${ok2.j?.message?.slice(0, 40) ?? ''}`)

  console.log('== 停權（權限還在）')
  const d = await req('PUT', `/api/admin/accounts/${encodeURIComponent(T)}`, { status: 'disabled' }, adminSid)
  check('停權', d.status === 200, JSON.stringify(d.j))
  for (const [m, p, b] of ENDPOINTS) { const r = await req(m, p, b, sid); check(`停權 ${m} ${p} → 403`, r.status === 403 && /停權/.test(r.j?.message ?? ''), `${r.status} ${r.j?.message ?? ''}`) }

  console.log('== 管理員自己照常可用')
  const a = await req('GET', '/api/weekly-report/reminder', undefined, adminSid)
  check('管理員 reminder 200', a.status === 200)
} finally {
  db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid)
  db.prepare('DELETE FROM account_permissions WHERE email = ?').run(T)
  const del = await req('DELETE', `/api/admin/accounts/${encodeURIComponent(T)}`, undefined, adminSid)
  check('清掉暫時帳號', del.status === 200 && !db.prepare('SELECT 1 FROM jira_accounts WHERE email=?').get(T), String(del.status))
}
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)
