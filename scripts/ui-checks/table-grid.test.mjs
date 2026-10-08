/**
 * read_table 的表格網格（1008，vipUpgradeSetting 兩層表頭＋rowspan 讀錯欄）。
 *   node scripts/ui-checks/table-grid.test.mjs
 */
import { buildTableGrid, pickKeyColumn } from '../../server/uat-runner/table-grid.js'

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }
const C = (text, colspan, rowspan) => ({ text, colspan, rowspan })

// 真案例：CP 後台 /rewardPoints/vipUpgradeSetting
const head = [
  [C('Level', 1, 2), C('Upgrade', 2), C('Relegation', 2)],
  [C('Cycle'), C('Amount'), C('Cycle'), C('Amount')],
]
const body = [
  [C('Platinum'), C('Month', 1, 4), C('1,000'), C('Day', 1, 4), C('300')],
  [C('Diamond'), C('5,000'), C('2,500')],
  [C('Crown'), C('10,000'), C('5,000')],
  [C('Royal'), C('50,000'), C('25,000')],
]
const g = buildTableGrid(head, body)
ok(JSON.stringify(g.columns) === '["Level","Upgrade Cycle","Upgrade Amount","Relegation Cycle","Relegation Amount"]', '兩層表頭攤平成 Upgrade Cycle／Upgrade Amount／Relegation Cycle／Relegation Amount', g.columns)
ok(g.rows[0]['Upgrade Amount'] === '1,000' && g.rows[0]['Relegation Amount'] === '300', 'Platinum：1,000 是 Upgrade Amount、300 是 Relegation Amount（原本 Relegation 讀成 1,000）', g.rows[0])
ok(g.rows[1]['Upgrade Cycle'] === 'Month' && g.rows[1]['Relegation Cycle'] === 'Day' && g.rows[1]['Upgrade Amount'] === '5,000' && g.rows[1]['Relegation Amount'] === '2,500', 'Diamond：rowspan 的 Cycle 補上同一個值，Amount 對到正確的欄', g.rows[1])
ok(g.rows[3]['Relegation Amount'] === '25,000' && g.rows.every(r => Object.keys(r).length === 5), '最後一列也對、每列都是 5 欄', g.rows[3])

// 一層表頭：欄名跟原本一樣（不影響既有腳本）
const flat = buildTableGrid([[C('Name'), C('Value')]], [[C('a'), C('1')], [C('b'), C('2')]])
ok(JSON.stringify(flat.columns) === '["Name","Value"]' && flat.rows[1].Value === '2', '一層表頭：欄名不變')
// 空欄名 col<序號>、重複欄名加 #2、表身比表頭寬 → col<序號>
const odd = buildTableGrid([[C('A'), C(''), C('A')]], [[C('1'), C('2'), C('3'), C('4')]])
ok(JSON.stringify(odd.columns) === '["A","col1","A #2","col3"]' && odd.rows[0]['A #2'] === '3' && odd.rows[0].col3 === '4', '空欄名 col1、重複欄名 A #2、多出來的格 col3', odd)
// 表身 colspan：值放第一欄、其餘空字串
const cs = buildTableGrid([[C('X'), C('Y'), C('Z')]], [[C('merged', 2), C('z')]])
ok(cs.rows[0].X === 'merged' && cs.rows[0].Y === '' && cs.rows[0].Z === 'z', '表身 colspan：值放第一欄，後面的欄不吃錯位', cs.rows[0])
// rowspan 超出表格範圍不會長出幽靈列
const over = buildTableGrid([[C('A'), C('B')]], [[C('x', 1, 9), C('1')], [C('2')]])
ok(over.rows.length === 2 && over.rows[1].A === 'x' && over.rows[1].B === '2', 'rowspan 超過剩下的列數 → 不長出多的列', over.rows)
// CodeX：#2 要避開既有同名欄位；套別名（去掉空白與符號）之後也要唯一
const alias = nm => String(nm).replace(/[^\w$]/g, '')
const dup = buildTableGrid([[C('A'), C('A #2'), C('A')]], [[C('1'), C('2'), C('3')]], { aliasKey: alias })
ok(new Set(dup.columns).size === 3 && dup.columns[1] === 'A #2' && dup.rows[0][dup.columns[2]] === '3' && dup.columns[2] === 'A #3', '已經有一欄叫「A #2」→ 重複的 A 改叫 A #3', dup.columns)
const al = buildTableGrid([[C('Up Amount'), C('UpAmount')]], [[C('1'), C('2')]], { aliasKey: alias })
ok(new Set(al.columns.map(alias)).size === 2 && al.rows[0][al.columns[1]] === '2', '別名會撞（Up Amount／UpAmount）→ 後面那欄改名，兩欄都能唯一引用', al.columns)
// CodeX 0793271 [P2]：純中文欄名的別名是空字串 → 不參與占用與匹配
const zh = buildTableGrid([[C('姓名'), C('金額')]], [[C('王'), C('100')]], { aliasKey: alias })
ok(JSON.stringify(zh.columns) === '["姓名","金額"]' && zh.rows[0]['金額'] === '100', '中文欄名不被改名（空別名不算撞名）', zh.columns)
ok(pickKeyColumn(zh.columns, '金額', alias).col === '金額', 'keyColumn=金額 → 選到金額（不是姓名）', pickKeyColumn(zh.columns, '金額', alias))
const miss = pickKeyColumn(zh.columns, '不存在', alias)
ok(miss.col === null && miss.ambiguous.length === 0, 'keyColumn=不存在 → 找不到（不會亂選第一欄）', miss)
// 缺格補空字串，不左移
const short = buildTableGrid([[C('A'), C('B'), C('C')]], [[C('1')]])
ok(short.rows[0].A === '1' && short.rows[0].B === '' && short.rows[0].C === '', '一列格子比表頭少 → 缺的補空字串', short.rows[0])
// 沒有表頭
const none = buildTableGrid([], [[C('a'), C('b')]])
ok(JSON.stringify(none.columns) === '["col0","col1"]', '沒有表頭 → col0、col1（跟原本一樣）', none.columns)

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
