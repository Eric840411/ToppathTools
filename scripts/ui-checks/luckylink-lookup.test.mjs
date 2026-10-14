// scripts/ui-checks/luckylink-lookup.test.mjs — 測前檢查 LuckyLink 三態（mock，不打真 API）
// 跑法：node scripts/ui-checks/luckylink-lookup.test.mjs
import { lookupLuckyLink, LL_ONE_PAGE_SIZE } from '../machine-test/luckylink-lookup.mjs'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`) }
const ok = (items) => ({ code: 20000, data: { items } })
// 真實回應（osm-qa-agent 1013，HTTP 200）；成功的 code／欄位還在等真的回應確認
const TIMEOUT = { code: 40000, message: 'luckylink server exception:exception_message=Operation timed out' }
const item = (gmid, extra = {}) => ({ gmid, sasversion: '602', clientversion: '1.1.6', isactive: 1, state: 1, groupName: 'G', ...extra })
const st = (r, code) => r.status.get(code.toUpperCase())

/** 假的 egmList：全表一律逾時（除非 fullOk），單台照 db 依 machineNumber 模糊比對（含字串）＋分頁 */
function mock(db, { fullOk = false, single = {} } = {}) {
  const calls = []
  const fetchPage = async (b) => {
    calls.push(b)
    if (!b.machineNumber) {
      if (!fullOk) return TIMEOUT
      return ok(db.slice((b.page - 1) * b.pageSize, b.page * b.pageSize))
    }
    const hook = single[b.machineNumber]
    if (hook) { const r = await hook(b); if (r !== undefined) return r }
    const hits = db.filter(x => x.gmid.split('-').pop().includes(b.machineNumber))
    return ok(hits.slice((b.page - 1) * b.pageSize, b.page * b.pageSize))
  }
  return { fetchPage, calls }
}

// ① 全表失敗 → 逐台查命中
{
  const m = mock([item('873-LIONLINK-0231')])
  const r = await lookupLuckyLink(['873-LIONLINK-0231'], m)
  check('① 全表逾時 → 逐台查命中 found', st(r, '873-LIONLINK-0231')?.state === 'found' && st(r, '873-LIONLINK-0231').item.clientversion === '1.1.6', JSON.stringify([...r.status]))
  check('① errs 寫出全表失敗原因', r.errs.some(e => /全表讀取失敗（40000 .*Operation timed out）/.test(e)), r.errs.join('|'))
  check('① 單台查詢帶機台號 0231', m.calls.some(b => b.machineNumber === '0231' && b.pageSize === LL_ONE_PAGE_SIZE))
}
// ② 跨渠道同號：只認完整 gmid；同號只查一次
{
  const m = mock([item('892-MONEYGONG-0231', { sasversion: '', isactive: 0 }), item('873-LIONLINK-0231')])
  const r = await lookupLuckyLink(['873-LIONLINK-0231', '892-OTHER-0231'], m)
  check('② 同號不同渠道：873 拿到自己那筆', st(r, '873-LIONLINK-0231')?.item?.gmid === '873-LIONLINK-0231')
  check('② 892-OTHER-0231 清單沒有 → absent（不會拿到 892-MONEYGONG-0231）', st(r, '892-OTHER-0231')?.state === 'absent', JSON.stringify(st(r, '892-OTHER-0231')))
  check('② 同一個機台號只查一次', m.calls.filter(b => b.machineNumber === '0231').length === 1, String(m.calls.length))
}
// ③ 第二頁才命中：首頁滿了要續查
{
  const db = [...Array.from({ length: LL_ONE_PAGE_SIZE }, (_, i) => item(`9${String(i).padStart(2, '0')}-X-10231`)), item('873-LIONLINK-0231')]
  const m = mock(db)
  const r = await lookupLuckyLink(['873-LIONLINK-0231'], m)
  check('③ 第二頁命中 → found', st(r, '873-LIONLINK-0231')?.state === 'found', JSON.stringify(st(r, '873-LIONLINK-0231')))
  check('③ 有查第 2 頁', m.calls.some(b => b.machineNumber === '0231' && b.page === 2))
}
// ④ 成功但空結果 → absent（確定不存在）
{
  const r = await lookupLuckyLink(['873-LIONLINK-0999'], mock([]))
  check('④ API 成功、空結果 → absent', st(r, '873-LIONLINK-0999')?.state === 'absent')
  check('④ 沒有「無法確認」', !r.errs.some(e => /無法確認/.test(e)))
}
// ⑤ 單台逾時 → 那台 unknown，其他台照常
{
  const m = mock([item('873-LIONLINK-0231'), item('873-LIONLINK-0232')], { single: { '0232': async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e } } })
  const r = await lookupLuckyLink(['873-LIONLINK-0231', '873-LIONLINK-0232'], m)
  check('⑤ 逾時那台 → unknown（附原因）', st(r, '873-LIONLINK-0232')?.state === 'unknown' && st(r, '873-LIONLINK-0232').why === '逾時', JSON.stringify(st(r, '873-LIONLINK-0232')))
  check('⑤ 其他台不受影響 → found', st(r, '873-LIONLINK-0231')?.state === 'found')
  check('⑤ errs 寫出幾台無法確認', r.errs.some(e => /1 台無法確認/.test(e)), r.errs.join('|'))
}
// ⑥ 單台回業務錯誤 code → unknown（不是 absent）
{
  const r = await lookupLuckyLink(['873-LIONLINK-0231'], mock([item('873-LIONLINK-0231')], { single: { '0231': async () => TIMEOUT } }))
  check('⑥ 單台回 40000 → unknown（不能當沒有）', st(r, '873-LIONLINK-0231')?.state === 'unknown' && /40000/.test(st(r, '873-LIONLINK-0231').why))
}
// ⑦ 第二頁失敗 → unknown（不能拿第一頁的結果判沒有）
{
  const db = Array.from({ length: LL_ONE_PAGE_SIZE + 3 }, (_, i) => item(`9${String(i).padStart(2, '0')}-X-10231`))
  const r = await lookupLuckyLink(['873-LIONLINK-0231'], mock(db, { single: { '0231': async (b) => b.page === 2 ? TIMEOUT : undefined } }))
  check('⑦ 第二頁失敗 → unknown', st(r, '873-LIONLINK-0231')?.state === 'unknown', JSON.stringify(st(r, '873-LIONLINK-0231')))
}
// ⑧ 全表成功 → 不逐台查；大小寫不影響
{
  const m = mock([item('873-LionLink-0231')], { fullOk: true })
  const r = await lookupLuckyLink(['873-LIONLINK-0231', '873-LIONLINK-0999'], m)
  check('⑧ 全表成功 → found／absent，沒有逐台查', st(r, '873-LIONLINK-0231')?.state === 'found' && st(r, '873-LIONLINK-0999')?.state === 'absent' && !m.calls.some(b => b.machineNumber), JSON.stringify(m.calls.length))
  check('⑧ 全表成功 → 沒有 errs', r.errs.length === 0)
}
// ⑨ code 成功但 data 欄位缺失／格式異常 → unknown（不能預設成空陣列判 absent；CodeX 1013）
for (const [label, bad] of [['沒有 data', { code: 20000 }], ['data.items 不是陣列', { code: 20000, data: { items: null } }], ['data 是字串', { code: 20000, data: 'x' }]]) {
  const r = await lookupLuckyLink(['873-LIONLINK-0231'], mock([], { single: { '0231': async () => bad } }))
  check(`⑨ ${label} → unknown`, st(r, '873-LIONLINK-0231')?.state === 'unknown', JSON.stringify(st(r, '873-LIONLINK-0231')))
}

// ⑩ 真的回應（osm-qa-agent 1013 QAT 唯讀抓取，fixtures/luckylink/egmlist-1013.json）：成功 code＝20000（數字）、空結果＝items:[]＋total:0；
//    machineNumber 是**跨渠道的子字串比對**（0231 也撈到 892-COINCOMBO-0231）→ 只能用完整 gmid 認
{
  const fs = await import('node:fs'), path = await import('node:path'), { fileURLToPath } = await import('node:url')
  const real = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'luckylink', 'egmlist-1013.json'), 'utf8'))
  const hit = real['hit-0231'].response, empty = real['empty-nomatch'].response
  check('⑩ 前提：真的成功回應 code 是數字 20000、空結果是 items:[]＋total:0', hit.code === 20000 && empty.code === 20000 && Array.isArray(empty.data.items) && empty.data.items.length === 0 && empty.data.total === 0)
  const fetchPage = async (b) => !b.machineNumber ? TIMEOUT : b.machineNumber === '0231' ? hit : empty
  const r = await lookupLuckyLink(['873-LIONLINK-0231', '892-OTHER-0231', '873-LIONLINK-0999'], { fetchPage })
  const s231 = st(r, '873-LIONLINK-0231')
  check('⑩ 真回應：873-LIONLINK-0231 找到自己那筆（不是同號的 892-COINCOMBO-0231）', s231?.state === 'found' && s231.item.gmid === '873-LIONLINK-0231' && s231.item.sasversion === '602', JSON.stringify(s231?.item?.gmid))
  check('⑩ 真回應：同號但 gmid 不同（892-OTHER-0231）→ absent', st(r, '892-OTHER-0231')?.state === 'absent', JSON.stringify(st(r, '892-OTHER-0231')))
  check('⑩ 真的空回應 → absent（確定不存在，不是無法確認）', st(r, '873-LIONLINK-0999')?.state === 'absent', JSON.stringify(st(r, '873-LIONLINK-0999')))
}

// ⑪ CodeX e37efbb [P2]：要核對 total，不能只看頁長
{
  const page = (items, total) => ({ code: 20000, data: { items, total } })
  // total=2、只回 1 筆（頁沒滿）→ 不能判不存在
  let r = await lookupLuckyLink(['873-LIONLINK-0231'], { fetchPage: async (b) => !b.machineNumber ? TIMEOUT : page([item('892-COINCOMBO-0231')], 2) })
  check('⑪ ⚠️ total=2、只收到 1 筆 → unknown（回應不完整），不判 absent', st(r, '873-LIONLINK-0231')?.state === 'unknown' && /回應不完整（total 2、只收到 1 筆）/.test(st(r, '873-LIONLINK-0231').why), JSON.stringify(st(r, '873-LIONLINK-0231')))
  // total=21：第 1 頁 20 筆、第 2 頁 1 筆（就是要找的）→ found
  const db = [...Array.from({ length: LL_ONE_PAGE_SIZE }, (_, i) => item(`9${String(i).padStart(2, '0')}-X-10231`)), item('873-LIONLINK-0231')]
  r = await lookupLuckyLink(['873-LIONLINK-0231'], { fetchPage: async (b) => !b.machineNumber ? TIMEOUT : page(db.slice((b.page - 1) * b.pageSize, b.page * b.pageSize), db.length) })
  check('⑪ total=21 分兩頁 → 收齊才判、第 2 頁命中 found', st(r, '873-LIONLINK-0231')?.state === 'found')
  // total 跟收到的一樣、沒有這台 → absent
  r = await lookupLuckyLink(['873-LIONLINK-0231'], { fetchPage: async (b) => !b.machineNumber ? TIMEOUT : page([item('892-COINCOMBO-0231')], 1) })
  check('⑪ total=1、收齊 1 筆、gmid 不同 → absent', st(r, '873-LIONLINK-0231')?.state === 'absent')
}

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
