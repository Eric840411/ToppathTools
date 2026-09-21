/**
 * 走**正式的執行路徑**跑一份 UAT 腳本（伺服器端模式），並把日誌即時印出來。
 *
 *   SCRIPT_NAME='<腳本名>' H5_URL='<目標網址>' node scripts/ui-checks/run-official-uat.mjs
 *
 * ⚠️ 跟 `run-stored-script.mjs` 的差別就是這個：**這支會回寫 Lark**（綁了 TC 的腳本）。
 *    所以只在使用者明確要求時跑——驗「腳本跑不跑得動」請用那一支，不要在人家的 TC 表上留紀錄。
 *
 * ⚠️ `agentId: 'server'` 是明確指定「跑在伺服器本機」。不指定的話會自動挑 agent，
 *    挑不到才退回本機——同一顆按鈕可能跑在不同機器上，log 看起來一模一樣。
 */
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const NAME = process.env.SCRIPT_NAME ?? ''
const URL_TARGET = process.env.H5_URL ?? ''
const PLATFORM = process.env.PLATFORM ?? 'h5'
const RESOLUTION = process.env.RESOLUTION ?? (PLATFORM === 'h5' ? '500x877' : '1280x800')
const BASE = 'http://localhost:3000'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
const HEADERS = { 'content-type': 'application/json', cookie: `toppath_auth=${sess.sid}` }

const scripts = await fetch(`${BASE}/api/frontend-auto/scripts?platform=${PLATFORM}`, { headers: HEADERS })
  .then(r => r.json()).then(r => r.scripts ?? [])
const row = scripts.find(s => s.name === NAME)
if (!row) { console.log('找不到腳本：' + NAME); process.exit(1) }
const steps = JSON.parse(row.steps)
const bindings = JSON.parse(row.bindings || '[]')
console.log(`▶ ${row.name}｜${steps.length} 顆｜綁 ${bindings.length} 筆 TC｜回寫 ${row.lark_url ? '有' : '無'}`)

const run = await fetch(`${BASE}/api/frontend-auto/runs`, {
  method: 'POST', headers: HEADERS,
  body: JSON.stringify({ platform: PLATFORM, scriptId: row.id, scriptName: row.name, ranBy: 'claude', totalSteps: steps.length }),
}).then(r => r.json())
if (!run.ok) { console.log('建立 run 失敗：', JSON.stringify(run).slice(0, 200)); process.exit(1) }
const runId = run.run.id
console.log('runId =', runId)

// 先接上日誌串流，再送執行——反過來的話開頭那幾行會漏掉
const sse = await fetch(`${BASE}/api/frontend-auto/log-stream/${runId}`, { headers: HEADERS })
const reader = sse.body.getReader()
const decoder = new TextDecoder()
let done = false
const pump = (async () => {
  let buf = ''
  while (!done) {
    const { value, done: end } = await reader.read()
    if (end) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const msg = JSON.parse(payload)
        const text = typeof msg === 'string' ? msg : (msg.line ?? msg.message ?? JSON.stringify(msg))
        console.log('   ' + String(text).slice(0, 300))
      } catch { console.log('   ' + payload.slice(0, 300)) }
    }
  }
})()

const exec = await fetch(`${BASE}/api/frontend-auto/runs/${runId}/execute`, {
  method: 'POST', headers: HEADERS,
  body: JSON.stringify({
    steps: JSON.stringify(steps), url: URL_TARGET, platform: PLATFORM,
    resolution: RESOLUTION, failureMode: 'continue', agentId: 'server',
    // ⚠️ PC（Cocos）在 headless 下點不進機台（實測：同一份腳本 headed 進得去、headless 停在大廳）
    headed: process.env.HEADED === '1',
  }),
}).then(r => r.json())
console.log('execute →', JSON.stringify(exec).slice(0, 200))
if (!exec.ok) { done = true; process.exit(1) }

// 等 run 結束（finished_at 有值）
const started = Date.now()
let finished = null
while (Date.now() - started < 15 * 60_000) {
  await new Promise(r => setTimeout(r, 4000))
  const r = await fetch(`${BASE}/api/frontend-auto/runs/${runId}`, { headers: HEADERS }).then(r => r.json())
  if (r.run?.finished_at) { finished = r.run; break }
}
done = true
await Promise.race([pump, new Promise(r => setTimeout(r, 1000))])
if (!finished) { console.log('❌ 逾時（15 分鐘）還沒結束'); process.exit(1) }
console.log(`\n${finished.failed > 0 ? '❌' : '✅'} 結果 ${finished.result}｜通過 ${finished.passed}／失敗 ${finished.failed}／跳過 ${finished.skipped}`)
process.exit(finished.failed > 0 ? 1 : 0)
