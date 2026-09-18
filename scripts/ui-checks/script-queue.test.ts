/**
 * scripts/ui-checks/script-queue.test.ts
 *
 * 驗「一份一份排隊跑」那條共用規則（`src/features/uat/script-queue.ts`）。
 *
 * ## 為什麼要單獨一支
 * Backend 與 H5／PC 現在跑**同一支迴圈**，各自只提供端點。這支直接驗那支迴圈，
 * 不經過任何一邊的端點——那樣才驗得到規則本身，而不是某一邊的接線。
 *
 * 每一條都對應一個**安靜出錯**的方式：
 *   ① 沒照順序跑 → 依賴前一份狀態的腳本會莫名其妙失敗
 *   ② 拿到別次的結果 → 畫面顯示一份**看起來完全合理**的假結果
 *   ③ 失敗後不中止 → 後面每一份都在錯誤狀態上繼續跑，錯誤原因被蓋掉
 *   ④ 中止後剩下的留在「等待中」→ 使用者以為還會跑，其實不會
 *   ⑤ 取消只改畫面不送停止 → 瀏覽器還在那台機器上跑，佔著資源
 *   ⑥ 取不到結果當成通過 → 最糟：那一次做了什麼沒人知道，而畫面是綠的
 *
 * 跑法：npx tsx scripts/ui-checks/script-queue.test.ts
 */
import assert from 'node:assert/strict'
import { runScriptQueue, type QueueItem, type QueueDriver } from '../../src/features/uat/script-queue'

const results: Array<{ name: string; ok: boolean }> = []
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Row = { outcome: string }
const makeItems = (...ids: string[]): QueueItem<Row>[] =>
  ids.map(id => ({ id, title: id, state: 'waiting', results: [] }))

/** 一個「乖乖跑完」的假環境，各條測試再覆寫需要的部分 */
const fakeWorld = (overrides: Partial<QueueDriver<Row>> = {}) => {
  const calls: string[] = []
  let session = 0
  const driver: QueueDriver<Row> = {
    start: async item => { calls.push(`start:${item.id}`); return { sessionId: `run-${++session}` } },
    status: async sessionId => ({ sessionId, running: false }),
    stop: async sessionId => { calls.push(`stop:${sessionId}`) },
    results: async (item, sessionId) => { calls.push(`results:${item.id}`); return { results: [{ outcome: 'pass' }] } },
    ...overrides,
  }
  return { calls, driver }
}

const run = async (items: QueueItem<Row>[], driver: QueueDriver<Row>, cancelled: () => boolean = () => false) => {
  await runScriptQueue<Row>(items, driver, {
    cancelled,
    update: (index, patch) => { items[index] = { ...items[index], ...patch } },
    started: () => {},
    pause: async () => {},
  })
  return items
}

await check('① 照順序一份一份跑，而且每一份都拿自己的結果', async () => {
  const items = makeItems('a', 'b', 'c')
  const { calls, driver } = fakeWorld()
  await run(items, driver)
  assert.deepEqual(calls.filter(c => c.startsWith('start')), ['start:a', 'start:b', 'start:c'])
  assert.deepEqual(items.map(i => i.state), ['done', 'done', 'done'])
  // 每一份的 sessionId 都不同——共用一個就代表沒有真的各跑一次
  assert.equal(new Set(items.map(i => i.sessionId)).size, 3)
})

await check('② 🚨 跑的不是我派的那一次 → 整個佇列停下來（不能拿別人的結果）', async () => {
  const items = makeItems('a', 'b')
  const { driver } = fakeWorld({ status: async () => ({ sessionId: 'someone-else', running: false }) })
  await run(items, driver)
  assert.equal(items[0].state, 'error', JSON.stringify(items[0]))
  assert.match(items[0].error ?? '', /執行編號/)
  assert.equal(items[1].state, 'cancelled', '後面那份應該標成取消')
})

await check('② ⚠️ 狀態端點回不出編號也要停（不是當成「還是我那一次」）', async () => {
  // 重啟、查不到、回應格式變了都會落到這裡。放行的話會拿到不知道哪一次的結果。
  const items = makeItems('a', 'b')
  const { driver } = fakeWorld({ status: async () => ({ running: false }) })
  await run(items, driver)
  assert.equal(items[0].state, 'error', JSON.stringify(items[0]))
})

await check('③ 派工就失敗（例如後端回 409 已經有人在跑）→ 後面全部取消', async () => {
  const items = makeItems('a', 'b', 'c')
  const { calls, driver } = fakeWorld({ start: async () => { throw new Error('already running') } })
  await run(items, driver)
  assert.deepEqual(items.map(i => i.state), ['error', 'cancelled', 'cancelled'])
  assert.match(items[0].error ?? '', /already running/)
  assert.equal(calls.filter(c => c.startsWith('results')).length, 0, '失敗了還去抓結果')
})

