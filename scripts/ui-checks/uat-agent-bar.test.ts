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
import { allowsServerFallback, deriveAgentBarView, derivePickedState } from '../../src/features/uat/agent-bar-state'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const agent = (caps: string[], agentId = 'A1') => ({
  agentId,
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

// ── 派工選擇（v4.188.0：三個分頁的下拉整合到共用列）────────────────────────

// ⚠️ v4.189.0 改：我原本判斷成「只有 Backend 有」，那是錯的。
//    H5/PC 的伺服器端能力本來就存在，只是被藏在「你從哪個網址開的」判斷後面。
check('⑪ 三個分頁都有「伺服器端」選項', () => {
  assert.equal(allowsServerFallback('backend'), true)
  assert.equal(allowsServerFallback('h5'), true, 'H5 的伺服器端錄製本來就有，只是原本選不到')
  assert.equal(allowsServerFallback('pc'), true)
})

check('⑫ 沒選＝自動，選 server 就是 server', () => {
  const input = { phase: 'ready' as const, tab: 'backend' as const, data: { authed: true, agents: [] } }
  assert.equal(derivePickedState('', input), 'none')
  assert.equal(derivePickedState('server', input), 'server')
})

check('⑬ 選到的還在而且可用 → ok', () => {
  assert.equal(derivePickedState('A1', {
    phase: 'ready', tab: 'h5', data: { authed: true, agents: [agent(['uat-record'], 'A1')] },
  }), 'ok')
})

check('⑭ ⚠️ 選到的變成不可用時要講出來（而不是當作沒選）', () => {
  assert.equal(derivePickedState('A1', {
    phase: 'ready', tab: 'h5', data: { authed: true, agents: [agent(['uat-run'], 'A1')] },
  }), 'unusable', '不講的話使用者會以為照樣派得出去')
})

check('⑮ ⚠️ 選到的離線了要說「不在線上」', () => {
  assert.equal(derivePickedState('A1', {
    phase: 'ready', tab: 'h5', data: { authed: true, agents: [agent(['uat-record'], 'A2')] },
  }), 'gone')
})

check('⑯ ⚠️ 還在查／查失敗時不得說「不在線上」（那時清單本來就是空的）', () => {
  assert.equal(derivePickedState('A1', { phase: 'loading', tab: 'h5', data: null }), 'none',
    '把「我不知道」講成「我知道它不在」')
  assert.equal(derivePickedState('A1', { phase: 'error', tab: 'h5', data: null }), 'none')
})

check('⑰ ⚠️ 選到的不可用時，不會被悄悄換成別台（狀態只描述，不改值）', () => {
  // derivePickedState 是純函式、不回傳「換成哪一台」——這條釘住的是「沒有自動改選」
  // 這個設計本身：安靜地把工作送去別的地方，比擋下來糟得多。
  const input = {
    phase: 'ready' as const, tab: 'h5' as const,
    data: { authed: true, agents: [agent(['uat-run'], 'A1'), agent(['uat-record'], 'A2')] },
  }
  assert.equal(derivePickedState('A1', input), 'unusable')
  assert.equal(derivePickedState('A2', input), 'ok', '另一台可用不代表可以幫使用者改選')
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
