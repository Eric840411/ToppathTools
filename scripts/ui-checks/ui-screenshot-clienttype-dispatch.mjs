/**
 * 驗：使用者在畫面上選的「客戶端（H5 / PC）」，真的有一路傳到 agent 收到的那則派工訊息。
 *
 * 為什麼要有這支：v4.251.0 當下我只截了兩張「畫面上長對了」的圖就說驗過了——
 * **那只證明控制項畫得出來，沒證明派工真的照著選的走**（CodeX 2026-09-21 指出）。
 *
 * 這支驗的是**中間那一段**：前端送出的 `clientType` → 中控 → agent 實際收到的訊息。
 * 它會：
 *   1. 在 data.db 塞一個臨時 agent token（跑完刪掉）
 *   2. 用真的 WebSocket 接上 `ws://<host>/ws/agent`，冒充一個 agent
 *   3. 打真的 `POST /api/ui-screenshot/scan-lobby` 與 `/start`
 *   4. 斷言 agent 收到的訊息裡 `clientType` 就是送進去那個
 *
 * ⚠️ **它驗不到的**：agent 拿到之後有沒有真的走對分支（Cocos 場景樹 vs DOM 卡片）。
 *    那要有真的大廳才驗得了，只能實機跑。這支只保證「選的東西有送到」。
 *
 * 用法：node scripts/ui-checks/ui-screenshot-clienttype-dispatch.mjs [baseUrl]
 *       預設 http://localhost:3000
 */
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import WebSocket from 'ws'

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/agent'

const db = new Database('server/data.db')
const token = `tla_test_${randomBytes(16).toString('hex')}`
const tokenId = `clienttype_check_${Date.now().toString(36)}`
const ownerKey = `clienttype-check-${randomBytes(4).toString('hex')}`
const agentId = `clienttype-check-${randomBytes(4).toString('hex')}`

const failures = []
const notes = []
function check(name, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(actual)}${ok ? '' : ` (預期 ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

function cleanup() {
  try {
    db.prepare('DELETE FROM local_agent_tokens WHERE id = ?').run(tokenId)
    db.prepare("DELETE FROM ui_screenshot_tasks WHERE run_id IN (SELECT id FROM ui_screenshot_runs WHERE agent_id = ?)").run(agentId)
    db.prepare('DELETE FROM ui_screenshot_runs WHERE agent_id = ?').run(agentId)
  } catch (err) {
    notes.push(`清理失敗（不影響判定）：${err.message}`)
  }
  db.close()
}

db.prepare(`
  INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, revoked, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?)
