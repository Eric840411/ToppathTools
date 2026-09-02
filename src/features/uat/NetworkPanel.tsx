/**
 * src/features/uat/NetworkPanel.tsx
 *
 * UAT 網路載入時間與 pinus 訊息的即時面板。Backend / H5 / PC 三個分頁共用同一個
 * 元件——資料來源不同（Backend 走 stdout 夾標記行、H5/PC 走結構化事件），但到了
 * 前端已經是同一個形狀，沒有理由做兩套 UI。
 *
 * 資料由各分頁自己接 SSE 的 `stats` event 之後傳進來，這個元件不自己連線：
 * 兩邊的 SSE 端點不同（/api/osm-uat/stream vs /api/frontend-auto/log-stream/:runId），
 * 連線與重連的責任留在原本就在管它的地方。
 */
import type { UatThemeMode } from './types'

export interface NetStats {
  count: number
  avgMs: number | null
  maxMs: number | null
  p95Ms: number | null
}

export interface NetSlowRecord {
  url: string
  kind: 'api' | 'image' | 'other'
  durationMs: number | null
  overThresholdMs?: number
  thresholdMs?: number
}

export interface NetSummary {
  thresholds: { api: number; image: number; other: number }
  totals: {
    captured: number; counted: number; likelyCached: number
    redirects: number; preflights: number; failed: number; dropped: number
  }
  api: NetStats
  image: NetStats
  other: NetStats
  slow: NetSlowRecord[]
  /** 實際打了哪些 API，依發生順序。只列 api 這類，圖檔與靜態資源列出來只是洗版 */
  apiCalls?: { method: string; url: string; status: number | null; durationMs: number | null; ts: number }[]
  /** 超過上限沒帶出來的筆數。要講出來，不然使用者以為只打了這幾支 */
  apiCallsTruncated?: number
}

export interface PinusSummary {
  total: number
  pageDropped: number
  routes: { key: string; count: number; avgMs: number | null; maxMs: number | null }[]
}

export interface UatStatsPayload {
  scope?: string
  net?: NetSummary
  pinus?: PinusSummary
  final?: boolean
}

/**
 * 兩張表的網址欄永遠塞不下——但塞不下的原因不是「網址太長」，
 * 是**每一列開頭都重複同一段 origin**。實測 `https://qat-cp.osmslot.org/...`
 * 這種長度下，origin 就佔掉整串的 50%，而被截掉的正好是唯一有區別、
 * 也唯一有用的那半（endpoint 名稱）。
 *
 * 所以做法不是「想辦法塞下」，是**把共同的 origin 抽出來只寫一次**，
 * 每一列只留路徑。這樣不用加寬任何欄位就能看到完整的 endpoint。
 *
 * ⚠️ 只有在**全部**列都同源時才抽。混到不同 host 時抽掉會讓人分不出
 * 哪一筆打去哪裡——那種情況寧可維持完整網址、繼續截斷。
 */
function commonOrigin(urls: string[]): string | null {
  const origins = new Set<string>()
  for (const u of urls) {
    try { origins.add(new URL(u).origin) } catch { return null }  // 不是合法網址就別猜
  }
  return origins.size === 1 ? [...origins][0] : null
}

/** 有共同 origin 就只回路徑，否則原樣回傳 */
function shortUrl(url: string, origin: string | null): string {
  return origin && url.startsWith(origin) ? url.slice(origin.length) || '/' : url
}

/**
 * 拆成「路徑」與「主機」兩段（2026-09-02，使用者選的 C 案）。
 *
 * ⚠️ 上面 `commonOrigin()` 是**全有全無**：只要有一筆是別的 host 就整個放棄縮短。
 *    真實資料剛好踩中——21 筆裡 20 筆同一個後台、1 筆是 `uat-cp` 的
 *    challenge-platform，於是**每一列都退回完整網址被截成 `https://u…`**，
 *    整欄零資訊（使用者 2026-09-02 回報「不夠直觀」）。
 *
 *    拆成兩行就繞開這個限制：路徑永遠看得到，主機各自標各自的，
 *    不需要「全部同源」這個前提。
 *
 * query 不放進路徑（`/egm/...?page=1&pageSize=1000&dateTime[]=...` 會長到把版面撐爆），
 * 只留一個 `?` 記號表示有帶參數；完整網址仍在 title 裡。
 */
