// 測前檢查的 LuckyLink 查詢（v5.56.0，osm-qa-agent 1013 回報、CodeX 定案）
//
// 起因：QAT /slot/egmList 用 pageSize 10000 抓全表，每次都回 40000 Operation timed out；
//       原本讀取失敗跟「清單裡沒有」都變成 null → 每台都報「Egm list 沒有這台」＋「預期有接」＝假警報。
//
// 規則（CodeX）：
//   - 每台三態：found（找到）／absent（API 成功、查完仍沒有完整 gmid）／unknown（無法確認，附原因）
//   - 全表失敗 → 逐台用 gmid 最後一段的機台號查；同一個機台號在別的渠道也有，只認完整 gmid
//   - 單台查詢也要翻頁：這頁滿了就查下一頁，首頁沒命中不能判沒有
//   - 每個請求都看業務 code、接網路例外、設 timeout；單台失敗只影響那一台
//
// fetchJson 由呼叫端注入（測試用 mock）：(url, init) → 解析後的 JSON；網路錯誤／逾時就 throw。

export const LL_FULL_PAGE_SIZE = 10000
export const LL_ONE_PAGE_SIZE = 20
export const LL_MAX_PAGES = 10
export const LL_TIMEOUT_MS = 20_000

const gmidKey = (g) => String(g ?? '').trim().toUpperCase()
/** gmid 最後一段當機台號（873-LIONLINK-0231 → 0231） */
export const machineNumberOf = (code) => String(code).split('-').pop()

/** 一次 egmList 回應：成功 → items 陣列；失敗 → 原因字串 */
function readPage(j) {
  if (!j || typeof j !== 'object') return '回應不是 JSON'
  // 成功的回應有 data.items；有帶 code 時只接受 20000（失敗看過 40000 Operation timed out）
  if (j.code != null && j.code !== 20000) return `${j.code} ${String(j.message ?? '').slice(0, 120)}`.trim()
  if (!Array.isArray(j?.data?.items)) return `格式不對（沒有 data.items${j.code != null ? `，code ${j.code}` : ''}）`
  return j.data.items
}

/** 翻頁查到底：成功 → 全部 items；任何一頁失敗 → { err } */
async function queryAll(fetchPage, pageSize) {
  const all = []
  for (let page = 1; page <= LL_MAX_PAGES; page++) {
    let j
    try { j = await fetchPage(page, pageSize) } catch (e) { return { err: e?.name === 'TimeoutError' || /timeout|abort/i.test(String(e?.name ?? e)) ? '逾時' : `連線失敗（${String(e?.message ?? e).slice(0, 60)}）` } }
    const items = readPage(j)
    if (typeof items === 'string') return { err: items }
    all.push(...items)
    if (items.length < pageSize) return { items: all }
  }
  return { err: `超過 ${LL_MAX_PAGES} 頁還沒查完` }
}

/**
 * @param {string[]} codes 完整 gmid
 * @param {{ fetchPage: (body: object) => Promise<any>, concurrency?: number }} deps
 *   fetchPage(body)：POST /slot/egmList，body 已含 page／pageSize／machineNumber
 * @returns {{ status: Map<string, {state:'found', item:object}|{state:'absent'}|{state:'unknown', why:string}>, errs: string[] }}
 */
export async function lookupLuckyLink(codes, { fetchPage, concurrency = 4 }) {
  const status = new Map()
  const errs = []
  const body = (machineNumber, page, pageSize) => ({ channelId: '', machineNumber, serialNumber: '', groupName: '', page, pageSize })
  const settle = (items, wanted) => {
    const byGmid = new Map(items.map(x => [gmidKey(x.gmid), x]))
    for (const c of wanted) { const it = byGmid.get(gmidKey(c)); status.set(gmidKey(c), it ? { state: 'found', item: it } : { state: 'absent' }) }
  }

  const full = await queryAll((page, size) => fetchPage(body('', page, size)), LL_FULL_PAGE_SIZE)
  if (full.items) { settle(full.items, codes); return { status, errs } }
  errs.push(`LuckyLink Egm list 全表讀取失敗（${full.err}），改逐台查`)

  // 同一個機台號只查一次（跨渠道同號），結果再用完整 gmid 分給各台
  const byNumber = new Map()
  for (const c of codes) { const n = machineNumberOf(c); byNumber.set(n, [...(byNumber.get(n) ?? []), c]) }
  const queue = [...byNumber.entries()]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [num, wanted] = next
      const r = await queryAll((page, size) => fetchPage(body(num, page, size)), LL_ONE_PAGE_SIZE)
      if (r.items) settle(r.items, wanted)
      else for (const c of wanted) status.set(gmidKey(c), { state: 'unknown', why: r.err })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  const unknown = codes.filter(c => status.get(gmidKey(c))?.state === 'unknown')
  if (unknown.length) errs.push(`LuckyLink 有 ${unknown.length} 台無法確認（逐台查詢也失敗）`)
  return { status, errs }
}
