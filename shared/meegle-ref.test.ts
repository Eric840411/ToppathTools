/** 跑法：npx tsx shared/meegle-ref.test.ts */
import { parseMeegleRefs } from './meegle-ref.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
eq('純數字、#、網址、混合分隔', parseMeegleRefs('15194994, #15194995\nhttps://project.larksuite.com/3kvkm7/task_normal/detail/15190441?x=1、15191459'),
  { ids: ['15194994', '15194995', '15190441', '15191459'], invalid: [] })
eq('重複只留一次（#15194994 與 15194994 是同一張）', parseMeegleRefs('#15194994 15194994').ids, ['15194994'])
eq('Jira key 不收、明示', parseMeegleRefs('CGSG-220 15194994'), { ids: ['15194994'], invalid: ['CGSG-220'] })
eq('太短的數字不當單號', parseMeegleRefs('1234').invalid, ['1234'])
eq('空白', parseMeegleRefs('  '), { ids: [], invalid: [] })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) throw new Error(`${fail} failed`)