function splitUrl(url: string): { path: string; host: string; hasQuery: boolean } {
  try {
    const u = new URL(url)
    return { path: u.pathname || '/', host: u.host, hasQuery: !!u.search }
  } catch {
    return { path: url, host: '', hasQuery: false }   // 不是合法網址就原樣顯示，不猜
  }
}

/** 出現次數最多的 host。用來把「跟大家一樣」的那些淡化、只讓例外跳出來 */
function dominantHost(urls: string[]): string {
  const count = new Map<string, number>()
  for (const u of urls) {
    try { const h = new URL(u).host; count.set(h, (count.get(h) ?? 0) + 1) } catch { /* 不是網址就跳過 */ }
  }
  let best = '', n = 0
  for (const [h, c] of count) if (c > n) { best = h; n = c }
  return best
}

const KIND_LABEL: Record<UatThemeMode, Record<'api' | 'image' | 'other', string>> = {
  classic: { api: 'API', image: '圖檔', other: '其他' },
  xianxia: { api: '法訊', image: '靈影', other: '其餘' },
}

const COPY = {
  classic: {
    kicker: 'NETWORK TELEMETRY', title: '網路監測',
    timing: '載入時間', slow: '超過門檻的請求', pinus: 'pinus 訊息', apiCalls: '實際呼叫的 API',
    empty: '尚未開始量測', emptyHint: '執行測試後這裡會即時顯示每支 API 與每張圖的載入時間',
    allGood: '全部在門檻內', allGoodHint: '目前沒有超過預期的請求',
    noPinus: '這次沒有攔截到 pinus 訊息',
    thKind: '類型', thDur: '耗時', thOver: '超出', thUrl: '網址',
    thRoute: 'route', thTimes: '次數', thRtt: '往返',
    cached: '疑似快取', redirect: '轉址', preflight: '預檢', failed: '失敗',
    avg: 'ms 平均', threshold: '門檻', slowest: '最慢', rows: '筆',
    updated: '更新於', finished: '已完成',
  },
  xianxia: {
    kicker: 'SPIRIT FLOW', title: '靈脈流速',
    timing: '流速觀測', slow: '滯澀之訊', pinus: '靈訊往來', apiCalls: '往返之術',
    empty: '尚未起測', emptyHint: '推演開始後此處即現每道法訊與靈影的往返耗時',
    allGood: '俱在限內', allGoodHint: '目前沒有逾限的訊息',
    noPinus: '此次未攔得靈訊',
    thKind: '類別', thDur: '耗時', thOver: '逾限', thUrl: '訊源',
    thRoute: '訊道', thTimes: '次數', thRtt: '往返',
    cached: '疑似留影', redirect: '轉引', preflight: '先探', failed: '失落',
    avg: 'ms 均值', threshold: '限度', slowest: '最滯', rows: '道',
    updated: '更新於', finished: '已圓滿',
  },
} as const

/** p95 相對門檻的位置。超過門檻 = bad，逼近 80% 先示警——等真的爆掉才變色就太晚了 */
function severityOf(p95: number | null, limit: number): '' | 'is-warn' | 'is-bad' {
  if (p95 === null) return ''
  if (p95 > limit) return 'is-bad'
  return p95 / limit > 0.8 ? 'is-warn' : ''
}

