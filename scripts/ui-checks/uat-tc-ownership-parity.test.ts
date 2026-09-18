/**
 * scripts/ui-checks/uat-tc-ownership-parity.test.ts
 *
 * **「哪些積木一定要指定所屬 TC」前後端必須是同一份答案。**
 *
 * ## 為什麼需要這支
 * 說了算的是後端（`frontend-tc-engine.js` 的 `FRONTEND_BLOCK_DEFS`）——執行前的驗證
 * 讀的是它。前端（`BlockEditor.tsx` 的 `needsTc`）只是**提早顯示**，讓人在編輯器裡
 * 就看到紅字，不用等按了執行才被擋。
 *
 * 兩份名單漂掉的症狀分兩種，**都不會報錯**：
 *   - 前端少一個 → 畫面說沒問題，按執行被擋，而且看起來像「產品壞了」
 *   - 前端多一個 → 畫面一直標紅要求指定 TC，但那顆積木其實不需要；照做之後
 *     那一步的結果會被歸到某一筆 TC 上——**歸錯戶比沒歸戶更難發現**
 *
 * 這個 repo 的頭號慣性錯誤就是同一條規則寫兩份然後漂掉（CLAUDE.md 第 3 條）。
 *
 * 跑法：npx tsx scripts/ui-checks/uat-tc-ownership-parity.test.ts
 */
import assert from 'node:assert/strict'
import { needsTc } from '../../src/features/uat/BlockEditor'
// @ts-expect-error 後端是純 JS，沒有型別宣告
import { FRONTEND_BLOCK_DEFS } from '../../server/uat-runner/frontend-tc-engine.js'
import { STEP_LIBRARY } from '../../src/features/uat/step-model'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const defs = FRONTEND_BLOCK_DEFS as Record<string, { category: string }>
/** 後端的規則：檢查（assert／compare）與證據（evidence）一定要指定所屬 TC */
const OWNED = new Set(['assert', 'compare', 'evidence', 'read', 'result'])
const backendNeedsTc = (action: string) => OWNED.has(defs[action]?.category)

check('① 🚨 前端的「必須指定 TC」名單跟後端一字不差', () => {
  const actions = Object.keys(defs)
  const mismatched = actions.filter(action => backendNeedsTc(action) !== needsTc(action))
  assert.deepEqual(mismatched, [],
    `不一致的動作：${mismatched.map(a => `${a}（後端 ${backendNeedsTc(a)} / 前端 ${needsTc(a)}）`).join('、')}`)
})

check('② 前端不會對後端根本不認得的動作要求指定 TC', () => {
  // 編輯器的下拉是 STEP_LIBRARY 出來的。裡面若有後端沒實作的動作，
  // ⚠️ 那是另一個問題（存得起來、跑起來被擋），但至少不該同時又叫人指定 TC。
  const unknown = STEP_LIBRARY.map(item => item.action).filter(action => !defs[action] && needsTc(action))
  assert.deepEqual(unknown, [], `這些動作後端不認得，卻要求指定 TC：${unknown.join('、')}`)
})

check('③ 檢查類的積木確實在名單裡（名單不是空的）', () => {
  // ⚠️ 兩邊都空的話 ① 也會過——這條擋的是「規則整個消失」那種壞法。
  assert.ok(needsTc('assert_visible'), 'assert_visible 應該要指定 TC')
  assert.ok(needsTc('screenshot'), 'screenshot 應該要指定 TC')
  assert.ok(!needsTc('goto'), 'goto 是共用前置，不該被要求指定 TC')
  assert.ok(!needsTc('click'), 'click 是操作，不該被要求指定 TC')
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
