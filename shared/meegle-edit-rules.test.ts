/**
 * Meegle 批量修改共用規則。跑法：npx tsx shared/meegle-edit-rules.test.ts
 * 選項 id 取自 2026-10-02 `workitem meta-fields --field-keys` 實測。
 */
import { rawEditsForRow, resolveEdit, resolveRow, sameValue, displayCurrent, type ResolveCtx } from './meegle-edit-rules.js'
import { taipeiDayStart } from './meegle-status-rules.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const ctx: ResolveCtx = {
  options: {
    priority: [{ id: 'option_1', name: 'P0' }, { id: 'option_2', name: 'P1' }, { id: 'option_3', name: 'P2' }],
    field_e742d0: [{ id: '6kqyqbz5r', name: '0' }, { id: '9kuyi5kfs', name: '1' }],
    field_07e581: [{ id: 'igshro8ol', name: '重要' }, { id: 'hgw976jdg', name: '次要' }],
  },
  personMap: {
    zen: { userKey: 'u_zen', email: 'zen@toppath.tw', name: 'Zen' },
    'james chang': { userKey: 'u_james', email: 'james@toppath.tw', name: 'James Chang' },
  },
}

// rawEditsForRow
const rec = { 摘要: '新標題', 優先: 'P1', 空白欄: '  ', RD: 'zen' }
eq('Sheet 欄有值 → set', rawEditsForRow(rec, { name: { mode: 'sheet', column: '摘要' } }), [{ key: 'name', op: 'set', raw: '新標題' }])
eq('Sheet 欄空白 → 不改（不是清空）', rawEditsForRow(rec, { priority: { mode: 'sheet', column: '空白欄' } }), [])
eq('不修改 → 不出現', rawEditsForRow(rec, { priority: { mode: 'skip' } }), [])
eq('固定值', rawEditsForRow(rec, { priority: { mode: 'fixed', value: 'P0' } }), [{ key: 'priority', op: 'set', raw: 'P0' }])
eq('明確清空', rawEditsForRow(rec, { field_f6b7ab: { mode: 'clear' } }), [{ key: 'field_f6b7ab', op: 'clear' }])
eq('任務名稱不能清空 → 設了也不出現', rawEditsForRow(rec, { name: { mode: 'clear' } }), [])

// resolveEdit
eq('單選：名稱 → option_id', resolveEdit({ key: 'priority', op: 'set', raw: ' P1 ' }, ctx), { ok: true, edit: { key: 'priority', kind: 'select', value: 'option_2', display: 'P1' } })
eq('單選：退件 0（數字名稱）', resolveEdit({ key: 'field_e742d0', op: 'set', raw: '0' }, ctx).ok, true)
eq('單選：對不到 → 擋', resolveEdit({ key: 'priority', op: 'set', raw: 'P5' }, ctx).ok, false)
eq('日期 → 台北 00:00 毫秒字串', resolveEdit({ key: 'field_cbc597', op: 'set', raw: '2026/09/15' }, ctx), { ok: true, edit: { key: 'field_cbc597', kind: 'date', value: String(taipeiDayStart(2026, 9, 15)), display: '2026/09/15' } })
eq('日期看不懂 → 擋', resolveEdit({ key: 'field_cbc597', op: 'set', raw: '9/15' }, ctx).ok, false)
eq('人員：多人、暱稱不分大小寫', resolveEdit({ key: 'role:rdOwner', op: 'set', raw: 'ZEN, James  Chang' }, ctx), { ok: true, edit: { key: 'role:rdOwner', kind: 'role', userKeys: ['u_zen', 'u_james'], display: 'Zen、James Chang' } })
eq('人員：有一個對不到 → 擋整欄（不是少放一個人）', resolveEdit({ key: 'role:rdOwner', op: 'set', raw: 'zen, Tim' }, ctx).ok, false)
eq('人員：清空＝空陣列', resolveEdit({ key: 'role:reporter', op: 'clear' }, ctx), { ok: true, edit: { key: 'role:reporter', kind: 'role', userKeys: [], display: '（清空）' } })
eq('清空一般欄位＝""', resolveEdit({ key: 'field_f6b7ab', op: 'clear' }, ctx), { ok: true, edit: { key: 'field_f6b7ab', kind: 'text', value: '', display: '（清空）' } })
eq('任務名稱清空 → 擋', resolveEdit({ key: 'name', op: 'clear' }, ctx).ok, false)
eq('不支援的欄位 → 擋', resolveEdit({ key: 'field_xxx', op: 'set', raw: 'a' }, ctx).ok, false)

// resolveRow：有一欄換不出來就整列擋
const row = resolveRow([{ key: 'priority', op: 'set', raw: 'P1' }, { key: 'role:rdOwner', op: 'set', raw: 'Tim' }], ctx)
eq('整列：一欄錯 → issues 有它、仍列出換得出來的', [row.edits.length, row.issues.length], [1, 1])

// sameValue
eq('sameValue：角色不看順序', sameValue({ key: 'role:rdOwner', kind: 'role', userKeys: ['a', 'b'], display: '' }, ['b', 'a']), true)
eq('sameValue：日期比台北日', sameValue({ key: 'field_cbc597', kind: 'date', value: String(taipeiDayStart(2026, 9, 15)), display: '' }, String(taipeiDayStart(2026, 9, 15) + 3600_000)), true)
eq('sameValue：清空日期', sameValue({ key: 'field_cbc597', kind: 'date', value: '', display: '' }, ''), true)
eq('sameValue：多行文字不看空白', sameValue({ key: 'description', kind: 'multi', value: 'a\nb', display: '' }, 'a\n\nb '), true)
eq('sameValue：文字不同', sameValue({ key: 'field_f6b7ab', kind: 'text', value: 'x', display: '' }, 'y'), false)

// displayCurrent
eq('顯示：單選 id → 名稱', displayCurrent('priority', 'option_3', { options: ctx.options }), 'P2')
eq('顯示：空白', displayCurrent('field_f6b7ab', '', { options: ctx.options }), '（空白）')
eq('顯示：角色 user_key → 名字', displayCurrent('role:rdOwner', ['u_zen'], { options: ctx.options, people: { u_zen: 'Zen' } }), 'Zen')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) throw new Error(`${fail} failed`)
