/**
 * Lark 通知（v5.1.0）上線驗證：打真的伺服器，不經過畫面。
 * 會用 ~/.claude/channels/lark/.env 的 OSM QA 憑證存進設定（使用者指定用這隻），試發到 OSM 的秘密群，
 * 暫時把各功能出口切成 Lark 試發一輪，**結束時還原成原本的出口設定**。
 * 跑法：node scripts/ui-checks/lark-notify-live-check.mjs
 * ⚠️ 不印 Secret；最後會檢查 Secret 沒出現在任何 API 回應、設定表明文、server log 裡。
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const H = 'http://192.168.3.41:3000'
const CHAT = 'oc_8f0b93e81709a99ec176fb8784dd7c7f'
const env = Object.fromEntries(readFileSync(join(homedir(), '.claude/channels/lark/.env'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const APP_ID = env.LARK_APP_ID, SECRET = env.LARK_APP_SECRET
const db = new Database('server/data.db')
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email='eric.wu@toppath.tw' AND expires_at>? ORDER BY created_at DESC").get(Date.now())
const ck = { Cookie: `toppath_auth=${sid}` }
let fail = 0
const seen = []
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }
const req = async (method, path, body, headers = ck) => {
  const r = await fetch(H + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); seen.push(text)
  let j = null; try { j = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, j }
}

console.log('== 權限（後端擋）')
for (const [m, p] of [['GET', '/api/lark-notify/config'], ['PUT', '/api/lark-notify/config'], ['POST', '/api/lark-notify/verify'], ['GET', '/api/lark-notify/chats'], ['POST', '/api/lark-notify/test'], ['GET', '/api/lark-notify/mentions']]) {
  const r = await req(m, p, m === 'GET' ? undefined : {}, { Cookie: '' })
  check(`沒登入 ${m} ${p} → 403`, r.status === 403)
}

console.log('== 設定')
const before = await req('GET', '/api/lark-notify/config')
check('讀設定', before.j?.ok, JSON.stringify({ ...before.j?.config }))
const origOutlets = before.j.outlets
const bad = await req('POST', '/api/lark-notify/verify', { appId: APP_ID, secret: 'definitely-wrong' })
check('錯的 Secret → 驗證失敗', bad.j?.ok === false && bad.j.code === 'BAD_CREDENTIALS', bad.j?.message)
const good = await req('POST', '/api/lark-notify/verify', { appId: APP_ID, secret: SECRET })
check('對的 Secret（未存）→ 驗證通過', good.j?.ok === true, good.j?.message)
const badUrl = await req('PUT', '/api/lark-notify/config', { toolUrl: 'javascript:alert(1)' })
check('工具網址不是 http(s) → 擋下', badUrl.status === 400)
const saved = await req('PUT', '/api/lark-notify/config', { appId: APP_ID, secret: SECRET, chatId: CHAT, toolUrl: 'http://192.168.3.41:3000' })
check('儲存', saved.j?.ok && saved.j.config.hasSecret && saved.j.config.secretTail === SECRET.slice(-4), `尾碼 ${saved.j?.config?.secretTail}`)
const keep = await req('PUT', '/api/lark-notify/config', { appId: APP_ID, secret: '' })
check('Secret 留空 → 保留原值', keep.j?.config?.secretTail === SECRET.slice(-4))
const enc = db.prepare("SELECT value FROM settings WHERE key='lark_notify_secret_enc'").get()?.value ?? ''
check('設定表裡是密文、不是明文', !!enc && !enc.includes(SECRET))
const cfg = await req('GET', '/api/lark-notify/config')
check('機器人名稱', !!cfg.j?.botName, cfg.j?.botName)

console.log('== 群組／試發／@人')
const chats = await req('GET', '/api/lark-notify/chats')
check('列出機器人所在的群', chats.j?.ok && chats.j.chats.some(c => c.chatId === CHAT), chats.j?.chats?.map(c => c.name).join('、'))
const t1 = await req('POST', '/api/lark-notify/test', { chatId: CHAT })
check('試發到 OSM 的秘密', t1.j?.ok === true, t1.j?.message)
const t2 = await req('POST', '/api/lark-notify/test', { chatId: 'oc_not_exist_000' })
check('試發到不存在的群 → 回失敗訊息（不是假成功）', t2.j?.ok === false, t2.j?.message)
const men = await req('GET', '/api/lark-notify/mentions')
check('@人對照：沒有 contact 權限時明講缺少權限', men.j?.ok && men.j.noPermission === true && men.j.rows.length > 0, `${men.j?.rows?.length} 個帳號`)

console.log('== 各功能走 Lark（暫時切換，結束還原）')
const sw = await req('PUT', '/api/lark-notify/config', { outlets: { autospin: 'lark', 'live-ledger': 'lark', 'weekly-reminder': 'lark' } })
check('出口切成 Lark', sw.j?.outlets?.autospin === 'lark')
try {
  const a = await req('POST', '/api/autospin/status-report-test', {})
  check('AutoSpin 彙總報告試發 → Lark', a.j?.ok === true, a.j?.message ?? '')
  const ll = await req('POST', '/api/autospin/live-ledger/notify-test', {})
  check('Live Ledger 試發 → Lark', ll.j?.ok === true, ll.j?.message ?? `status ${ll.status}`)
  const w = await req('POST', '/api/weekly-report/reminder/test', {})
  check('週報提醒試發 → Lark（卡片帶連結）', w.j?.ok === true && /Lark 已送出/.test(w.j.message) && !/Discord/.test(w.j.message), w.j?.message)
} finally {
  const back = await req('PUT', '/api/lark-notify/config', { outlets: origOutlets })
  check('出口還原', JSON.stringify(back.j?.outlets) === JSON.stringify(origOutlets), JSON.stringify(back.j?.outlets))
}

console.log('== Secret 沒外流')
check('所有 API 回應都沒有 Secret', !seen.some(t => t.includes(SECRET)))
let logs = ''
for (const f of ['toppath-server-out', 'toppath-server-error', 'toppath-worker-out', 'toppath-worker-error']) { try { logs += readFileSync(join(homedir(), `.pm2/logs/${f}.log`), 'utf8').slice(-2_000_000) } catch { /* 沒有就算了 */ } }
check('server／worker log 沒有 Secret', !!logs && !logs.includes(SECRET))
const hist = db.prepare("SELECT detail FROM operation_history WHERE feature='lark-notify' ORDER BY created_at DESC LIMIT 20").all()
check('歷史紀錄有記、但沒有 Secret', hist.length > 0 && !hist.some(h => h.detail.includes(SECRET)), `${hist.length} 筆`)

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)
