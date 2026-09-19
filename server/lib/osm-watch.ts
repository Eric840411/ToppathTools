/**
 * osm-watch（影像辨識監控）的 list.json 取回與門檻索引。
 *
 * **為什麼需要**（使用者 2026-09-18 說明）：圖像辨識傳出來的獎池數值有時候是錯的。
 * 第一版的告警門檻是我們自己在 `jackpot_settings` 手填的，但**控制辨識取值範圍的是
 * 各辨識機上的 `list.json`**——看自己填的那份，就會發生「第一時間調不動」的狀況。
 * 所以這支把那份設定抓回來，讓監控以它為準。
 *
 * ⚠️ **用詞**：抓得到 list.json **不等於**辨識機已經載入這份設定（CodeX review）。
 *    對外一律說「list.json 設定值」，舊快取說「上次讀取值」，不要寫成「實際生效值」——
 *    我們沒有載入狀態的佐證。
 *
 * 欄位語意（使用者確認）：
 *   `high` / `low`   → **最大獎池**（Grand）的上下限
 *   `mhigh` / `mlow` → **第二獎池**（Major）的上下限
 *   用途是**限制圖像識別的取值範圍**，不是獎池本身的設定值。
 *
 * 🚨 **回應裡明碼帶著 `ossAccessKeyId` / `ossAccessKeySecret` / `UserSig`（阿里雲 OSS 金鑰）。**
 *    這支模組**只保留推導出來的門檻**，原始 JSON 不落地、不寫 log、不進 DB。
 *    加欄位的時候記得這件事——順手把整包存起來就等於把金鑰散出去。
 */

/** 一台辨識機上、某個 channel 的一筆 pool 設定（只留我們要的欄位）。 */
export interface WatchSource {
  server: string
  channel: string
  code: string
  low?: number
  high?: number
  mlow?: number
  mhigh?: number
  /** 這筆 pool 底下掛了幾台機台，判斷衝突時給人參考 */
  machines: number
}

export interface WatchRange { min?: number; max?: number }

export interface WatchEntry {
  /** 這個機種出現在哪些 channel（顯示用）。⚠️ 比對**不看 channel**，見 buildWatchIndex 的說明 */
  channels: string[]
  code: string
  sources: WatchSource[]
  /** 最大獎池（Grand）。衝突時為 null——見下方 resolveLevel 的說明 */
  grand: WatchRange | null
  /** 第二獎池（Major） */
  major: WatchRange | null
  /** 有兩台以上辨識機給了**不同的**範圍 */
  grandConflict: boolean
  majorConflict: boolean
  /** 有辨識機在這份設定裡沒有這一層的範圍（不代表那台完全沒有其他檢查） */
  grandPartial: boolean
  majorPartial: boolean
}

export interface WatchIndex {
  /** key = 機種代號（CODE）。⚠️ **不含 channel**——使用者 2026-09-18 確認「channel 其實可以不用管，跟 API 的讀取是沒關係的」 */
  entries: Map<string, WatchEntry>
  stats: {
    servers: number
    poolItems: number
    channels: number
    /** 索引裡的機種數（以前是 channel×機種，2026-09-18 改成只看機種） */
    pairs: number
    /** 兩層都有範圍 */
    bothLevels: number
    /** 只有一層 */
    oneLevel: number
    /**
     * 這份來源沒有設定任何範圍。
     * ⚠️ 只能說「list.json 沒設」，**不能推論辨識端完全沒有其他檢查**（CodeX review）。
     */
    noneLevel: number
    conflicts: number
  }
}

const CODE_RE = /^\d+-([A-Z0-9]+)-/

/**
 * 監控端的 gameid（`osmrisingrockets`）→ list.json 的機種代號（`RISINGROCKETS`）。
 *
 * ⚠️ **只做去前綴 + 轉大寫，不做模糊比對。**`osmdfdc` 對上 `DFDCGRAND` 還是 `DFDCMINI`
 *    沒有依據，猜錯的話會拿別款遊戲的範圍去判這一款——而且畫面上完全看不出來。
 *    配不到就配不到，讓它顯示「來源未提供」。
 */
