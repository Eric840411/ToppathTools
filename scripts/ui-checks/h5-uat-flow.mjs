/**
 * 走一次 UAT 整測工具的 H5 完整流程（不透過畫面，直接打它自己的 API），
 * 目的是確認「建立 run → 派工給 agent → 積木逐步執行 → 結果落地」這條路是通的。
 *
 * ⚠️ 用 node fetch 而不是 shell curl：帶中文的欄位走 Git Bash 會被換成 U+FFFD，
 *    而且是**無聲的**——我第一次就因此差點把自己的編碼問題當成伺服器的 bug。
 */
const BASE = process.env.BASE ?? 'http://localhost:3000'
const AGENT = process.env.AGENT_ID ?? ''
const URL_H5 = process.env.H5_URL ?? ''
const NAME = process.env.SCRIPT_NAME ?? 'H5 流程驗證'

const j = async (path, init) => {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init?.headers ?? {}), ...(process.env.COOKIE ? { cookie: process.env.COOKIE } : {}) } })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text.slice(0, 300) } }
}
const COOKIE = process.env.COOKIE ?? ''
const post = (path, data) => j(path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...(COOKIE ? { cookie: COOKIE } : {}) }, body: JSON.stringify(data) })

// 積木：涵蓋 nav / assert / evidence 三個分類，這樣聚合判定那條路才會真的被走到。
// 選擇器是 2026-09-19 從**線上大廳現場**盤出來的，不是從舊腳本抄的。
const steps = [
  { action: 'wait', value: '10000', name: '等大廳載入' },
  { action: 'assert_visible', selector: '.grid-item-name', minCount: 5, name: '大廳有機台卡片' },
  { action: 'screenshot', name: '大廳畫面' },
  { action: 'assert_visible', selector: '.section-title', minCount: 1, name: '分區標題存在' },
  { action: 'assert_visible', selector: '.jackpot-number', minCount: 1, name: '獎池數字有顯示' },
  { action: 'click', selector: '.grid-item', name: '點第一台機台' },
  { action: 'wait', value: '10000', name: '等機台載入' },
  { action: 'screenshot', name: '機台畫面' },
]

const main = async () => {
  const created = await post('/api/frontend-auto/runs', {
    platform: 'h5', scriptName: NAME, ranBy: 'claude-osm', totalSteps: steps.length, result: 'running',
  })
  console.log(JSON.stringify({ step: 'create', status: created.status, runId: created.body?.run?.id }))
  const runId = created.body?.run?.id
  if (!runId) { console.log('建立 run 失敗，停手'); return }

  const exec = await post(`/api/frontend-auto/runs/${runId}/execute`, {
    steps: JSON.stringify(steps),
    url: URL_H5,
    platform: 'h5',
    resolution: '500x877',
    failureMode: 'continue',
    headed: true,
    agentId: AGENT,
  })
  console.log(JSON.stringify({ step: 'execute', status: exec.status, body: exec.body }))
  if (exec.status !== 200) return

  // 輪詢 run 狀態，順便把 log 拉出來——log 才看得到每一顆積木的結果
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 6000))
    const run = await j(`/api/frontend-auto/runs/${runId}`)
    const r = run.body?.run ?? run.body
    const done = r?.finished_at || (r?.result && r.result !== 'running' && r.result !== 'unknown')
    console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), result: r?.result, passed: r?.passed, failed: r?.failed, skipped: r?.skipped }))
    if (done) break
  }
  const logs = await j(`/api/frontend-auto/runs/${runId}`)
  console.log('--- run 最終 ---')
  console.log(JSON.stringify(logs.body?.run ?? logs.body))
  console.log('runId=' + runId)
}
main().catch(e => console.log('FATAL', String(e).slice(0, 300)))
