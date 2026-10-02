/**
 * 回填的 Lark adapter 層測試（CodeX review bca81a7 [P2]）。跑法：npx tsx server/meegle-sheet-writeback.adapter.test.ts
 *
 * 用假的 fetch 走過**真的** `larkWritebackDeps().writeRow` → `multiWritebackLarkBatch`：
 *   預檢讀表頭時只有 699 欄（通過），helper 自己再讀一次時已經被塞滿到 ZZ——
 *   **不能有任何寫入**（建表頭、寫資料都不行）。純函式的 ZZ 測試抓不到這個，因為兩次讀表頭之間的變化只在這一層。
 */
process.env.LARK_APP_ID ||= 'test-app'
process.env.LARK_APP_SECRET ||= 'test-secret'
process.env.LARK_BASE_URL = 'https://lark.test'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

type Call = { method: string; url: string }
const calls: Call[] = []
/** headerSizes：第 n 次讀表頭時有幾欄（用完就重複最後一個） */
function installFetch(headerSizes: number[]) {
  let headerReads = 0
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't', expire: 7200 })
    if (method === 'GET' && /!A1:ZZ2/.test(decodeURIComponent(url))) {
      const n = headerSizes[Math.min(headerReads++, headerSizes.length - 1)]
      return json({ code: 0, data: { valueRange: { values: [Array.from({ length: n }, (_, i) => `c${i}`), []] } } })
    }
    return json({ code: 0, data: {} })
  }) as typeof fetch
}
const writes = () => calls.filter(c => c.method !== 'GET' && !c.url.includes('tenant_access_token'))

const { larkWritebackDeps, MAX_COL_IDX } = await import('./meegle-sheet-writeback.js')
const cols = { 'Meegle 單號': '#1', '處理階段': '已開單（Meegle）', '處理時間': 'now' }

{
  calls.length = 0
  installFetch([MAX_COL_IDX - 2, MAX_COL_IDX + 1]) // 預檢 699 欄 → helper 讀到時已滿 702 欄
  const r = await larkWritebackDeps().writeRow('lark:TOK:S1', 5, cols)
  eq('兩次讀表頭之間被塞滿到 ZZ → 回報失敗', r.ok, false)
  eq('而且沒有任何寫入（不建表頭、不寫資料）', writes().length, 0)
  eq('helper 確實讀了第二次表頭（關卡在它自己那次之後）', calls.filter(c => c.method === 'GET' && /A1:ZZ2/.test(decodeURIComponent(c.url))).length, 2)
}
{
  calls.length = 0
  installFetch([MAX_COL_IDX + 1])
  const r = await larkWritebackDeps().writeRow('lark:TOK:S1', 5, cols)
  eq('一開始就滿 → 預檢就擋下、沒有寫入', [r.ok, writes().length], [false, 0])
}
{
  calls.length = 0
  installFetch([10])
  const r = await larkWritebackDeps().writeRow('lark:TOK:S1', 5, cols)
  eq('表頭只有 10 欄 → 正常寫（建 3 個表頭＋1 次批次寫入）', [r.ok, writes().length], [true, 4])
}

// ── CodeX review 0e11d3a：欄名是箭頭變體（單子標題貼這→）且已有 Jira 值 → 標題欄不寫、其他三欄照寫 ──
{
  const Database = (await import('better-sqlite3')).default
  const { initMeegleBatchSchema, claimRow, finishCreate } = await import('./meegle-batch-store.js')
  const { writebackRow } = await import('./meegle-sheet-writeback.js')
  const db = new Database(':memory:'); initMeegleBatchSchema(db)
  claimRow(db, { batchId: 'B', rowKey: '5', ownerEmail: 'a@x.tw', sheetUrl: 'lark:TOK:S1', name: '修正登入', requirementId: '1', targetState: '' })
  finishCreate(db, 'B', '5', { phase: 'created', workItemId: '15191459', url: 'https://meegle/x' })
  let batchBody: { valueRanges?: Array<{ range: string }> } | null = null
  calls.length = 0
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input)); const method = init?.method ?? 'GET'
    calls.push({ method, url })
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't', expire: 7200 })
    if (method === 'GET' && url.includes('A1:ZZ2')) return json({ code: 0, data: { valueRange: { values: [['摘要', '單子標題貼這→'], []] } } })
    if (method === 'GET' && url.includes('!A5:A5')) return json({ code: 0, data: { valueRange: { values: [['修正登入']] } } })
    if (method === 'GET' && url.includes('!B5:B5')) return json({ code: 0, data: { valueRange: { values: [['CGFB-50\nFree Bet Record']] } } })
    if (method === 'POST' && url.includes('values_batch_update')) { batchBody = JSON.parse(String(init?.body)); return json({ code: 0, data: {} }) }
    return json({ code: 0, data: {} })
  }) as typeof fetch
  const r = await writebackRow(db, 'B', '5', larkWritebackDeps())
  const ranges = (batchBody?.valueRanges ?? []).map(v => v.range)
  eq('箭頭變體欄名也認得出「單子標題貼這」→ 讀到 Jira 值 → 回填 done', r.phase, 'done')
  eq('標題欄（B 欄）沒有被寫', ranges.some(x => /!B5:B5/.test(x)), false)
  eq('其他三欄照寫（C、D、E）', ranges.filter(x => /![CDE]5:[CDE]5/.test(x)).length, 3)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
process.exit(0)
