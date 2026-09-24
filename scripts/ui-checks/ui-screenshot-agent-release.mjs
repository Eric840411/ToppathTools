/**
 * 驗「UI 截圖的 agent 要等收尾完成才釋放」——打**真的在跑的 server**，用一個假 agent 連 WS。
 *
 * 🚨 CodeX 2026-09-24：原本 `run_complete`／停止的當下就把 agent 標成空閒，
 *    而 agent 之後還要退出機台。這時馬上派下一個 run，**前一輪的退出會跟下一輪搶同一個座位**。
 *
 * 驗的是：
 *   A 完成之後、agent 還沒回報收尾 → 再開一個 run 要被擋
 *   B 回報收尾之後才放行
 *   C 舊 run 延遲／重複的回報，不能解鎖正在跑的新 run
 *   D 停止之後一樣要等收尾
 *   E 斷線重連時 agent 說自己還在收尾 → 維持忙碌
 *
 * ⚠️ 需要本機 server 在跑、worker 已吃到新代碼（pm2 restart）。
 * 用法：node scripts/ui-checks/ui-screenshot-agent-release.mjs
 */
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { createHash, randomBytes } from 'node:crypto'

const BASE = 'http://localhost:3000'
const db = new Database('server/data.db')
const failures = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(actual)}${ok ? '' : ` (預期 ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

const token = `tla_rel_${randomBytes(12).toString('hex')}`
const tokenId = `rel_${Date.now().toString(36)}`
const ownerKey = `rel-${randomBytes(3).toString('hex')}`
const agentId = `rel-probe_${process.pid}`
db.prepare(`INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, revoked, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)`)
  .run(tokenId, createHash('sha256').update(token).digest('hex'), ownerKey, 'rel', 'release probe', Date.now())

const runs = []
let ws = null
function connectAgent(uiScreenshotActive = null) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket('ws://localhost:3000/ws/agent')
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'agent_ready', agentId, hostname: 'release-probe', operatorKey: ownerKey, operatorName: 'rel',
        agentToken: token, capabilities: ['ui-screenshot'], uiScreenshotActive,
      }))
      setTimeout(resolve, 800)
    })
    ws.on('error', reject)
  })
}

const start = () => fetch(`${BASE}/api/ui-screenshot/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, gameUrlTemplate: 'about:blank', gmids: ['X'], resolutions: ['412x915'], options: {} }),
}).then(async r => {
  const d = await r.json()
  if (d.runId) runs.push(d.runId)
  return { status: r.status, runId: d.runId }
})
const post = (path, body) => fetch(`${BASE}/api/ui-screenshot${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(r => r.json())
/** 把這個 run 的每一張都回報完成 → 觸發 run_complete */
async function completeAll(runId) {
  for (const t of db.prepare('SELECT id FROM ui_screenshot_tasks WHERE run_id = ?').all(runId)) {
    await post(`/task/${t.id}/status`, { status: 'err', errorMsg: 'injected' })
  }
  await new Promise(r => setTimeout(r, 200))
}
const done = runId => post(`/run/${runId}/agent-done`, { agentId, seatUnresolved: [] })

try {
  await connectAgent()

  // ── A／B：完成 → 收尾前擋、收尾後放 ─────────────────────────────────────
  const a = await start()
  check('前置：第一個 run 派得出去', a.status, 200)
  await completeAll(a.runId)
  const statusA = db.prepare('SELECT status FROM ui_screenshot_runs WHERE id = ?').get(a.runId)?.status
  check('前置：結果已經完成（run_complete）', statusA, 'done')
  check('A 完成了但 agent 還沒回報收尾 → 新 run 要被擋', (await start()).status, 409)
  const relA = await done(a.runId)
  check('B 回報收尾 → 有釋放', relA.released, true)
  const b = await start()
  check('B 收尾之後才放行', b.status, 200)

  // ── C：舊 run 的回報不能解鎖新 run ───────────────────────────────────────
  const stale = await done(a.runId)
  check('C 舊 run 重複回報 → 不釋放', stale.released, false)
  check('C 新 run 還在跑 → 仍然擋', (await start()).status, 409)

  // ── D：停止之後一樣要等收尾 ─────────────────────────────────────────────
  await post(`/stop/${b.runId}`)
  check('D 停止了但還沒收尾 → 擋', (await start()).status, 409)
  check('D 回報收尾 → 釋放', (await done(b.runId)).released, true)
  const c = await start()
  check('D 收尾之後放行', c.status, 200)

  // ── E：斷線重連時還在收尾 ────────────────────────────────────────────────
  ws.close()
  await new Promise(r => setTimeout(r, 800))
  await connectAgent(c.runId)
  check('E 重連時說自己還在收尾 → 維持忙碌', (await start()).status, 409)
  check('E 收尾回報對得上 → 釋放', (await done(c.runId)).released, true)
  const d = await start()
  check('E 之後放行', d.status, 200)
  await done(d.runId)
} catch (err) {
  console.log(`FAIL  執行中斷：${err.message}`)
  failures.push(err.message)
} finally {
  try { ws?.close() } catch {}
  for (const id of runs) {
    db.prepare('DELETE FROM ui_screenshot_tasks WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM ui_screenshot_runs WHERE id = ?').run(id)
    db.prepare(`DELETE FROM operation_history WHERE feature = 'ui-screenshot' AND detail LIKE ?`).run(`%${id}%`)
  }
  db.prepare('DELETE FROM local_agent_tokens WHERE id = ?').run(tokenId)
  db.close()
}

console.log('')
if (failures.length) { console.log(`不通過——${failures.length} 條`); setTimeout(() => process.exit(1), 200) }
else { console.log('通過——agent 收尾完才釋放，舊回報解不了新 run 的鎖'); setTimeout(() => process.exit(0), 200) }