`).run(tokenId, createHash('sha256').update(token).digest('hex'), ownerKey, 'clienttype-check', 'clienttype dispatch check', Date.now())

const ws = new WebSocket(WS_URL)
/** agent 收到的訊息，依 type 分桶 */
const inbox = new Map()
ws.on('message', raw => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (!inbox.has(msg.type)) inbox.set(msg.type, [])
  inbox.get(msg.type).push(msg)
})

/** 等 agent 收到某種訊息（每次呼叫前先清掉該桶，避免讀到上一輪的） */
function waitFor(type, timeoutMs = 8000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const got = inbox.get(type)
      if (got?.length) return resolve(got.shift())
      if (Date.now() - start > timeoutMs) return reject(new Error(`等不到 ${type}（${timeoutMs}ms）`))
      setTimeout(tick, 100)
    }
    tick()
  })
}

const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const H5_URL = 'https://osm-h5-prod.osmslot.org/?token=x&platform=pc&mode=live&gameid={gmid}&device=mobile'
const PC_URL = 'https://osm-pc-prod.osmslot.org/?token=x&platform=pc&mode=live&gameid={gmid}&device=mobile'

try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    setTimeout(() => reject(new Error(`連不上 ${WS_URL}——server 沒起來？`)), 8000)
  })
  ws.send(JSON.stringify({
    type: 'agent_ready',
    agentId,
    hostname: 'clienttype-check',
    operatorKey: ownerKey,
    operatorName: 'clienttype-check',
    agentToken: token,
    capabilities: ['ui-screenshot'],
  }))
  // 等中控把這個 agent 記進 agentConnections
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/ui-screenshot/agents`).then(r => r.json()).catch(() => null)
    if (r?.agents?.some(a => a.agentId === agentId)) break
    await new Promise(r => setTimeout(r, 250))
  }

  // ── 1. 掃大廳：H5 的網址帶著 platform=pc，選 H5 就必須送 h5 ─────────────
  //    這正是原本那個 bug 的形狀：網址說 pc、使用者要的是 h5
  void post('/api/ui-screenshot/scan-lobby', { agentId, gameUrlTemplate: H5_URL, clientType: 'h5' })
  check('掃大廳｜H5 網址(含 platform=pc) + 選 H5', (await waitFor('ui_screenshot_scan')).clientType, 'h5')

  // ── 2. 掃大廳：PC 的網址帶著 device=mobile，選 PC 就必須送 pc ───────────
  void post('/api/ui-screenshot/scan-lobby', { agentId, gameUrlTemplate: PC_URL, clientType: 'pc' })
  check('掃大廳｜PC 網址(含 device=mobile) + 選 PC', (await waitFor('ui_screenshot_scan')).clientType, 'pc')

  // ── 3. 反向：H5 的網址但使用者選 PC，也必須照選的送 ─────────────────────
  //    中控不可以「好心」幫忙改回 h5——那就是又在猜
  void post('/api/ui-screenshot/scan-lobby', { agentId, gameUrlTemplate: H5_URL, clientType: 'pc' })
  check('掃大廳｜H5 網址 + 選 PC（中控不得擅自更正）', (await waitFor('ui_screenshot_scan')).clientType, 'pc')

  // ── 4. 沒給 clientType：必須是 undefined，不能被默默補成某一邊 ──────────
  //    退路留給 agent 決定並且會 warn；中控補預設的話那個 warn 永遠不會出現
  void post('/api/ui-screenshot/scan-lobby', { agentId, gameUrlTemplate: H5_URL })
  check('掃大廳｜沒給 clientType（中控不得補預設）', (await waitFor('ui_screenshot_scan')).clientType, undefined)

  // ── 5. 亂給的值：一律當沒給 ────────────────────────────────────────────
  void post('/api/ui-screenshot/scan-lobby', { agentId, gameUrlTemplate: H5_URL, clientType: 'PC' })
  check('掃大廳｜clientType 值不合法（大寫 PC）→ 當沒給', (await waitFor('ui_screenshot_scan')).clientType, undefined)

  // ── 6~7. 截圖派工也要帶著同一個值 ──────────────────────────────────────
  const startBody = {
    agentId, wikiUrl: '', gmids: ['CHECK-GMID'], resolutions: ['390x844'],
    options: { reloadPerResolution: true },
  }
  await post('/api/ui-screenshot/start', { ...startBody, gameUrlTemplate: H5_URL, clientType: 'h5' })
  check('截圖派工｜選 H5', (await waitFor('ui_screenshot_start')).run.clientType, 'h5')

  // agent 被標成 busy 了，要先回報空閒才收得到下一個 run
  ws.send(JSON.stringify({ type: 'agent_ready', agentId, hostname: 'clienttype-check', operatorKey: ownerKey, operatorName: 'clienttype-check', agentToken: token, capabilities: ['ui-screenshot'] }))
  await new Promise(r => setTimeout(r, 800))

  await post('/api/ui-screenshot/start', { ...startBody, gameUrlTemplate: H5_URL, clientType: 'pc' })
  check('截圖派工｜H5 網址 + 選 PC（中控不得擅自更正）', (await waitFor('ui_screenshot_start')).run.clientType, 'pc')
} catch (err) {
  console.log(`FAIL  執行中斷：${err.message}`)
  failures.push(`執行中斷：${err.message}`)
} finally {
  ws.close()
  cleanup()
}

console.log('')
for (const n of notes) console.log(`注意：${n}`)
if (failures.length) {
  console.log(`不通過——${failures.length} 條沒過：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('通過——畫面上選的客戶端，agent 收到的派工訊息裡就是那一個（7 條）')
console.log('⚠️ 這支不保證 agent 拿到之後走對分支；那要實機跑真大廳才驗得了')