export function gameCodeOf(gameid: string): string {
  return String(gameid || '').trim().replace(/^osm/i, '').toUpperCase()
}

function sameRange(a: [number | undefined, number | undefined], b: [number | undefined, number | undefined]) {
  return a[0] === b[0] && a[1] === b[1]
}

/**
 * 把同一個機種（跨所有 channel、所有辨識機）的設定收斂成一個範圍。
 *
 * ⚠️ **衝突時不合成範圍，回 null。**原本想「取最寬」，CodeX 指出那會放過更多辨識異常，
 *    使用者的需求也不是「讓監控過關」而是「看到真正生效的值」——不同辨識機吃到不同範圍
 *    本身就表示至少有一台不是預期的，那要去改 list.json，不是由我們湊一個出來。
 */
function resolveLevel(
  sources: WatchSource[],
  lo: 'low' | 'mlow',
  hi: 'high' | 'mhigh',
): { range: WatchRange | null; conflict: boolean; partial: boolean } {
  const defined = sources.filter(s => s[lo] !== undefined || s[hi] !== undefined)
  if (defined.length === 0) return { range: null, conflict: false, partial: false }

  const first: [number | undefined, number | undefined] = [defined[0][lo], defined[0][hi]]
  const conflict = defined.some(s => !sameRange([s[lo], s[hi]], first))
  // 有辨識機完全沒設這一層 → 那台沒有範圍在擋，要看得見
  const partial = defined.length !== sources.length

  if (conflict) return { range: null, conflict: true, partial }
  // ⚠️ 只設了一邊（實測 ALLABOARD 只有上界沒有下界）就只套那一邊，
  //    另一邊維持 undefined，由呼叫端決定要不要退回手動／預設。
  return { range: { min: first[0], max: first[1] }, conflict: false, partial }
}

/**
 * 從 list.json 原始回應建索引。**純函式**，測試直接打這支。
 *
 * ⚠️ **索引的 key 是機種代號，不含 channel**（使用者 2026-09-18 定案：
 *    「channel 其實可以不用管，跟 API 的讀取是沒關係的」）。原因是兩邊的 channel
 *    不是同一個維度：`getjpinfos?channelid=4171` 回的是 37 款（整個平台的獎池），
 *    而 list.json 的 `channel4171` 只涵蓋 4 種機種（某個場館的攝影機清單）——
 *    綁 channel 的話 37 款只對得到 4 款，其中 25 款是「代號對得上但在別的 channel」。
 *
 * ⚠️ 代價寫在這裡：**同一機種在不同 channel 的門檻確實可能不同**
 *    （實測 MOREPUFF 有 6M/3M 與 20M/8M 兩組、DRAGONTRIO 有 6M/3M 與 15M/3M）。
 *    這種情況一律判 conflict，**不合成也不挑一個**——挑了就等於我們自己決定
 *    該用誰的範圍，而那正是這條線要避免的事。
 */
