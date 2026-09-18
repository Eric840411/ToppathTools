/**
 * scripts/ui-checks/uat-step-tc.test.ts
 *
 * 驗積木的「所屬 TC」欄位活得過一次存檔（`src/features/uat/step-model.ts`）。
 *
 * ## 為什麼要單獨一支
 * 後端的 `POST /api/frontend-auto/scripts` **原樣收下 steps**（`jsonSteps` 只做
 * JSON 檢查），所以打 API 的那支測試**驗不到白名單**——白名單漏掉 `tcId` 的時候
 * 它照樣會綠。真正會掉欄位的地方在前端 `serializeSteps()` 存檔那一刻。
 *
 * 那個坑 `step-model.ts` 自己的註解就寫著：漏了的話**步驟在畫面上編得好好的，
 * 存檔之後參數消失，而且不會有任何錯誤**——要重新載入才發現變空的。
 * 對 `tcId` 來說症狀更晚才出現：積木還在、還會跑，只是跑完**回寫不到任何一筆 TC**。
 *
 * ⚠️ 這支跟畫面 import 同一份實作，不是在測試裡重寫一份規則。
 *
 * 跑法：npx tsx scripts/ui-checks/uat-step-tc.test.ts
 */
import assert from 'node:assert/strict'
import { createStep, serializeSteps, parseSteps } from '../../src/features/uat/step-model'
import type { AutoStep } from '../../src/features/uat/types'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const withTc = (action: string, tcId?: string): AutoStep => ({ ...createStep(action), tcId })

check('① 標了 TC 的積木，存檔之後 tcId 還在', () => {
  const json = serializeSteps([withTc('assert_visible', 'recABC')])
  assert.equal(JSON.parse(json)[0].tcId, 'recABC', `序列化結果：${json}`)
})

check('① 存完再讀回來也還在（parse ↔ serialize 對得起來）', () => {
  const back = parseSteps(serializeSteps([withTc('assert_api_called', 'recXYZ')]))
  assert.equal(back[0]?.tcId, 'recXYZ')
})

check('② 沒標 TC 的共用步驟不會被塞一個空字串進去', () => {
  const row = JSON.parse(serializeSteps([createStep('goto')]))[0]
  assert.ok(!('tcId' in row), `不該有 tcId，實際：${JSON.stringify(row)}`)
})

check('② 只有空白的 tcId 等於沒標（不能變成一個綁不到東西的假 ID）', () => {
  const row = JSON.parse(serializeSteps([withTc('screenshot', '   ')]))[0]
  assert.ok(!('tcId' in row), JSON.stringify(row))
})

check('③ 🚨 群組／迴圈裡面的積木也要留住 tcId（子步驟走的是另一條路徑）', () => {
  // ⚠️ `cleanStep` 對 children 是遞迴呼叫自己，所以理論上一定會留——
  //    但「理論上一定會」正是上次 find_baseline_scroll 出事前的說法。
  //    檢查類的積木最常就是包在群組裡，掉了的話整組都回寫不到。
  const group: AutoStep = { ...createStep('group'), children: [withTc('assert_visible', 'recInner')] }
  const row = JSON.parse(serializeSteps([group]))[0]
  assert.equal(row.children?.[0]?.tcId, 'recInner', JSON.stringify(row))
})

check('④ 一份腳本裡不同積木可以標不同 TC（Backend 就是這個模式）', () => {
  const rows = JSON.parse(serializeSteps([
    createStep('goto'),
    withTc('assert_visible', 'rec1'),
    withTc('assert_visible', 'rec2'),
  ]))
  assert.deepEqual(rows.map((r: { tcId?: string }) => r.tcId), [undefined, 'rec1', 'rec2'])
})

/**
 * ⑤ 這一條是**寫這支測試時當場抓到的既有 bug**：`snippetId`（後台設定積木要跑哪一份）
 *    只加進了「寫出去」那份白名單，「讀回來」那份沒加。
 *
 *    症狀：存完一切正常，重新載入頁面後那顆積木還在、還會跑，但**不知道要跑哪一份片段**。
 *    資料庫裡明明看得到 snippetId，所以查起來會往後端方向找——找錯地方。
 */
check('⑤ 🚨 snippetId 也要讀得回來（白名單有兩份，只補一份等於沒補）', () => {
  const step: AutoStep = { ...createStep('backend_snippet'), snippetId: 'snip-123' }
  assert.equal(JSON.parse(serializeSteps([step]))[0].snippetId, 'snip-123', '存不進去')
  assert.equal(parseSteps(serializeSteps([step]))[0]?.snippetId, 'snip-123', '存得進去但讀不回來')
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
