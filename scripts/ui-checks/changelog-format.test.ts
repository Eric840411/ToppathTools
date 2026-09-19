/**
 * scripts/ui-checks/changelog-format.test.ts
 *
 * 更新日誌一行的解讀（`src/features/changelog/entry-format.ts`）。
 *
 * ## 這在守什麼
 * 使用者回報「日誌開頭變成一堆 `**`，以前的 `feat(uat)` 色塊不見了」。
 * 原因是解讀端的 regex 要求**第一個字元就是 `feat`** 而且**冒號是半形**，
 * 但實際寫出來的是 `✨ **feat(uat)：…**`——三個條件同時被打破，
 * 整行掉進「沒比對到」的分支，於是色塊不見、`**` 原樣印出來。
 *
 * ⚠️ **這種壞法沒有錯誤訊息**：畫面照常渲染，只是變醜、變難讀。
 * 所以用這支把「實際寫得出來的幾種樣子」全部釘住。
 *
 * 範例全部取自 `src/version.ts` 裡**真的存在**的行，不是我想像的格式。
 *
 * 跑法：node scripts/ui-checks/changelog-format.test.ts（Node 24 原生吃 .ts）
 * ⚠️ import 要寫 .ts 副檔名——不寫的話 plain node 會 ERR_MODULE_NOT_FOUND，
 *    而突變測試會把那個錯誤當成「測試紅了」，於是每個突變都「通過」。實際發生過。
 */
import assert from 'node:assert/strict'
import { parseChangeLine, renderInline } from '../../src/features/changelog/entry-format.ts'

const results: Array<{ name: string; ok: boolean }> = []
const check = (name: string, fn: () => void) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('① 舊格式照舊（半形冒號、開頭就是類型）', () => {
  const p = parseChangeLine('feat(uat): 後台錄製新增 KEYPRESS，逐鍵保留 Enter／Escape／Tab')
  assert.equal(p.type, 'feat')
  assert.equal(p.scope, '(uat)')
  assert.ok(p.text.startsWith('後台錄製新增'), p.text)
})

check('② 🚨 新格式：開頭 emoji ＋ `**` 包住 ＋ 全形冒號', () => {
  const p = parseChangeLine('✨ **feat(uat)：H5／PC 腳本可以綁 Lark TC 了（5-1／4：資料模型）。**使用者：「H5 也會有 TC 的概念」')
  assert.equal(p.type, 'feat', '沒認出類型 → 色塊就不見了')
  assert.equal(p.scope, '(uat)')
  assert.equal(p.emoji, '✨')
})

check('② ⚠️ `**` 要補回內容前面，否則會留下一半沒配對的星號', () => {
  const p = parseChangeLine('🚨 **fix(uat)：尋找基準圖沒有執行。**腳本照樣 PASS')
  assert.ok(p.text.startsWith('**'), `實際：${p.text.slice(0, 20)}`)
  // 補回去之後，行內渲染才配得成一組粗體
  const tokens = renderInline(p.text)
  assert.equal(tokens[0].kind, 'bold', JSON.stringify(tokens.slice(0, 2)))
  assert.ok(tokens.some(t => t.kind === 'text' && t.value.includes('腳本照樣 PASS')))
})

check('③ 全形冒號單獨也要認得（中文輸入法下的常態）', () => {
  assert.equal(parseChangeLine('fix(uat)：某個修正').type, 'fix')
})

check('④ 多顆 emoji／帶變體選擇符的也要吃掉', () => {
  const p = parseChangeLine('⚠️ **chore(uat)：某件事**')
  assert.equal(p.type, 'chore')
  assert.equal(p.emoji, '⚠️')
})

check('⑤ 沒有類型標籤的行不要硬套，但行內語法還是要渲染', () => {
  const p = parseChangeLine('⚠️ 這裡原本有兩份 `regex`，改一邊另一邊不會跟著動')
  assert.equal(p.type, undefined, '不該硬湊出一個標籤')
  const tokens = renderInline(p.text)
  assert.ok(tokens.some(t => t.kind === 'code' && t.value === 'regex'), JSON.stringify(tokens))
})

check('⑥ 🚨 沒有配對到結尾的標記要原樣留著，不能把字吃掉', () => {
  // 少字是最難發現的壞法——沒有人會注意到不見的東西
  const only = renderInline('這一行只有一個 ** 星號')
  assert.equal(only.map(t => t.value).join(''), '這一行只有一個 ** 星號')
  const tick = renderInline('反引號 ` 沒有關')
  assert.equal(tick.map(t => t.value).join(''), '反引號 ` 沒有關')
})

check('⑦ 內容不能被吃掉：拆完再接回去要跟原字串一樣', () => {
  const line = '**重點**與 `程式碼` 混在一起，還有**第二段粗體**'
  const back = renderInline(line).map(t => t.kind === 'bold' ? `**${t.value}**` : t.kind === 'code' ? `\`${t.value}\`` : t.value).join('')
  assert.equal(back, line)
})

check('⑧ 類型必須是白名單裡的字，不能把句子開頭誤判成標籤', () => {
  const p = parseChangeLine('feature(uat)：這不是合法類型')
  assert.equal(p.type, undefined, `「feature」不在清單裡，不該被當成 feat：${JSON.stringify(p)}`)
})

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