export function buildWatchIndex(raw: unknown): WatchIndex {
  const entries = new Map<string, WatchEntry>()
  const bucket = new Map<string, WatchSource[]>()
  const channels = new Set<string>()
  let poolItems = 0
  let servers = 0

  const servs = (raw as { servers?: Record<string, { list_json?: { pool?: unknown[] } }> })?.servers ?? {}
  for (const [server, s] of Object.entries(servs)) {
    servers++
    for (const p of (s?.list_json?.pool ?? []) as Record<string, unknown>[]) {
      poolItems++
      const channel = String(p.channel ?? '')
      channels.add(channel)
      const gamelist = (p.gamelist ?? []) as { id?: string }[]
      const codes = new Set<string>()
      for (const g of gamelist) {
        const m = CODE_RE.exec(String(g?.id ?? ''))
        if (m) codes.add(m[1])
      }
      for (const code of codes) {
        const key = code
        const list = bucket.get(key) ?? []
        list.push({
          server,
          channel,
          code,
          low: num(p.low),
          high: num(p.high),
          mlow: num(p.mlow),
          mhigh: num(p.mhigh),
          machines: gamelist.length,
        })
        bucket.set(key, list)
      }
    }
  }

  let bothLevels = 0, oneLevel = 0, noneLevel = 0, conflicts = 0
  for (const [code, sources] of bucket) {
    const g = resolveLevel(sources, 'low', 'high')
    const m = resolveLevel(sources, 'mlow', 'mhigh')
    entries.set(code, {
      channels: [...new Set(sources.map(s => s.channel))], code, sources,
      grand: g.range, major: m.range,
      grandConflict: g.conflict, majorConflict: m.conflict,
      grandPartial: g.partial, majorPartial: m.partial,
    })
    const hasG = g.range !== null || g.conflict
    const hasM = m.range !== null || m.conflict
    if (hasG && hasM) bothLevels++
    else if (hasG || hasM) oneLevel++
    else noneLevel++
    if (g.conflict || m.conflict) conflicts++
  }

  return {
    entries,
    stats: { servers, poolItems, channels: channels.size, pairs: entries.size, bothLevels, oneLevel, noneLevel, conflicts },
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 查某個 gameid 的門檻。
 *
 * ⚠️ **刻意不吃 channel。**見 `buildWatchIndex` 的說明——兩邊的 channel 不是同一個維度，
 *    綁上去只會讓 37 款裡有 25 款白白對不到。
 */
export function lookupWatchEntry(index: WatchIndex | null, gameid: string): WatchEntry | null {
  if (!index) return null
  return index.entries.get(gameCodeOf(gameid)) ?? null
}

// ─── 取回與快取 ────────────────────────────────────────────────────────────────

export interface WatchCacheState {
  index: WatchIndex | null
  /** 這份索引是什麼時候抓到的（成功時間），null 代表從來沒成功過 */
  fetchedAt: number | null
  /** 最近一次嘗試的時間 */
  attemptedAt: number | null
  /** 最近一次失敗的訊息；成功時清掉 */
  lastError: string | null
}

const TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 20_000

const state: WatchCacheState = { index: null, fetchedAt: null, attemptedAt: null, lastError: null }
let inflight: Promise<void> | null = null

export function watchState(): WatchCacheState {
  return state
}

/** 這份索引有多舊（毫秒）。從來沒成功過回 null。 */
export function watchAgeMs(now = Date.now()): number | null {
  return state.fetchedAt === null ? null : now - state.fetchedAt
}

export function watchUrl(): string | null {
  const base = process.env.OSM_WATCH_URL
  const token = process.env.OSM_WATCH_TOKEN
  if (!base) return null
  if (!token) return base
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * 需要時才更新（TTL 5 分鐘）。
 *
 * ⚠️ **失敗不清掉既有索引**——沿用上一次成功的值，但呼叫端要能分辨
 * 「來源本來就沒設這個門檻」與「這次沒抓到、用的是舊資料」。
 * 兩者混成一句「正在用預設值」的話，人會一直等一個永遠不會來的修復（CodeX review）。
 */
export async function refreshWatchIndex(force = false): Promise<void> {
  const now = Date.now()
  if (!force && state.fetchedAt !== null && now - state.fetchedAt < TTL_MS) return
  if (inflight) return inflight

  inflight = (async () => {
    state.attemptedAt = Date.now()
    const url = watchUrl()
    if (!url) { state.lastError = 'OSM_WATCH_URL 未設定'; return }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await fetch(url, { signal: ac.signal })
      if (!resp.ok) { state.lastError = `upstream ${resp.status}`; return }
      const raw = await resp.json()
      const index = buildWatchIndex(raw)
      // ⚠️ 只留索引。raw 到這裡就結束生命週期——它帶著 OSS 金鑰，不可以外流或保存。
      if (index.stats.poolItems === 0) { state.lastError = '回應裡沒有任何 pool 設定'; return }
      state.index = index
      state.fetchedAt = Date.now()
      state.lastError = null
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(t)
      inflight = null
    }
  })()

  return inflight
}
