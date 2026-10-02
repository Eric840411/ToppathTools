/**
 * 移除 Jira（v4.281～v5.0.0）上線驗證：打真的伺服器，不經過畫面。
 * 會建一個暫時帳號（verify-jira-removal@toppath.tw）驗完就刪。跑法：node scripts/ui-checks/jira-removal-live-check.mjs
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'

const H = 'http://192.168.3.41:3000'
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const ck = { Cookie: `toppath_auth=${sid}` }
const json = { 'Content-Type': 'application/json' }
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const req = async (method, path, body, headers = {}) => { const r = await fetch(H + path, { method, headers: { ...json, ...ck, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json() } catch { /* 非 JSON */ } return { status: r.status, j } }

console.log('== 帳號')
const a1 = await req('GET', '/api/accounts'), a0 = await req('GET', '/api/jira/accounts')
check('新路徑 /api/accounts 可用', a1.status === 200 && a1.j?.ok && a1.j.accounts.length > 0, `${a1.j?.accounts?.length} 個`)
check('舊路徑 /api/jira/accounts 仍可用（同一個 handler）', a0.status === 200 && a0.j?.accounts?.length === a1.j?.accounts?.length)
const T = 'verify-jira-removal@toppath.tw'
db.prepare('SELECT 1').get()
const add = await req('POST', '/api/accounts', { email: T, label: '驗證用-請忽略', role: 'qa', pin: '9999' }, { Cookie: '' })
check('自助新增帳號不用 Jira Token', add.status === 200 && add.j?.ok, JSON.stringify(add.j))
const pinBefore = new Database('server/data.db', { readonly: true }).prepare('SELECT pin_hash FROM jira_accounts WHERE email=?').get(T)?.pin_hash
check('新帳號有 PIN', !!pinBefore)
const upd = await req('PUT', `/api/admin/accounts/${encodeURIComponent(T)}`, { label: '驗證用-改名', role: 'pm' })
const row = new Database('server/data.db', { readonly: true }).prepare('SELECT label, role, pin_hash FROM jira_accounts WHERE email=?').get(T)
check('管理員改名／角色：成功', upd.status === 200 && row?.label === '驗證用-改名' && row?.role === 'pm', JSON.stringify(upd.j))
check('管理員改帳號後 PIN 還在（INSERT OR REPLACE bug 已修）', row?.pin_hash === pinBefore)
const del = await req('DELETE', `/api/admin/accounts/${encodeURIComponent(T)}`)
check('清掉暫時帳號', del.status === 200 && !new Database('server/data.db', { readonly: true }).prepare('SELECT 1 FROM jira_accounts WHERE email=?').get(T), String(del.status))

console.log('== 附件（新舊路徑）')
for (const p of ['/api/attachments/upload', '/api/jira/attachment-upload']) {
  const fd = new FormData(); fd.append('file', new Blob([readFileSync('bf-result-xianxia.png')], { type: 'image/png' }), 'v.png')
  const r = await fetch(H + p, { method: 'POST', headers: ck, body: fd }); const j = await r.json()
  check(`上傳 ${p}`, j.ok && !!j.cacheId)
  if (j.cacheId) {
    const g = await fetch(`${H}/api/attachments/cache/${j.cacheId}`, { headers: ck })
    check(`  讀快取（新路徑）`, g.status === 200 && (await g.arrayBuffer()).byteLength > 1000)
    const d = await req('DELETE', `/api/jira/attachment-cache/${j.cacheId}`)
    check('  刪快取（舊路徑）', d.status === 200)
  }
}
const lease = await req('POST', '/api/attachments/cache/lease', { cacheIds: [] })
check('租約（新路徑）', lease.j?.ok && !!lease.j.leaseId)

console.log('== 讀 Sheet')
const sh = await req('POST', '/api/lark/sheets/records', { sheetUrl: 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf', includeCreated: true })
check('/api/lark/sheets/records（搬到 sheets.ts）', sh.status === 200 && sh.j?.records?.length > 0, `${sh.j?.records?.length} 列`)

console.log('== Jira API 已刪')
const jb = await req('POST', '/api/jira/batch-create', {})
check('/api/jira/batch-create 不存在了', jb.status === 404, String(jb.status))

console.log('== TestCase 參考單')
const base = { sources: [{ type: 'lark', url: 'https://x.larksuite.com/wiki/AbCdEf123456' }] }
const t1 = await req('POST', '/api/integrations/lark/generate-testcases', { ...base, jiraKeys: ['CGSG-220'] })
check('送 Jira keys → 擋下並告知改填 Meegle', t1.status === 400 && /Jira 已停用/.test(t1.j?.message ?? ''), t1.j?.message)
const t2 = await req('POST', '/api/integrations/lark/generate-testcases', { ...base, meegleRefs: 'CGSG-220' })
check('Meegle 欄填 Jira key → 擋下並列出', t2.status === 400 && /看不懂的單號：CGSG-220/.test(t2.j?.message ?? ''), t2.j?.message)
const t3 = await req('POST', '/api/integrations/lark/generate-testcases', { ...base, meegleRefs: '99999999' })
check('讀不到的單號 → 擋下並講是哪張（真的去 Meegle 讀了）', t3.status === 400 && /#99999999/.test(t3.j?.message ?? ''), t3.j?.message)

console.log('== 週報撈 Meegle')
const w = await req('POST', '/api/weekly-report/meegle-by-range', { startDate: '2026-09-25', endDate: '2026-10-01', email: 'eric.wu@toppath.tw' })
check('撈 Eric 9/25～10/1', w.j?.ok && w.j.issues.length === 5, `${w.j?.issues?.length} 張：${(w.j?.issues ?? []).map(i => `${i.key}[${i.jiraProjectName}]`).join(' ')}`)
check('補查舊週帶提醒', /只看最後一次更新/.test(w.j?.note ?? ''))
const wn = await req('POST', '/api/weekly-report/meegle-by-range', { startDate: '2026-09-25', endDate: '2026-10-01', email: 'nobody-x@toppath.tw' })
check('對不到人 → 明示，不回空清單', wn.j?.ok === false && /查不到|對到/.test(wn.j?.message ?? ''), wn.j?.message)
const wj = await req('POST', '/api/weekly-report/jira-by-range', { startDate: '2026-09-25', endDate: '2026-10-01' })
check('舊 jira-by-range 已刪', wj.status === 404, String(wj.status))

console.log(fail ? `❌ ${fail} 項失敗` : '✅ 全部通過')
process.exit(fail ? 1 : 0)
