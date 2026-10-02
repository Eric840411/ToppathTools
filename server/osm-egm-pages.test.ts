/**
 * egmList 分頁收集。跑法：npx tsx server/osm-egm-pages.test.ts
 * 重點是 CodeX review 6f63515 [P2] 的情境：後面的頁壞掉時不能拿第 1 頁當成功結果。
 */
import { collectEgmPages, EGM_PAGE_SIZE, type EgmPage } from './osm-egm-pages.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
async function err(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return '（沒丟錯）' } catch (e) { return (e as Error).message }
}

const mk = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }))
const ok = (items: unknown[], total?: unknown): EgmPage => ({ httpOk: true, status: 200, body: { data: { items, ...(total === undefined ? {} : { total }) } } })
const pages = (...ps: EgmPage[]) => async (page: number) => ps[page - 1] ?? ok([], 0)

// ── 正常 ──
eq('一頁就拿齊', (await collectEgmPages(pages(ok(mk(80), 80)))).length, 80)
eq('NCH：574 台分兩頁', (await collectEgmPages(pages(ok(mk(500), 574), ok(mk(74, 500), 574)))).length, 574)
eq('後面的頁沒帶 total 不影響（總數以第 1 頁為準）', (await collectEgmPages(pages(ok(mk(500), 574), ok(mk(74, 500))))).length, 574)
eq('總數是字串也認', (await collectEgmPages(pages(ok(mk(500), '574'), ok(mk(74, 500), '574')))).length, 574)
eq('總數 0、沒有機台', (await collectEgmPages(pages(ok([], 0)))).length, 0)
eq('第 1 頁沒總數但沒裝滿 → 視為完整', (await collectEgmPages(pages(ok(mk(80))))).length, 80)

// ── CodeX 重現的情境：第 2 頁壞掉 ──
eq('第 2 頁回錯誤 JSON（沒有 data）→ 丟錯，不回傳 500 台',
  (await err(() => collectEgmPages(pages(ok(mk(500), 574), { httpOk: true, status: 200, body: { msg: 'token expired' } })))).includes('第 2 頁格式不對'), true)
eq('第 2 頁 HTTP 500 → 丟錯',
  (await err(() => collectEgmPages(pages(ok(mk(500), 574), { httpOk: false, status: 500, body: null })))).includes('第 2 頁 HTTP 500'), true)
eq('第 2 頁 body 解析失敗（null）→ 丟錯',
  (await err(() => collectEgmPages(pages(ok(mk(500), 574), { httpOk: true, status: 200, body: null })))).includes('第 2 頁格式不對'), true)
eq('第 2 頁 items 不是陣列 → 丟錯',
  (await err(() => collectEgmPages(pages(ok(mk(500), 574), { httpOk: true, status: 200, body: { data: { items: 'x', total: 574 } } })))).includes('格式不對'), true)
eq('第 2 頁空的 → 丟錯', (await err(() => collectEgmPages(pages(ok(mk(500), 574), ok([], 574))))).includes('第 2 頁是空的'), true)

// ── 第 1 頁 ──
eq('第 1 頁 HTTP 失敗 → 丟錯', (await err(() => collectEgmPages(pages({ httpOk: false, status: 401, body: { msg: '未登入' } })))).includes('HTTP 401：未登入'), true)
eq('第 1 頁沒總數又剛好裝滿 → 無法確認，丟錯', (await err(() => collectEgmPages(pages(ok(mk(EGM_PAGE_SIZE))))))
  .includes('無法確認'), true)

// ── 上限 ──
eq('一直回 1 台、總數很大 → 超過頁數上限丟錯', (await err(() => collectEgmPages(async () => ok(mk(1), 999999))))
  .includes('翻了 50 頁'), true)

console.log(`\n${pass} 通過，${fail} 失敗`)
process.exit(fail ? 1 : 0)
