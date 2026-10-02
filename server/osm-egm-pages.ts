/**
 * OSM 後台 egmList 分頁收集（v4.267.6 起翻完每一頁；v4.270.1 改成每頁都驗）。
 *
 * 🚨 CodeX review 6f63515 [P2]：原本把「這頁沒有 total」當成 0 直接收工——第 2 頁回錯誤 JSON 時，
 * 第 1 頁的 500 台會被當成成功結果覆寫整個渠道（NCH 實際 574 台）。規則：
 * - 每一頁都要 HTTP 成功、而且 data.items 是陣列，否則整個渠道同步失敗
 * - 總數以第 1 頁為準（後面的頁沒帶 total 不影響）；第 1 頁沒有 total 時，只有「一頁就裝不滿」才能確定拿齊
 * - 沒拿齊之前遇到空頁、或超過頁數上限 → 丟錯
 * 寧可這個渠道同步失敗，也不要回傳一份默默少掉的清單。
 */

export type EgmPage = { httpOk: boolean; status: number; body: unknown }

export const EGM_PAGE_SIZE = 500
export const EGM_MAX_PAGES = 50

function parsePage(page: number, p: EgmPage): { items: Array<Record<string, unknown>>; total: number | null } {
  const b = p.body as { data?: { items?: unknown; total?: unknown }; msg?: unknown } | null
  if (!p.httpOk) throw new Error(`egmList 第 ${page} 頁 HTTP ${p.status}${typeof b?.msg === 'string' ? `：${b.msg}` : ''}`)
  if (!b || typeof b !== 'object' || !b.data || !Array.isArray(b.data.items)) {
    throw new Error(`egmList 第 ${page} 頁格式不對${typeof b?.msg === 'string' ? `：${b.msg}` : '（沒有 data.items）'}`)
  }
  const t = b.data.total
  const total = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t
    : typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : null
  return { items: b.data.items as Array<Record<string, unknown>>, total }
}

export async function collectEgmPages(fetchPage: (page: number, pageSize: number) => Promise<EgmPage>): Promise<Array<Record<string, unknown>>> {
  const first = parsePage(1, await fetchPage(1, EGM_PAGE_SIZE))
  const items = [...first.items]
  if (first.total === null) {
    // 沒有總數就無從確認拿齊：只有第 1 頁沒裝滿才算完整
    if (items.length < EGM_PAGE_SIZE) return items
    throw new Error(`egmList 第 1 頁沒有總數，又剛好 ${items.length} 台（一頁上限），無法確認有沒有拿齊`)
  }
  const total = first.total
  for (let page = 2; items.length < total; page++) {
    if (page > EGM_MAX_PAGES) throw new Error(`egmList 翻了 ${EGM_MAX_PAGES} 頁還沒拿齊（總數 ${total}、拿到 ${items.length}）`)
    const p = parsePage(page, await fetchPage(page, EGM_PAGE_SIZE))
    if (p.items.length === 0) throw new Error(`egmList 第 ${page} 頁是空的，但總數 ${total}、只拿到 ${items.length} 台`)
    items.push(...p.items)
  }
  return items
}
