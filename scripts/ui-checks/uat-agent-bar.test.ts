/**
 * scripts/ui-checks/uat-agent-bar.test.ts
 *
 * 驗共用 Agent 狀態列的判斷（`src/features/uat/agent-bar-state.ts`）。
 *
 * ⚠️ 這條列要解的病是**假綠燈**——原本頁首那顆「Runner Ready／靈脈穩定」是寫死的字串，
 *    一台 Agent 都沒有也照樣顯示。所以真正要守住的不是「有 Agent 時長什麼樣」，
 *    而是**沒有／查不到身分／查詢失敗時不會被顯示成沒事**。
 *
 * ⚠️ 跟元件 **import 同一支**，不在測試裡重寫規則。
 *
 * 跑法：npx tsx scripts/ui-checks/uat-agent-bar.test.ts
 */
import assert from 'node:assert/strict'
import { deriveAgentBarView } from '../../src/features/uat/agent-bar-state'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const agent = (caps: string[]) => ({
  capability: Object.fromEntries(['uat-record', 'uat-run', 'backend-uat'].map(c => [c, { usable: caps.includes(c) }])),
})

check('① 有可用的 → ok，而且數的是「對這個分頁」可用的台數', () => {
  const view = deriveAgentBarView({
    phase: 'ready', tab: 'h5',
    data: { authed: true, agents: [agent(['uat-record']), agent(['uat-run'])] },
  })
  assert.equal(view.state, 'ok')
  assert.equal(view.usableCount, 1, '只有一台有錄製能力')
  assert.equal(view.totalCount, 2)
})

check('② ⚠️ 同一批 Agent，換到 Backend 分頁就不是 ok（能力不同）', () => {
  const data = { authed: true, agents: [agent(['uat-record']), agent(['uat-run'])] }
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'h5', data }).state, 'ok')
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'backend', data }).state, 'warn',
    '沒有 backend-uat 能力卻顯示成可用——那就是「畫面說可以派、按下去被擋」')
})

check('③ ⚠️ 查詢失敗要是 error，不能因為「沒資料」被歸成沒有 Agent', () => {
  const view = deriveAgentBarView({ phase: 'error', tab: 'h5', data: null })
  assert.equal(view.state, 'error', '把「我不知道」講成「我知道沒有」是兩回事')
})

check('④ ⚠️ 查詢失敗即使還留著上一次的資料，也不得顯示成 ok', () => {
  // 這是防呆：元件在失敗時會把 data 清成 null，但萬一哪天有人改成保留，
  // 判斷這一層也不能放行——失敗沿用綠燈正是要擋的那件事。
  const view = deriveAgentBarView({
    phase: 'error', tab: 'h5',
    data: { authed: true, agents: [agent(['uat-record'])] },
  })
  assert.equal(view.state, 'error')
})

check('⑤ 載入中是自己一種狀態，不是 ok 也不是 none', () => {
  assert.equal(deriveAgentBarView({ phase: 'loading', tab: 'h5', data: null }).state, 'loading')
})

check('⑥ ⚠️ 查不到登入身分跟「沒有 Agent」要分開', () => {
  const view = deriveAgentBarView({ phase: 'ready', tab: 'h5', data: { authed: false, agents: [] } })
  assert.equal(view.state, 'anon', '講成「沒有 Agent」會讓人去啟動 Agent，但該做的是重新登入')
})

check('⑦ 有連線但這個分頁都用不了 → warn（不是 none）', () => {
  const view = deriveAgentBarView({
    phase: 'ready', tab: 'h5', data: { authed: true, agents: [agent(['uat-run'])] },
  })
  assert.equal(view.state, 'warn')
  assert.equal(view.totalCount, 1, '要講得出「有連線，只是用不了」')
})

check('⑧ 一台都沒有 → none', () => {
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'h5', data: { authed: true, agents: [] } }).state, 'none')
})

check('⑨ 本機錄製只救 H5/PC', () => {
  const data = { authed: true, localRecord: true, agents: [] }
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'h5', data }).localFallback, true)
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'pc', data }).localFallback, true)
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'backend', data }).localFallback, false,
    'Backend 沒有本機錄製這條路，說「還可以用」是錯的')
})

check('⑩ 不是從本機開的就沒有這條退路', () => {
  const data = { authed: true, localRecord: false, agents: [] }
  assert.equal(deriveAgentBarView({ phase: 'ready', tab: 'h5', data }).localFallback, false)
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
