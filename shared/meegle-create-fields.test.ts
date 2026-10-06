/**
 * 開單「其他欄位」規則測試。跑法：npx tsx shared/meegle-create-fields.test.ts
 * 選項取自 2026-10-06 測試空間實際值（scripts/meegle-create-extras-live-check.ts 實開 #15245280 全部欄位讀回一致）。
 */
import { CREATE_EXTRA_FIELDS, resolveCreateExtras } from './meegle-create-fields.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(name); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const opts = {
  priority: [{ id: 'option_1', name: 'P0' }, { id: '428irx56r', name: 'P4' }],
  field_9a3fe4: [{ id: 'py__w_55_', name: '簡單' }],
  field_07e581: [{ id: '81nqnpmsf', name: '沒有反應' }],
  field_710be5: [{ id: '4o7exmoxt', name: '簡單' }],
  field_e742d0: [{ id: '6kqyqbz5r', name: '0' }],
}

eq('欄位清單：不含名稱／描述／人員／測試說明', CREATE_EXTRA_FIELDS.some(f => ['name', 'description', 'field_89ff93'].includes(f.key) || f.kind === 'role'), false)
{
  const r = resolveCreateExtras({ priority: 'P4', field_cbc597: '2026/09/28', field_f6b7ab: ' https://g/1 ', field_1ab2a7: '' }, opts)
  eq('select 換成 option_id、日期換成台北 00:00 毫秒、文字去頭尾空白；空白不送', r.fields, [
    { field_key: 'priority', field_value: '428irx56r' }, { field_key: 'field_cbc597', field_value: '1790524800000' }, { field_key: 'field_f6b7ab', field_value: 'https://g/1' }])
  eq('沒問題', r.issues, [])
}
eq('選項不存在 → 擋（不猜、不略過）', resolveCreateExtras({ priority: 'P9' }, opts).issues.length, 1)
eq('日期看不懂 → 擋', resolveCreateExtras({ field_ce2cfc: '下週一' }, opts).issues.length, 1)
eq('不認得的欄位 → 擋（後端不收前端亂塞的 key）', resolveCreateExtras({ field_89ff93: 'x' }, opts).issues, ['不支援的欄位 field_89ff93'])
eq('讀不到選項 → 單選欄擋', resolveCreateExtras({ field_9a3fe4: '簡單' }, {}).issues.length, 1)
eq('什麼都沒填 → 什麼都不送', resolveCreateExtras(undefined, opts), { fields: [], display: [], issues: [] })
// 關聯任務（2026-10-06 實測：只收數字陣列 JSON `[15244721,15245280]`）
eq('關聯任務：#、逗號、頓號、空白都收，去重，變數字陣列', resolveCreateExtras({ field_a064e5: '#15244721, 15245280、15244721' }, opts).fields, [{ field_key: 'field_a064e5', field_value: '[15244721,15245280]' }])
eq('關聯任務：有一個不是單號 → 整欄擋', resolveCreateExtras({ field_a064e5: '15244721, abc' }, opts).issues.length, 1)

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) process.exit(1)
