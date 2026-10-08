/**
 * Meegle 人員下拉：一個人只出現一次（使用者 1008 Lark：lusa／lusa@toppath.tw 在下拉重複出現）。
 *   npx tsx scripts/ui-checks/meegle-people-options.test.ts
 */
import { meeglePeopleOptions } from '../../src/components/MeeglePeoplePicker'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const people = [
  { alias: 'lusa@toppath.tw', userKey: 'u-lusa', email: 'lusa@toppath.tw', name: 'Lusa' },
  { alias: 'lusa', userKey: 'u-lusa', email: 'lusa@toppath.tw', name: 'Lusa' },
  { alias: 'LusaA', userKey: 'u-lusa', email: 'lusa@toppath.tw', name: 'Lusa' },
  { alias: 'aaron', userKey: 'u-aaron', email: 'aaron@toppath.tw', name: 'Aaron' },
  { alias: 'tim@toppath.tw', userKey: 'u-tim', email: 'tim@toppath.tw', name: 'Tim Chen' },
]
const opts = meeglePeopleOptions(people)
ok(opts.length === 3, '三個人 → 三個選項（同一個 userKey 只留一個）', opts)
const lusa = opts.find(o => /Lusa/.test(o.label))
ok(lusa?.value === 'lusa', '優先留跟名字一樣的寫法（lusa，不是 email）', lusa)
ok(/也寫作 lusa@toppath\.tw、LusaA/.test(lusa?.label ?? ''), '其他寫法列在說明裡', lusa)
const tim = opts.find(o => /Tim/.test(o.label))
ok(tim?.value === 'tim@toppath.tw', '只有 email 寫法時就留 email', tim)
ok(meeglePeopleOptions([{ alias: 'x' }, { alias: 'y' }]).length === 2, '沒有 userKey／email → 各自算一個人（不亂合併）')
ok(meeglePeopleOptions([{ alias: 'a', email: 'A@x.tw' }, { alias: 'b', email: 'a@x.tw' }]).length === 1, '沒有 userKey 時用 email 合併（不分大小寫）')

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)
