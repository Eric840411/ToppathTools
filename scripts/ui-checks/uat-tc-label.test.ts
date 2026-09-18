/**
 * scripts/ui-checks/uat-tc-label.test.ts
 *
 * TC 在畫面上的短標籤（`BlockEditor.tsx` 的 `tcShortLabel`）。
 *
 * ## 為什麼有這支
 * 使用者問「做完有沒有自己測過」之後，我去**拉了一次真的 Lark 表**
 * （`/api/osm-uat/scan`，100 筆）來對我寫的 parser。對完發現兩件事，
 * 兩件都是**照印象寫、沒對過真實資料**造成的：
 *
 *   ① 我讀 `tc.task ?? tc.text`——**回應裡根本沒有 `task` 這個欄位**，
 *      敘述叫 `text`。靠 `??` 的 fallback 蓋住了，所以功能是對的，但那行是死的。
 *   ② 標籤用 `binding?.number ?? recordId.slice(0,8)`——**`??` 不接空字串**。
 *      而實測 100 筆裡 **14 筆的 `number` 是空的**，那些會渲染出一個**空標籤**：
 *      看起來像「這一步沒歸屬 TC」，實際上它有。
 *
 * 另外實測 **16 個編號是重複的**（同一個 T-A-001 有兩筆不同 recordId），
 * 所以編號不能當唯一識別，只能當顯示用。
 *
 * ⚠️ 這支用的範例直接取自那份真表的形狀，不是我想像出來的。
 *
 * 跑法：npx tsx scripts/ui-checks/uat-tc-label.test.ts
 */
import assert from 'node:assert/strict'
import { tcShortLabel, type TcBindingOption } from '../../src/features/uat/BlockEditor'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 取自真表的三種實際形狀 */
const NORMAL: TcBindingOption = { recordId: 'recvu9kb73q7X7', number: 'T-A-001', text: '從CP進OSM的JP彈框，確認PLAY跟撥放可正常使用' }
const NO_NUMBER: TcBindingOption = { recordId: 'recABCDEFGHIJK', number: '', text: '機台內 BET 切換後金額顯示正確' }
const NO_NUMBER_NO_TEXT: TcBindingOption = { recordId: 'recZZZZZZZZZZZ', number: '', text: '' }

check('① 有編號就顯示編號', () => {
  assert.equal(tcShortLabel(NORMAL, NORMAL.recordId), 'T-A-001')
})

check('② 🚨 沒有編號時不能顯示成空白（實測 100 筆裡有 14 筆沒編號）', () => {
  const label = tcShortLabel(NO_NUMBER, NO_NUMBER.recordId)
  assert.notEqual(label.trim(), '', '空標籤看起來像「這一步沒歸屬 TC」，但它其實有')
  assert.ok(label.length <= 12, `標籤太長會撐破那一格：${label}`)
  assert.ok(NO_NUMBER.text.startsWith(label), `應該用敘述開頭當標籤，實際是「${label}」`)
})

check('② 連敘述也沒有時退回 recordId，還是不能空白', () => {
  const label = tcShortLabel(NO_NUMBER_NO_TEXT, NO_NUMBER_NO_TEXT.recordId)
  assert.notEqual(label.trim(), '')
  assert.ok(NO_NUMBER_NO_TEXT.recordId.startsWith(label))
})

check('③ 綁定已失效（那筆 TC 被刪或換表）要講出來，不是留白', () => {
  const label = tcShortLabel(undefined, 'recGONE1234567')
  assert.match(label, /失效/, '留白的話使用者會以為只是沒綁')
  assert.match(label, /recGONE/, '要帶上 id 才查得到是哪一筆')
})

check('④ ⚠️ 編號不是唯一的（實測有 16 個重複）——標籤只能當顯示用', () => {
  // 兩筆不同的 TC 共用同一個編號，標籤會一樣。這是**可接受的**，
  // 因為清單那邊同時顯示敘述；但任何拿標籤當 key／當識別的寫法都是錯的。
  const a: TcBindingOption = { recordId: 'rec111', number: 'T-A-002', text: '第一種情境' }
  const b: TcBindingOption = { recordId: 'rec222', number: 'T-A-002', text: '第二種情境' }
  assert.equal(tcShortLabel(a, a.recordId), tcShortLabel(b, b.recordId))
  assert.notEqual(a.recordId, b.recordId)
})

check('⑤ 很長的敘述要截斷（實測最長 244 字）', () => {
  const long: TcBindingOption = { recordId: 'rec333', number: '', text: '一'.repeat(244) }
  assert.ok(tcShortLabel(long, long.recordId).length <= 12)
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
