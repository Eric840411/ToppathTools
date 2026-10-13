/**
 * shared/ideck-xpath 的單元測試（v5.50.0）。跑法：npx tsx shared/ideck-xpath.test.ts
 * 守的是「開頭多一個 b 這種錯字存不進去」（LIONLINK ideckXpaths[2]、SQUIDGAME 第 7 條都出過）。
 */
import { ideckXpathProblem, ideckXpathProblems } from './ideck-xpath.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

// 實際用過的寫法都要過
for (const x of ['//div[@class="btn_bet"][3]', '(//div[contains(@class,"btn_bet")])[2]', '/html/body/div[2]//span[text()="BET 18"]', "//*[@id='b0']", '  //div[1]  ']) ok(ideckXpathProblem(x) === null, `合法：${x.trim()}`, ideckXpathProblem(x))
// 1013 的錯字
ok(/開頭必須是/.test(ideckXpathProblem('b//div[@class="btn_bet"][3]') ?? ''), '⚠️ 開頭多一個 b（LIONLINK／SQUIDGAME 的錯字）→ 擋', ideckXpathProblem('b//div'))
ok(/開頭必須是/.test(ideckXpathProblem('div[1]') ?? ''), '相對路徑沒有 / → 擋')
ok(ideckXpathProblem('   ') === '是空的', '空白 → 擋')
ok(/沒有關/.test(ideckXpathProblem('//div[@class="a"') ?? ''), '中括號沒關 → 擋')
ok(/沒有關/.test(ideckXpathProblem('//div[@class="a]') ?? ''), '引號沒關 → 擋')
ok(/沒有對應/.test(ideckXpathProblem('//div)[1]') ?? ''), '多一個右括號 → 擋')
ok(ideckXpathProblem('//div[text()="a)b[c"]') === null, '引號裡的括號不算')
// 清單：指出第幾條
ok(JSON.stringify(ideckXpathProblems(['//a', 'b//c', '//d']).map(x => x.index)) === '[2]', '清單指出是第 2 條', ideckXpathProblems(['//a', 'b//c', '//d']))

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)
