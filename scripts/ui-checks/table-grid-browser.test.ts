/**
 * read_table 在真瀏覽器裡（1008，CodeX）：同頁多張表只讀選到的那張；Element UI 表頭／表身拆兩張 table 用同一個容器配對；
 * vipUpgradeSetting 兩層表頭＋rowspan；keyColumn 精確優先、歧義報錯。
 *   npx tsx scripts/ui-checks/table-grid-browser.test.ts
 */
import { chromium } from 'playwright'
import { buildTableGrid, TABLE_CELLS_IN_PAGE, pickKeyColumn } from '../../server/uat-runner/table-grid.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }
const alias = (nm: string) => String(nm).replace(/[^\w$]/g, '')

const html = `<!doctype html><body>
<div class="el-table" id="other">
  <div class="el-table__header-wrapper"><table class="el-table__header"><thead><tr><th>Name</th><th>Score</th><th class="gutter"></th></tr></thead></table></div>
  <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr><td>noise</td><td>999</td></tr></tbody></table></div>
</div>
<div class="el-table" id="vip">
  <div class="el-table__header-wrapper"><table class="el-table__header"><thead>
    <tr><th rowspan="2">Level</th><th colspan="2">Upgrade</th><th colspan="2">Relegation</th><th class="gutter"></th></tr>
    <tr><th>Cycle</th><th>Amount</th><th>Cycle</th><th>Amount</th></tr>
  </thead></table></div>
  <div class="el-table__body-wrapper"><table class="el-table__body"><tbody>
    <tr><td>Platinum</td><td rowspan="4">Month</td><td>1,000</td><td rowspan="4">Day</td><td>300</td></tr>
    <tr><td>Diamond</td><td>5,000</td><td>2,500</td></tr>
    <tr><td>Crown</td><td>10,000</td><td>5,000</td></tr>
    <tr><td>Royal</td><td>50,000</td><td>25,000</td></tr>
  </tbody></table></div>
  <div class="el-table__fixed"><table class="el-table__header"><thead><tr><th>Level</th></tr></thead></table></div>
</div>
<table id="plain"><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>
</body>`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(html)
  const read = async (sel: string) => {
    const h = await page.locator(sel).first().elementHandle()
    const raw = await page.evaluate(TABLE_CELLS_IN_PAGE as (p: { table: Element | null; maxRows: number }) => { headerRows: never[][]; bodyRows: never[][] } | null, { table: h, maxRows: 200 })
    return raw ? buildTableGrid(raw.headerRows, raw.bodyRows, { aliasKey: alias }) : null
  }
  const vip = await read('#vip table.el-table__body')
  ok(JSON.stringify(vip?.columns) === '["Level","Upgrade Cycle","Upgrade Amount","Relegation Cycle","Relegation Amount"]', '同頁兩張 Element UI 表：只讀選到的那張，表頭用同容器那張配對（不混到 #other、不吃固定欄複本）', vip?.columns)
  const plat = vip?.rows.find(r => r.Level === 'Platinum')
  ok(plat?.['Upgrade Amount'] === '1,000' && plat?.['Relegation Amount'] === '300' && plat?.['Upgrade Cycle'] === 'Month', 'Platinum：Upgrade Amount＝1,000、Relegation Amount＝300', plat)
  const dia = vip?.rows.find(r => r.Level === 'Diamond')
  ok(dia?.['Upgrade Cycle'] === 'Month' && dia?.['Upgrade Amount'] === '5,000' && dia?.['Relegation Cycle'] === 'Day' && dia?.['Relegation Amount'] === '2,500', 'Diamond：rowspan 補值、Amount 對到正確的欄', dia)
  ok(vip?.rows.length === 4, '列數正確（4 列）', vip?.rows.length)
  const other = await read('#other table.el-table__header')
  ok(JSON.stringify(other?.columns) === '["Name","Score"]' && other?.rows.length === 1 && other.rows[0].Score === '999', '選表頭那張也會配對到同容器的表身（gutter 欄不算）', other)
  const plain = await read('#plain')
  ok(JSON.stringify(plain?.columns) === '["Item","Qty"]' && plain?.rows[1].Qty === '2', '一般 table：單層表頭欄名不變', plain)

  // keyColumn
  const cols = vip!.columns
  ok(pickKeyColumn(cols, 'Level', alias).col === 'Level', 'keyColumn 完全相同 → 那一欄')
  ok(pickKeyColumn(cols, 'upgradeamount', alias).col === 'Upgrade Amount', 'keyColumn 用去空格的別名也對得到')
  const amb = pickKeyColumn(cols, 'Upgrade', alias)
  ok(amb.col === null && 'ambiguous' in amb && amb.ambiguous.length === 2, '只寫 Upgrade → 對到兩欄，報歧義（不默默取第一欄）', amb)
  ok(pickKeyColumn(['Name', 'Name Long'], 'Name', alias).col === 'Name', '完全相同優先於包含（Name 不會被 Name Long 搶走）')
  ok(pickKeyColumn(cols, 'Lev', alias).col === 'Level', '只有一欄包含 → 照舊用包含比對')
} finally { await browser.close() }
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
