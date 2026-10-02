/**
 * 驗 UI 截圖的 Machine Model 白名單——打**真的在跑的 server**（worker），用假 agent 連 WS。
 *
 * CodeX 2026-10-02 指定的驗收重點（伺服器這端能驗的部分）：
 *   A 舊 agent（沒回報 ui-ss-pool）＋帶白名單 → 409，不能退回不限 Machine Model
 *   B 新 agent ＋白名單 → 派下去的每個 task 都帶同一份 allowedGmids（各解析度共用）
 *   C 空白名單、PC 版、非自動選機 → 擋
 *   D 重連時降版（capabilities 沒有 ui-ss-pool）→ 再派白名單要被擋
 *   E 兩個任務名稱的資料夾撞名 → 擋
 *   F 白名單快照存在 run 的 options.targetPools
 * ⚠️「池內全忙但池外有空機」「重載跑錯台」是 agent 端的挑機行為，要真 agent 對真大廳驗，這支驗不到。
 *
 * 用法：node scripts/ui-checks/ui-screenshot-machine-model.mjs（本機 server 在跑、worker 已 pm2 restart）
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

const token = `tla_mm_${randomBytes(12).toString('hex')}`
const tokenId = `mm_${Date.now().toString(36)}`
const ownerKey = `mm-${randomBytes(3).toString('hex')}`
const agentId = `mm-probe_${process.pid}`
db.prepare(`INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, revoked, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)`)
  .run(tokenId, createHash('sha256').update(token).digest('hex'), ownerKey, 'mm', 'machine model probe', Date.now())

const runs = []
const dispatched = []
let ws = null
function connectAgent(capabilities) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket('ws://localhost:3000/ws/agent')
    ws.on('message', raw => {
      const m = JSON.parse(String(raw))
      if (m.type === 'ui_screenshot_start') dispatched.push(m)
    })
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'agent_ready', agentId, hostname: 'mm-probe', operatorKey: ownerKey, operatorName: 'mm', agentToken: token, capabilities }))
      setTimeout(resolve, 800)
    })
    ws.on('error', reject)
  })
}
const disconnect = () => new Promise(r => { ws.once('close', () => setTimeout(r, 500)); ws.close() })

const T9 = 'WLZBHELIX / 5 Dragons Gold / wlzbhelix9'
const T10 = 'WLZBHELIX / 5 Dragons Gold / wlzbhelix10'
const POOLS = { [T9]: ['4182-WLZBHELIX-2133', '4182-wlzbhelix-2134'], [T10]: ['4182-WLZBHELIX-2136'] }
const start = (extra = {}) => fetch(`${BASE}/api/ui-screenshot/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, gameUrlTemplate: 'about:blank', gmids: [T9, T10], resolutions: ['412x915', '1920x1080'], clientType: 'h5', options: { autoPickByGame: true }, pools: POOLS, ...extra }),
}).then(async r => { const d = await r.json(); if (d.runId) runs.push(d.runId); return { status: r.status, code: d.code, runId: d.runId, message: d.message } })
const finishRun = async (runId) => {
  for (const t of db.prepare('SELECT id FROM ui_screenshot_tasks WHERE run_id = ?').all(runId)) {
    await fetch(`${BASE}/api/ui-screenshot/task/${t.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'err', errorMsg: 'probe' }) })
  }
  await fetch(`${BASE}/api/ui-screenshot/run/${runId}/agent-done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, seatUnresolved: [] }) })
  await new Promise(r => setTimeout(r, 300))
}

try {
  // A 舊 agent
  await connectAgent(['ui-screenshot'])
  const a = await start()
  if (a.status !== 409) console.log('A message:', a.message)
  check('A 舊 agent＋白名單 → 409 AGENT_TOO_OLD', [a.status, a.code], [409, 'AGENT_TOO_OLD'])
  check('A 沒有建 run、沒有派工', [a.runId ?? null, dispatched.length], [null, 0])
  await disconnect()

  // B 新 agent
  await connectAgent(['ui-screenshot', 'ui-ss-pool'])
  const b = await start()
  check('B 新 agent＋白名單 → 建立', b.status, 200)
  await new Promise(r => setTimeout(r, 400))
  const tasks = dispatched.at(-1)?.run?.tasks ?? []
  check('B 2 個 Machine Model × 2 解析度 = 4 個任務', tasks.length, 4)
  check('B wlzbhelix9 兩個解析度帶同一份白名單（大寫）', tasks.filter(t => t.gmid === T9).map(t => t.allowedGmids), [['4182-WLZBHELIX-2133', '4182-WLZBHELIX-2134'], ['4182-WLZBHELIX-2133', '4182-WLZBHELIX-2134']])
  check('B wlzbhelix10 不會拿到 wlzbhelix9 的機台', tasks.filter(t => t.gmid === T10).every(t => JSON.stringify(t.allowedGmids) === JSON.stringify(['4182-WLZBHELIX-2136'])), true)
  // F 快照
  const opts = JSON.parse(db.prepare('SELECT options FROM ui_screenshot_runs WHERE id = ?').get(b.runId).options)
  check('F 白名單快照存在 run 的 options.targetPools', Object.keys(opts.targetPools ?? {}).sort(), [T10, T9])
  await finishRun(b.runId)

  // C 各種擋
  check('C 空白名單 → 400', (await start({ pools: { [T9]: [], [T10]: ['4182-WLZBHELIX-2136'] } })).status, 400)
  check('C PC 版 → 400', (await start({ clientType: 'pc' })).status, 400)
  check('C 非自動選機 → 400', (await start({ options: {} })).status, 400)
  check('C 白名單有非 gmid 值 → 400', (await start({ pools: { [T9]: ['WLZBHELIX'], [T10]: ['4182-WLZBHELIX-2136'] } })).status, 400)
  // G 三段任務漏帶白名單（CodeX review d3082af [P2]）
  check('G 三段任務、完全沒帶 pools → 400', (await start({ pools: undefined })).status, 400)
  check('G 三段任務、pools 是 {} → 400', (await start({ pools: {} })).status, 400)
  check('G 兩個三段任務只帶一組 → 400', (await start({ pools: { [T9]: POOLS[T9] } })).status, 400)
  // E 資料夾撞名（safeSegment 會把 : 換成 _）
  const e = await start({ gmids: ['G / A:B / x1', 'G / A_B / x1'], pools: { 'G / A:B / x1': ['1-G-1'], 'G / A_B / x1': ['1-G-2'] } })
  check('E 兩個名稱資料夾相同 → 400', e.status, 400)
  check('C/E 被擋的都沒有建 run', runs.length, 1)
  await disconnect()

  // D 重連降版
  await connectAgent(['ui-screenshot'])
  const d = await start()
  check('D 重連後降版 → 409（capabilities 跟著這次連線）', [d.status, d.code], [409, 'AGENT_TOO_OLD'])
  await disconnect()
} finally {
  for (const id of runs) {
    db.prepare('DELETE FROM ui_screenshot_tasks WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM ui_screenshot_runs WHERE id = ?').run(id)
    db.prepare(`DELETE FROM operation_history WHERE feature = 'ui-screenshot' AND detail LIKE ?`).run(`%${id}%`)
  }
  db.prepare('DELETE FROM local_agent_tokens WHERE id = ?').run(tokenId)
  try { ws?.close() } catch {}
}
if (failures.length) { console.log(`不通過——${failures.length} 條`); setTimeout(() => process.exit(1), 200) }
else { console.log('通過——Machine Model 白名單的伺服器關卡都擋得住'); setTimeout(() => process.exit(0), 200) }
