/**
 * ② 人員對照猜人規則。跑法：npx tsx shared/meegle-people-match.test.ts
 * 名單形狀照 2026-10-05 真空間掃出來的（name_cn＝name_en、email 前綴不一定等於名字）。
 */
import { filterRoster, matchRoster, type RosterPerson } from './meegle-people-match.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const p = (userKey: string, name: string, email: string): RosterPerson => ({ userKey, email, name, names: [name] })
const tim = p('k-tim', 'Tim', 'tim@toppath.tw')
const eric = p('k-eric', 'Eric', 'eric.wu@toppath.tw')
const albert = p('k-albert', 'Albert Tsai', 'albert.tsai@toppath.tw')
const yen = p('k-yen', 'Yen', 'yenting@toppath.tw')
const roster = [tim, eric, albert, yen]
const brief = (m: ReturnType<typeof matchRoster>) => m.status === 'unique' ? [m.status, m.confidence, m.user.userKey] : m.status === 'ambiguous' ? [m.status, m.confidence, m.users.map(u => u.userKey)] : [m.status]

eq('完整名字相同 → exact', brief(matchRoster('Tim', roster)), ['unique', 'exact', 'k-tim'])
eq('不分大小寫、空白壓縮', brief(matchRoster('  albert   TSAI ', roster)), ['unique', 'exact', 'k-albert'])
eq('Sheet「Eric Wu」、Meegle「Eric」→ 第一個詞 → partial（不能進全部確認）', brief(matchRoster('Eric Wu', roster)), ['unique', 'partial', 'k-eric'])
eq('email 前綴（eric.wu）→ partial', brief(matchRoster('eric.wu', roster)), ['unique', 'partial', 'k-eric'])
eq('「yenting」只對得到 email 前綴 → partial', brief(matchRoster('yenting', roster)), ['unique', 'partial', 'k-yen'])
eq('名字只有一個詞時不拿第一個詞再比一次（Tim 不會因此變 partial）', brief(matchRoster('Tim', roster))[1], 'exact')
eq('都對不到 → none', brief(matchRoster('Nobody', roster)), ['none'])
eq('空字串 → none', brief(matchRoster('  ', roster)), ['none'])

{
  const tim2 = p('k-tim2', 'Tim', 'tim.lin@toppath.tw')
  eq('名單內同名兩人 → ambiguous，不挑一個', brief(matchRoster('Tim', [...roster, tim2])), ['ambiguous', 'exact', ['k-tim', 'k-tim2']])
  const noMail = p('k-tim3', 'Tim', '')
  eq('同名者沒有 email 也算人數 → 仍是 ambiguous（CodeX：先丟掉沒 email 的會把兩人算成唯一）', brief(matchRoster('Tim', [...roster, noMail])), ['ambiguous', 'exact', ['k-tim', 'k-tim3']])
  eq('唯一但沒有 email → 不預填（ambiguous，沒有可選的人）', brief(matchRoster('Zed', [p('k-z', 'Zed', '')])), ['ambiguous', 'exact', ['k-z']])
  eq('沒 email 的人不會因為空前綴被當成 partial 命中', brief(matchRoster('Nobody', [p('k-z', 'Zed', '')])), ['none'])
}
{
  const eric2 = p('k-eric2', 'Eric Wu', 'ericwu@toppath.tw')
  eq('exact 有命中就停，不跟第一個詞（Eric）的結果混在一起', brief(matchRoster('Eric Wu', [...roster, eric2])), ['unique', 'exact', 'k-eric2'])
}

eq('下拉搜尋：名字含關鍵字', filterRoster('al', roster).map(u => u.userKey), ['k-albert'])
eq('下拉搜尋：email 含關鍵字', filterRoster('yenting', roster).map(u => u.userKey), ['k-yen'])
eq('下拉搜尋：空字串回全部', filterRoster('', roster).length, 4)

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
