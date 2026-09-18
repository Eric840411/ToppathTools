/**
 * scripts/ui-checks/uat-pause-gate.test.ts
 *
 * 驗「暫停／繼續」那顆按鈕的等待狀態機（`src/features/uat/pause-gate.ts`）。
 *
 * ⚠️ **這支跟元件 import 同一份實作**，不是在測試裡重寫一份規則——
 *    兩份規則一定會漂，而漂掉的症狀是「測試全綠、畫面卡住」。
 *
 * 這裡的每一條都對應一個**真的發生過**的壞法：
 *   ① 計時器起在回應之後 → 請求永遠不回來時按鈕永久卡住（v4.183.2）
 *   ② A 逾時後送出 B，A 遲到的回應把 B 的等待一起清掉（CodeX 2026-09-18 複驗）
 *   ③ 輪詢收到相反的狀態就當成確認 → 把「agent 還沒動作」誤報成「已經切好了」
 *
 * ⚠️ **誠實說明一處殺不死的突變**：舊計時器有兩道防線——`begin()`／`invalidate()` 會
 *    `clearTimeout`，計時器回呼自己也比對 token。任一道單獨拿掉，另一道都擋得住，
 *    所以個別注入殺不死（兩道一起拿掉才會紅）。那個 token 比對目前是**不可達的
 *    防禦性程式碼**，留著是為了擋住「哪天有人把 clearTimeout 拿掉」。
 *
 * 跑法：npx tsx scripts/ui-checks/uat-pause-gate.test.ts
 */
import assert from 'node:assert/strict'
import { createPauseGate } from '../../src/features/uat/pause-gate'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 每個案例自己一組計數器，避免互相汙染 */
function harness(timeoutMs = 40) {
  const pending: boolean[] = []
  let timeouts = 0
  const gate = createPauseGate({
    timeoutMs,
    setPending: (v) => pending.push(v),
    onTimeout: () => { timeouts++ },
  })
  return { gate, pending, timedOut: () => timeouts }
}

// ── ① 逾時：請求永遠不回來也一定要結束等待 ──────────────────────────────
await (async () => {
  const h = harness()
  h.gate.begin(true)
  assert.deepEqual(h.pending, [true], '送出當下就要進入等待')
  await sleep(90)
  check('① 請求永遠不回來 → 逾時解除等待', () => {
    assert.equal(h.timedOut(), 1, '沒有觸發逾時——計時器可能起在回應之後')
    assert.deepEqual(h.pending, [true, false])
  })
  check('① 逾時之後不再有人在等', () => assert.equal(h.gate.wanted(), null))
})()

// ── ①b 逾時之後「沒有」送出下一筆，遲到的回應照樣不得動作 ───────────────
// ⚠️ CodeX 2026-09-18 第三輪複驗指出：②「先送出 B」剛好把這個缺口遮住了——
//    逾時本身若不推進序號，`isCurrent(A)` 在沒有 B 的情況下仍然是 true，
//    於是 A 遲到的成功回應會再把畫面改成已暫停、遲到的錯誤會覆蓋提示。
//    這一條刻意**不送 B**，直接驗逾時有沒有讓那一筆自己失效。
await (async () => {
  const h = harness()
  const a = h.gate.begin(true)
  await sleep(90)                       // A 逾時，而且沒有下一筆
  check('①b A 逾時了', () => assert.equal(h.timedOut(), 1))
  check('①b ⚠️ 逾時本身就要讓那一筆失效（沒有下一筆也一樣）', () =>
    assert.equal(h.gate.isCurrent(a), false,
      'isCurrent 還是 true——A 遲到的回應會再改一次畫面'))
  const pendingAfterTimeout = h.pending.length
  check('①b ⚠️ 逾時之後遲到的回應 settle 不掉', () => {
    assert.equal(h.gate.settle(a), false)
    assert.equal(h.pending.length, pendingAfterTimeout, '遲到的回應動到了畫面狀態')
  })
})()

