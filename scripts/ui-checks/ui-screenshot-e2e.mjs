/**
 * **端到端跑一次真的 UI 截圖任務**：起一個真的 agent（`dist-server/server/agent-runner.js`）、
 * 透過真的 API 派工、等真的任務狀態回來。
 *
 * 🚨 **這支是 2026-09-22 兩個死結的發現者。**在它之前，彈窗那套有 60 條 fixture 測試全綠，
 *    但真的跑一次就看到：
 *      ① `關掉面額選單（第 1 輪）…（第 5 輪）` —— 面額選單被上層 Tips 蓋住點不下去，
 *         而點失敗被 `.catch(() => {})` 吞掉還算成進度，每輪都 continue，
 *         於是 Confirm 那一步**一次都輪不到**
 *      ② `有彈窗但不在已確認清單裡，沒有點：YESNO（容器 .select-main）` ——
 *         面額確認框整段文字只有 YESNO，只比對文字認不出來
 *    **fixture 測不出來的原因是它們都需要「兩層彈窗疊在一起」**，而我做的 fixture 每次只擺一層。
 *
 * ⚠️ 需要：① 本機 server 在跑（`http://localhost:3000`）② 一條**能用的真實大廳網址**
 *    （帶有效 token）。所以它不能進 CI，是「手上有網址時拿來跑一次」的工具。
 *
 * 用法：
 *   node scripts/ui-checks/ui-screenshot-e2e.mjs "<gameUrlTemplate 含 {gmid}>" "<gmid 或 model>" "<解析度,逗號分隔>"
 *   AUTOPICK=0 可關掉自動選機（gmid 要給真的機台號）
 */
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const BASE = 'http://localhost:3000'
const URL_TEMPLATE = process.argv[2]
const GMID = process.argv[3] ?? 'osmbbhl'
const RES = process.argv[4] ?? '412x915'

const db = new Database('server/data.db')
const token = `tla_e2e_${randomBytes(12).toString('hex')}`
const tokenId = `e2e_${Date.now().toString(36)}`
const ownerKey = `e2e-${randomBytes(3).toString('hex')}`
db.prepare(`INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, revoked, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)`)
  .run(tokenId, createHash('sha256').update(token).digest('hex'), ownerKey, 'e2e', 'e2e probe', Date.now())

const agent = spawn(process.execPath, ['dist-server/server/agent-runner.js'], {
  env: {
    ...process.env,
    CENTRAL_URL: 'ws://localhost:3000',
    AGENT_LABEL: 'e2e-probe',
    AGENT_OWNER_KEY: ownerKey,
    AGENT_OWNER_NAME: 'e2e',
    AGENT_TOKEN: token,
    AGENT_CAPABILITIES: 'ui-screenshot,machine-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const lines = []
const onData = buf => {
  for (const l of buf.toString().split('\n')) {
    if (!l.trim()) continue
    lines.push(l)
    if (/UI-SS|Agent|error|Error/.test(l)) console.log('  [agent] ' + l.trim().slice(0, 220))
  }
}
agent.stdout.on('data', onData)
agent.stderr.on('data', onData)

const cleanup = () => {
  try { agent.kill() } catch {}
  try {
    db.prepare('DELETE FROM local_agent_tokens WHERE id = ?').run(tokenId)
    db.prepare("DELETE FROM ui_screenshot_tasks WHERE run_id IN (SELECT id FROM ui_screenshot_runs WHERE agent_id LIKE 'e2e-probe%')").run()
    db.prepare("DELETE FROM ui_screenshot_runs WHERE agent_id LIKE 'e2e-probe%'").run()
  } catch (e) { console.log('cleanup:', e.message) }
  db.close()
}

try {
  // agentId = `${AGENT_LABEL}_${pid}`。/agents 會依呼叫者的 operator key 過濾，
  // 這支沒有登入身分所以列不到——但 /start 是直接用 agentId 查，不受影響
  const agentId = `e2e-probe_${agent.pid}`
  // 等 WS 註冊完成（連上之後還要送 agent_ready 並通過 token 驗證）
  let online = false
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (lines.some(l => l.includes('Connected — ready'))) { online = true; break }
  }
  if (!online) throw new Error('agent 沒有上線')
  await new Promise(r => setTimeout(r, 1500))
  console.log(`agent 上線：${agentId}\n`)

  const body = {
    agentId,
    wikiUrl: '',
    gameUrlTemplate: URL_TEMPLATE,
    gmids: [GMID],
    resolutions: RES.split(','),
    clientType: 'h5',
    options: {
      dismissPopup: true, waitForVideo: true, headedMode: false,
      screenshotDelaySeconds: 5, reloadPerResolution: true, autoPickByGame: process.env.AUTOPICK !== '0',
    },
  }
  const started = await fetch(`${BASE}/api/ui-screenshot/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json())
  console.log('start:', JSON.stringify(started), '\n')
  if (!started.ok) throw new Error(started.message)

  // 等任務結束
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const row = db.prepare('SELECT status, error_msg FROM ui_screenshot_tasks WHERE run_id = ?').get(started.runId)
    if (row && !['pending', 'running'].includes(row.status)) {
      console.log(`\n>>> 任務結束：status=${row.status}  error=${row.error_msg ?? '(無)'}`)
      break
    }
  }
  const popupLines = lines.filter(l => /關掉|彈窗|Confirm/.test(l))
  console.log(`\n>>> 關窗相關的 log ${popupLines.length} 行：`)
  for (const l of popupLines) console.log('   ' + l.trim().slice(0, 200))
} catch (err) {
  console.log('❌ ' + err.message)
} finally {
  cleanup()
  setTimeout(() => process.exit(0), 500)
}
