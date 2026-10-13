/**
 * H5／PC 腳本存檔的 steps 欄位（v5.49.3，CodeX 1013）：沒帶不能清光、型別不對整筆不更新。
 * 用記憶體 SQLite 跑**產品的** frontend-script-steps.ts（handler 直接呼叫它）。
 *
 *   npx tsx scripts/ui-checks/frontend-script-steps.test.ts
 */
import Database from 'better-sqlite3'
import { parseStepsInput, updateFrontendScript, StepsInputError } from '../../server/frontend-script-steps.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const db = new Database(':memory:')
db.exec(`CREATE TABLE frontend_auto_scripts (id TEXT PRIMARY KEY, name TEXT, platform TEXT, steps TEXT, updated_at INTEGER, lark_url TEXT, table_id TEXT, bindings TEXT)`)
const STEPS = JSON.stringify([{ action: 'goto', url: 'https://x' }, { action: 'click', selector: '#a' }, { action: 'assert_text', text: 'ok' }])
const reset = () => { db.exec('DELETE FROM frontend_auto_scripts'); db.prepare('INSERT INTO frontend_auto_scripts VALUES (?,?,?,?,?,?,?,?)').run('S1', '原名', 'h5', STEPS, 1, 'https://lark/old', 'tblOld', '[]') }
const row = () => db.prepare('SELECT * FROM frontend_auto_scripts WHERE id = ?').get('S1') as Record<string, unknown>
const base = { name: '新名', platform: 'h5', updatedAt: 2, larkUrl: 'https://lark/new', tableId: 'tblNew', bindings: '[{"tc":"T-A-011"}]' }

// 省略 steps → 保留原值（其他欄位照常更新）——這是 1013 那個坑
reset(); updateFrontendScript(db, 'S1', { ...base, steps: undefined })
ok(row().steps === STEPS, '⚠️ 沒帶 steps → 步驟保留，不會被清成 []', row().steps)
ok(row().table_id === 'tblNew' && row().name === '新名', '沒帶 steps 時其他欄位照常更新（改綁定的情境）', row())

// 明確清空／替換
reset(); updateFrontendScript(db, 'S1', { ...base, steps: [] })
ok(row().steps === '[]', '明確傳 [] → 清空', row().steps)
reset(); updateFrontendScript(db, 'S1', { ...base, steps: [{ action: 'click', selector: '#b' }] })
ok(row().steps === '[{"action":"click","selector":"#b"}]', '合法陣列 → 替換', row().steps)
reset(); updateFrontendScript(db, 'S1', { ...base, steps: '[{"action":"click"}]' })
ok(row().steps === '[{"action":"click"}]', 'JSON 陣列字串 → 沿用舊支援', row().steps)

// 非法值 → 丟錯，整筆完全沒變
for (const [label, bad] of [['null', null], ['物件', { a: 1 }], ['數字', 3], ['布林', true], ['壞掉的字串', '[{'], ['字串但不是陣列', '{"a":1}']] as const) {
  reset(); const before = JSON.stringify(row())
  let threw: unknown = null
  try { updateFrontendScript(db, 'S1', { ...base, steps: bad }) } catch (e) { threw = e }
  ok(threw instanceof StepsInputError && JSON.stringify(row()) === before, `steps 是${label} → 400（StepsInputError），整筆沒有更新`, { threw: String(threw), row: row() })
}

// POST：沒帶＝新腳本空陣列；非法值一樣擋
ok(parseStepsInput(undefined, 'empty') === '[]', 'POST 沒帶 steps → 新腳本 []')
ok((() => { try { parseStepsInput(null, 'empty'); return false } catch (e) { return e instanceof StepsInputError } })(), 'POST steps 是 null → 擋（原本會靜默變 []）')

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)