// ── ② 逾時之後送出下一筆，遲到的回應不得清掉它 ──────────────────────────
// ⚠️ 這條就是 CodeX 複驗抓到的。少了它，畫面會在 B 還沒回來時就解除等待，
//    然後 B 真的回來時又動一次——使用者看到按鈕閃一下、狀態卻沒變。
await (async () => {
  const h = harness()
  const a = h.gate.begin(true)
  await sleep(90)                       // A 逾時
  const b = h.gate.begin(false)         // 使用者再按一次
  const pendingAfterB = h.pending.length
  check('② A 逾時後 B 開始等待', () => assert.equal(h.pending.at(-1), true))
  check('② ⚠️ A 遲到的回應不得結束 B 的等待', () => {
    assert.equal(h.gate.settle(a), false, 'stale 的 token 竟然 settle 成功')
    assert.equal(h.pending.length, pendingAfterB, 'stale 的 token 動到了畫面狀態')
    assert.equal(h.gate.wanted(), false, 'B 要等的值被清掉了')
  })
  check('② ⚠️ A 遲到的回應也不得被當成當前那一筆', () =>
    assert.equal(h.gate.isCurrent(a), false))
  check('② B 自己 settle 得掉', () => {
    assert.equal(h.gate.settle(b), true)
    assert.equal(h.pending.at(-1), false)
  })
})()

// ── ②b A 的計時器不能去收 B 的等待 ──────────────────────────────────────
// 同一個問題的另一半：A 還沒逾時，使用者就又按了一次。A 的計時器到期時
// **不可以**把 B 的等待清掉——否則 B 會在沒有任何回應的情況下被判成結束。
await (async () => {
  const h = harness(40)
  h.gate.begin(true)
  await sleep(25)                 // A 還沒到期
  const b = h.gate.begin(false)   // B 接手
  await sleep(25)                 // 這時 A 原本的到期時間已經過了
  check('②b ⚠️ 舊的計時器不得結束新的那一筆', () => {
    assert.equal(h.timedOut(), 0, 'A 的計時器把 B 收掉了')
    assert.equal(h.gate.wanted(), false, 'B 還在等，值不該被清掉')
    assert.equal(h.gate.isCurrent(b), true)
  })
  await sleep(40)                 // 換 B 自己到期
  check('②b 而 B 自己的計時器照樣會到期', () => assert.equal(h.timedOut(), 1))
})()

// ── ③ 輪詢：只有等到「要求的那個值」才算確認 ────────────────────────────
await (async () => {
  const h = harness(1000)
  h.gate.begin(true)
  check('③ ⚠️ 收到相反的狀態不算確認（agent 還沒處理完）', () => {
    assert.equal(h.gate.confirm(false), false)
    assert.equal(h.gate.wanted(), true, '等待被清掉了——會把沒動作誤報成已完成')
  })
  check('③ 收到要求的那個值才算確認', () => {
    assert.equal(h.gate.confirm(true), true)
    assert.equal(h.pending.at(-1), false)
  })
  check('③ 確認過之後再來的輪詢不會重複動作', () => assert.equal(h.gate.confirm(true), false))
  h.gate.cancel()
})()

// ── ④ cancel：錄製結束時全部作廢，計時器也不能留著 ──────────────────────
await (async () => {
  const h = harness(40)
  const a = h.gate.begin(true)
  h.gate.cancel()
  check('④ cancel 立刻解除等待', () => assert.equal(h.pending.at(-1), false))
  check('④ cancel 之後舊 token 全部失效', () => {
    assert.equal(h.gate.isCurrent(a), false)
    assert.equal(h.gate.settle(a), false)
  })
  await sleep(90)
  check('④ ⚠️ cancel 之後那顆計時器不得再觸發', () =>
    assert.equal(h.timedOut(), 0, '錄製都結束了還跳「沒有得到確認」'))
})()

// ── ⑤ 成功之後計時器不能留下來 ──────────────────────────────────────────
await (async () => {
  const h = harness(40)
  const a = h.gate.begin(true)
  h.gate.settle(a)
  await sleep(90)
  check('⑤ settle 之後計時器不得再觸發（本機模式是同步回應的）', () =>
    assert.equal(h.timedOut(), 0))
})()

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
