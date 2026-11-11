/**
 * scripts/ui-checks/notify-backlog-reset-route.mjs（v5.81.26）
 * 打真的 router：清除告警積壓的權限與參數 —— 沒登入／非管理員 403、env 漏帶或拼錯 400、通知開著 409、關閉才 200。
 * 跑在本機 data.db：QAT 的四個通知設定先存後還原，現發的 session 結尾刪除。
 */
import path from 'path'; import { pathToFileURL, fileURLToPath } from 'url'; import Database from 'better-sqlite3'
import express from 'express'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const imp = p => import(pathToFileURL(path.join(root, p)).href)
const { mintDevSession, devSidHash } = await imp('scripts/ui-checks/lib/dev-session.mjs')
const mod = await imp('dist-server/server/routes/autospin.js')
const router = mod.default ?? mod.router
const db = new Database(path.join(root, 'server/data.db'))
const accts = db.prepare("SELECT email, role FROM jira_accounts").all()
const admin = accts.find(a => a.role === 'admin')?.email, user = accts.find(a => a.role !== 'admin')?.email
const sa = mintDevSession(db, admin) ?? (db.prepare('INSERT INTO auth_sessions (sid,email,created_at,expires_at) VALUES (?,?,?,?)').run(devSidHash('adm_chk'), admin, Date.now(), Date.now()+600000), { sid: 'adm_chk' })
const su = { sid: 'usr_chk' }; db.prepare('INSERT INTO auth_sessions (sid,email,created_at,expires_at) VALUES (?,?,?,?)').run(devSidHash('usr_chk'), user, Date.now(), Date.now()+600000)
const keys = ['notifyEnabled','notifyWatermarkTs','notifyBacklogResetTs','notifyBacklogResetSkipped']
const bak = keys.map(k => [k, db.prepare("SELECT value FROM recon_settings WHERE env='qat' AND key=?").get(k)?.value ?? null])
const set = (k,v) => db.prepare("INSERT INTO recon_settings (env,key,value) VALUES ('qat',?,?) ON CONFLICT(env,key) DO UPDATE SET value=excluded.value").run(k,String(v))
const app = express(); app.use(express.json()); app.use(router)
const srv = app.listen(0); const port = srv.address().port
const call = async (q, sid) => { const r = await fetch(`http://127.0.0.1:${port}/api/autospin/live-ledger/notify-backlog-reset${q}`, { method: 'POST', headers: sid ? { cookie: `toppath_auth=${sid}` } : {} }); return [r.status, await r.json().catch(() => null)] }
let fail = 0; const ck = (n, ok, x) => { console.log((ok?'  PASS  ':'  FAIL  ')+n+'  '+JSON.stringify(x)); if (!ok) fail++ }
try {
  set('notifyEnabled', 1)
  let r = await call('?env=qat'); ck('沒登入 → 403', r[0] === 403, r[0])
  r = await call('?env=qat', su.sid); ck('非管理員 → 403', r[0] === 403, r[0])
  r = await call('', sa.sid); ck('管理員沒帶 env → 400', r[0] === 400, r)
  r = await call('?env=QAT', sa.sid); ck('管理員 env 拼錯 → 400', r[0] === 400, r[0])
  r = await call('?env=qat', sa.sid); ck('通知開著 → 409', r[0] === 409, r)
  set('notifyEnabled', 0)
  r = await call('?env=qat', sa.sid); ck('通知關閉 → 200 且回 skipped', r[0] === 200 && r[1].ok && typeof r[1].skipped === 'number', r)
} finally {
  for (const [k, v] of bak) v === null ? db.prepare("DELETE FROM recon_settings WHERE env='qat' AND key=?").run(k) : set(k, v)
  db.prepare('DELETE FROM auth_sessions WHERE sid IN (?,?,?)').run(devSidHash(sa.sid), devSidHash('usr_chk'), devSidHash('adm_chk'))
  srv.close()
}
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)