export function NetworkPanel({ stats, themeMode, updatedAt }: {
  stats: UatStatsPayload | null
  themeMode: UatThemeMode
  /** 最後收到快照的時間；沒有這個就分不出「數字是活的」還是「卡住了」 */
  updatedAt: number | null
}) {
  const copy = COPY[themeMode]
  const label = KIND_LABEL[themeMode]
  const net = stats?.net
  // 兩張表分開算——慢速那張可能只剩圖檔、API 那張只剩 API，來源不一定一樣
  const slowOrigin = commonOrigin((net?.slow ?? []).map(r => r.url))
  const apiOrigin = commonOrigin((net?.apiCalls ?? []).map(r => r.url))
  const apiMainHost = dominantHost((net?.apiCalls ?? []).map(r => r.url))
  /** 最新的排最上面（使用者 2026-09-02 要求）。
   *  ⚠️ 一定要複製再排——直接 sort 會就地改動 props 傳進來的陣列，
   *     那個陣列也是統計數字的來源，改到它會讓別處讀到被重排過的資料。 */
  const apiCallsNewestFirst = [...(net?.apiCalls ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  const pinus = stats?.pinus

  if (!net) {
    return (
      <section className="uat-panel uat-net-panel">
        <div className="uat-net-head">
          <div><span className="uat-net-kicker">{copy.kicker}</span><h3>{copy.title}</h3></div>
        </div>
        <div className="uat-net-empty"><strong>{copy.empty}</strong><span>{copy.emptyHint}</span></div>
      </section>
    )
  }

  const kinds: ('api' | 'image' | 'other')[] = ['api', 'image', 'other']

  return (
    <section className="uat-panel uat-net-panel">
      <div className="uat-net-head">
        <div><span className="uat-net-kicker">{copy.kicker}</span><h3>{copy.title}</h3></div>
        <span className={`uat-net-live${stats?.final ? ' is-done' : ''}`}>
          <i />
          {stats?.final
            ? copy.finished
            : `${copy.updated} ${updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-TW', { hour12: false }) : '--:--:--'}`}
        </span>
      </div>

      <div className="uat-net-tiles">
        {kinds.map(kind => {
          const st = net[kind]
          const limit = net.thresholds[kind]
          const ratio = st.p95Ms === null ? 0 : Math.min(1, st.p95Ms / limit)
          return (
            <article className={`uat-net-tile ${severityOf(st.p95Ms, limit)}`} key={kind}>
              <div className="uat-net-tile-top">
                <span>{label[kind]}</span>
                <b>{st.count} {copy.rows}</b>
              </div>
              <div className="uat-net-tile-main">
                <strong>{st.avgMs ?? '—'}</strong><span>{copy.avg}</span>
              </div>
              <div className="uat-net-gauge"><i style={{ width: `${(ratio * 100).toFixed(1)}%` }} /></div>
              <div className="uat-net-gauge-marks">
                <span>p95 {st.p95Ms ?? '—'}ms</span>
                <span>{copy.threshold} {limit}ms</span>
              </div>
              <div className="uat-net-tile-row"><span>{copy.slowest}</span><b>{st.maxMs ?? '—'} ms</b></div>
            </article>
          )
        })}
      </div>

      {/* 排除筆數要講清楚為什麼排除，不然使用者只會看到「擷取 381、統計 163」然後懷疑漏抓 */}
      <div className="uat-net-chips">
        <span className="uat-net-chip" title="推測值：完全沒有建線階段且總時間 < 5ms。Playwright 沒有暴露 fromDiskCache，所以這是訊號不是事實。快取命中的圖看起來一定很快，但那不代表首次載入也快。">
          {copy.cached} <b>{net.totals.likelyCached}</b>
        </span>
        <span className="uat-net-chip" title="redirect 的每一跳都是獨立 request，不是使用者等待的實際內容">
          {copy.redirect} <b>{net.totals.redirects}</b>
        </span>
        <span className="uat-net-chip" title="瀏覽器自己發的 OPTIONS 預檢請求">
          {copy.preflight} <b>{net.totals.preflights}</b>
        </span>
        <span className="uat-net-chip">{copy.failed} <b>{net.totals.failed}</b></span>
      </div>

      <div className="uat-net-tables">
        <div className="uat-net-table-block">
          <h4>{copy.slow} <em>{net.slow.length}</em>
            {slowOrigin && <b className="uat-net-origin" title={slowOrigin}>{slowOrigin.replace(/^https?:\/\//, '')}</b>}</h4>
          <div className="uat-net-scroller">
            {net.slow.length ? (
              <table>
                <thead><tr>
                  <th style={{ width: 62 }}>{copy.thKind}</th>
                  <th className="is-num" style={{ width: 72 }}>{copy.thDur}</th>
                  <th className="is-num" style={{ width: 66 }}>{copy.thOver}</th>
                  <th>{copy.thUrl}</th>
                </tr></thead>
                <tbody>
                  {net.slow.slice(0, 50).map((r, i) => (
                    <tr key={`${r.url}-${i}`}>
                      <td><span className={`uat-net-kind is-${r.kind}`}>{label[r.kind]}</span></td>
                      <td className="is-num">{Math.round(r.durationMs ?? 0)}</td>
                      <td className="is-num is-over">+{Math.round(r.overThresholdMs ?? 0)}</td>
                      <td className="is-url" title={r.url}>{shortUrl(r.url, slowOrigin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="uat-net-empty is-ok"><strong>✓ {copy.allGood}</strong><span>{copy.allGoodHint}</span></div>
            )}
          </div>
        </div>

        {/* 實際打了哪些 API。原本只列「超過門檻的」，全部在門檻內時整片空白，
            使用者根本不知道這頁打了哪些後端——而要基於 API 下 pass/fail 之前，
            得先看得到有哪些可以下 */}
        {!!net.apiCalls?.length && (
          <div className="uat-net-table-block">
            <h4>{copy.apiCalls} <em>{net.apiCalls.length}{net.apiCallsTruncated ? `+${net.apiCallsTruncated}` : ''}</em>
            {apiOrigin && <b className="uat-net-origin" title={apiOrigin}>{apiOrigin.replace(/^https?:\/\//, '')}</b>}</h4>
            <div className="uat-net-scroller">
              <table>
                <thead><tr>
                  <th style={{ width: 62 }}>Method</th>
                  <th className="is-num" style={{ width: 58 }}>狀態</th>
                  <th className="is-num" style={{ width: 72 }}>{copy.thDur}</th>
                  <th>{copy.thUrl}</th>
                </tr></thead>
                <tbody>
                  {apiCallsNewestFirst.map((r, i) => {
                    // 路徑在上、主機在下（使用者選的 C 案）。真正能分辨彼此的是路徑，
                    // 原本整欄顯示同一段 origin 被截斷成 `https://u…`，等於沒有資訊。
                    const { path, host, hasQuery } = splitUrl(r.url)
                    return (
                    <tr key={`${r.url}-${r.ts}-${i}`}>
                      <td><span className={`uat-net-method is-${r.method.toLowerCase()}`}>{r.method}</span></td>
                      {/* 非 2xx 要一眼看得出來——那通常就是最值得下斷言的地方 */}
                      <td className={`is-num${r.status && r.status >= 400 ? ' is-over' : ''}`}>{r.status ?? '—'}</td>
                      <td className="is-num">{r.durationMs ?? '—'}</td>
                      {/* is-url 本身帶 nowrap + overflow:hidden + max-width:0（給單行截斷用的），
                          兩行式一定要另加 is-url-2line 覆蓋掉，否則第二行會被裁掉看不見 */}
                      <td className="is-url is-url-2line" title={r.url}>
                        <span className="uat-net-path">{path}{hasQuery && <i className="uat-net-q">?</i>}</span>
                        {/* 跟多數列同一個主機就淡化（那是背景資訊）；
                            不一樣的才標出來——那種才是需要注意的 */}
                        {host && <span className={`uat-net-host${apiMainHost && host !== apiMainHost ? ' is-odd' : ''}`}>{host}</span>}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
              {!!net.apiCallsTruncated && (
                <div className="uat-net-empty"><span>另外還有 {net.apiCallsTruncated} 筆沒列出來（清單上限 60）</span></div>
              )}
            </div>
          </div>
        )}

        {/* pinus 區塊只有真的攔到訊息才顯示：Backend 測的後台管理站沒有 pinus，
            永遠掛一個空表格在那邊只會讓人以為壞掉 */}
        {pinus && pinus.total > 0 && (
          <div className="uat-net-table-block">
            <h4>{copy.pinus} <em>{pinus.total}</em></h4>
            <div className="uat-net-scroller">
              <table>
                <thead><tr>
                  <th>{copy.thRoute}</th>
                  <th className="is-num" style={{ width: 54 }}>{copy.thTimes}</th>
                  <th className="is-num" style={{ width: 74 }}>{copy.thRtt}</th>
                </tr></thead>
                <tbody>
                  {pinus.routes.slice(0, 40).map(r => (
                    <tr key={r.key}>
                      <td className="is-url" title={r.key}>{r.key}</td>
                      <td className="is-num">{r.count}</td>
                      <td className="is-num">{r.avgMs !== null ? `${r.avgMs} ms` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