await check('③ 派工沒回編號也算失敗（不能拿空字串繼續比對）', async () => {
  const items = makeItems('a', 'b')
  const { driver } = fakeWorld({ start: async () => ({ sessionId: '' }) })
  await run(items, driver)
  assert.equal(items[0].state, 'error')
  assert.equal(items[1].state, 'cancelled')
})

await check('④ 🚨 中止之後，剩下的標成「取消」而不是留在「等待中」', async () => {
  const items = makeItems('a', 'b', 'c')
  let cancelled = false
  const { driver } = fakeWorld({
    results: async () => { cancelled = true; return { results: [{ outcome: 'pass' }] } },
  })
  await run(items, driver, () => cancelled)
  assert.equal(items[0].state, 'cancelled')
  assert.deepEqual(items.slice(1).map(i => i.state), ['cancelled', 'cancelled'],
    '留在 waiting 的話，使用者會以為它還會跑')
})

await check('⑤ 🚨 取消要真的送出停止，不是只改畫面', async () => {
  // ⚠️ 情境是「**派工之後**才按取消」——瀏覽器已經在某台機器上開起來了。
  //    一開始就取消的話根本不會派工，那條路徑測不到（第一版的測試就是這樣寫的，
  //    它「過」的原因是什麼都沒發生）。
  const items = makeItems('a')
  let cancelled = false
  const { calls, driver } = fakeWorld({
    start: async item => { cancelled = true; return { sessionId: `run-${item.id}` } },
    status: async sessionId => ({ sessionId, running: true }),
  })
  await runScriptQueue<Row>(items, driver, {
    cancelled: () => cancelled,
    update: (index, patch) => { items[index] = { ...items[index], ...patch } },
    started: () => {},
    pause: async () => {},
  })
  assert.ok(calls.some(c => c.startsWith('stop:')), `沒有送出停止：${JSON.stringify(calls)}`)
})

await check('⑤ 一開始就取消 → 一份都不派（也不會有停止請求）', async () => {
  const items = makeItems('a', 'b')
  const { calls, driver } = fakeWorld()
  await run(items, driver, () => true)
  assert.deepEqual(items.map(i => i.state), ['cancelled', 'cancelled'])
  assert.deepEqual(calls, [], `不該有任何請求：${JSON.stringify(calls)}`)
})

await check('⑤ 🚨 停止沒生效時不會永遠等下去（畫面卡在「執行中」且沒有錯誤訊息）', async () => {
  // 這一條是寫測試時當場踩到的：status 永遠回 running 的話，原本的迴圈**不會結束**。
  // 實務上的成因是 agent 斷線或程序卡住——停止請求送出去了，但沒有人來收尾。
  const items = makeItems('a', 'b')
  let cancelled = false
  let polls = 0
  const { driver } = fakeWorld({
    start: async item => { cancelled = true; return { sessionId: `run-${item.id}` } },
    status: async sessionId => { polls++; return { sessionId, running: true } },
  })
  await runScriptQueue<Row>(items, driver, {
    cancelled: () => cancelled,
    update: (index, patch) => { items[index] = { ...items[index], ...patch } },
    started: () => {},
    pause: async () => {},
  })
  assert.equal(items[0].state, 'cancelled', JSON.stringify(items[0]))
  assert.match(items[0].error ?? '', /沒有結束/)
  assert.ok(polls < 60, `輪詢了 ${polls} 次還沒放棄——上限沒生效`)
  assert.equal(items[1].state, 'cancelled')
})

await check('⑥ 🚨 取不到結果不能當成通過', async () => {
  const items = makeItems('a', 'b')
  const { driver } = fakeWorld({ results: async () => undefined })
  await run(items, driver)
  assert.equal(items[0].state, 'error', JSON.stringify(items[0]))
  assert.match(items[0].error ?? '', /取不到結果/)
  assert.equal(items[1].state, 'cancelled')
})

await check('⑥ 拿不到結果會先重試幾次才放棄（一次沒拿到不代表沒有）', async () => {
  const items = makeItems('a')
  let tries = 0
  const { driver } = fakeWorld({
    results: async () => { tries++; return tries < 3 ? undefined : { results: [{ outcome: 'pass' }] } },
  })
  await run(items, driver)
  assert.equal(items[0].state, 'done', JSON.stringify(items[0]))
  assert.equal(tries, 3)
})

await check('⚠️ 執行期間會等到真的結束才派下一份', async () => {
  const items = makeItems('a', 'b')
  const polls: string[] = []
  let remaining = 3
  const { calls, driver } = fakeWorld({
    status: async sessionId => {
      polls.push(sessionId)
      // 第一份要輪詢三次才結束；第二份直接結束
      if (sessionId === 'run-1' && remaining-- > 0) return { sessionId, running: true }
      return { sessionId, running: false }
    },
  })
  await run(items, driver)
  assert.ok(polls.filter(p => p === 'run-1').length >= 3, `沒有等它跑完：${JSON.stringify(polls)}`)
  // 第二份一定要排在第一份拿到結果之後
  assert.ok(calls.indexOf('results:a') < calls.indexOf('start:b'), JSON.stringify(calls))
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
