/**
 * 驗「agent 收尾的警告在完成／停止之後還送得到網頁」。
 *
 * 🚨 CodeX 2026-09-24 抓到：v4.259.0 我說「退出失敗會寫進網頁執行日誌」，但伺服器在
 *    `run_complete` 那一刻就把 SSE 訂閱清掉了——而 agent 是在最後一張回報**之後**才退出機台，
 *    所以警告送出去時**沒有人收**。我只改了前端不關連線，沒查伺服器那端。
 *
 * 做法：打**真的在跑的 server**（不是繞過 Express 的腳本），造一個假 run，
 *       開 SSE → 觸發完成／停止 → 再送 agent log → 看 SSE 收不收得到。
 *
 * ⚠️ 需要本機 server 在跑（http://localhost:3000）、而且 worker 已經吃到新代碼（pm2 restart）。
 * 用法：node scripts/ui-checks/ui-screenshot-agent-log.mjs
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const BASE = 'http://localhost:3000'
const db = new Database('server/data.db')
const failures = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(actual)}${ok ? '' : ` (預期 ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

function fakeRun(nTasks) {
  const runId = `e2e-log-${randomUUID()}`
  const now = Date.now()
  db.prepare(`INSERT INTO ui_screenshot_runs (id, status, gmids, resolutions, created_at, started_at) VALUES (?, 'running', '["X"]', '["412x915"]', ?, ?)`)
    .run(runId, now, now)
  const taskIds = []
  for (let i = 0; i < nTasks; i++) {
    const id = randomUUID()
    taskIds.push(id)
    db.prepare(`INSERT INTO ui_screenshot_tasks (id, run_id, gmid, resolution, status) VALUES (?, ?, 'X', ?, 'running')`)
      .run(id, runId, `${400 + i}x900`)
  }
  return { runId, taskIds }
}

/** 開 SSE，把收到的事件收集起來 */
async function openSse(runId) {
  const ctrl = new AbortController()
  const events = []
  const resp = await fetch(`${BASE}/api/ui-screenshot/events/${runId}`, { signal: ctrl.signal })
  ;(async () => {
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)))
        }
      }
    } catch { /* abort */ }
  })()
  await new Promise(r => setTimeout(r, 300))
  return { events, close: () => ctrl.abort() }
}

const post = (path, body) => fetch(`${BASE}/api/ui-screenshot${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(r => r.json())

const created = []
try {
  // ── A. 完成之後才送的警告 ────────────────────────────────────────────────
  {
    const { runId, taskIds } = fakeRun(1); created.push(runId)
    const sse = await openSse(runId)
    await post(`/task/${taskIds[0]}/status`, { status: 'err', errorMsg: 'injected' })
    await new Promise(r => setTimeout(r, 300))
    await post(`/run/${runId}/log`, { level: 'warn', message: '注入：拍完退出機台失敗' })
    await new Promise(r => setTimeout(r, 500))
    sse.close()
    const types = sse.events.map(e => e.type)
    check('A 有收到 run_complete', types.includes('run_complete'), true)
    check('A 完成之後才送的 agent_log 收得到', types.includes('agent_log'), true)
    check('A 順序是先完成、後警告', types.indexOf('agent_log') > types.indexOf('run_complete'), true)
  }

  // ── B. 按停止之後才送的警告 ──────────────────────────────────────────────
  {
    const { runId } = fakeRun(2); created.push(runId)
    const sse = await openSse(runId)
    await post(`/stop/${runId}`)
    await new Promise(r => setTimeout(r, 300))
    await post(`/run/${runId}/log`, { level: 'warn', message: '注入：停止後收尾時無法確認座位' })
    await new Promise(r => setTimeout(r, 500))
    sse.close()
    const types = sse.events.map(e => e.type)
    check('B 有收到 run_stopped', types.includes('run_stopped'), true)
    check('B 停止之後才送的 agent_log 收得到', types.includes('agent_log'), true)
  }

  // ── C. 前端不能在完成／停止時自己關連線 ─────────────────────────────────
  // ⚠️ 這條是**讀原始碼的結構檢查**，不是行為檢查
  {
    const src = readFileSync('src/pages/UiScreenshotPage.tsx', 'utf8')
    const onMsg = src.slice(src.indexOf("data.type === 'run_complete'"), src.indexOf('es.onerror'))
    const stopFn = src.slice(src.indexOf('async function stop()'), src.indexOf('async function writeback()'))
    check('C 收到完成／停止事件時不關 SSE（結構檢查）', /es\.close\(\)/.test(onMsg), false)
    check('C 按停止時不關 SSE（結構檢查）', /esRef\.current\?\.close\(\)/.test(stopFn), false)
  }
} catch (err) {
  console.log(`FAIL  執行中斷：${err.message}`)
  failures.push(err.message)
} finally {
  for (const id of created) {
    db.prepare('DELETE FROM ui_screenshot_tasks WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM ui_screenshot_runs WHERE id = ?').run(id)
    db.prepare(`DELETE FROM operation_history WHERE feature = 'ui-screenshot' AND detail LIKE ?`).run(`%${id}%`)
  }
  db.close()
}

console.log('')
if (failures.length) { console.log(`不通過——${failures.length} 條`); process.exit(1) }
console.log('通過——完成／停止之後的收尾警告都送得到網頁')
