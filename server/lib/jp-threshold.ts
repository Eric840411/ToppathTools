/**
 * Jackpot 監控的門檻解析：list.json 設定值 / 手動設定 / 內建預設，三者怎麼收斂成一組上下限。
 *
 * **為什麼是 list.json 優先**（使用者 2026-09-18）：圖像辨識偶爾會傳出識別錯誤的數值，
 * 第一版靠我們自己在 `jackpot_settings` 手填的門檻告警，結果是「第一時間調不動」——
 * 因為控制辨識取值範圍的是辨識機上的 `list.json`，不是我們那份。
 *
 * ⚠️ **用詞**（CodeX review）：抓得到 list.json ≠ 辨識機已載入它。對外一律稱
 *    「list.json 設定值」／舊快取稱「上次讀取值」，不要寫成「實際生效值」。
 *
 * ⚠️ **手動值不會被靜默覆蓋。**跟 list.json 不一致時標 `manual_mismatch`——
 *    那個落差本身就是使用者要看見的東西。
 *
 * ⚠️ **哪一個等級是「最大獎池」不能寫死**（使用者 2026-09-18）：
 *    有些遊戲最大的是 Grand，有些是 Fortunate，有些根本沒有 Fortunate。
 *    list.json 只說得出「最大」與「第二大」，對到哪個等級是**每款遊戲各自設定**的，
 *    所以這支收的是 `role`（top／second／null），不是等級名稱。
 */
import type { WatchEntry } from './osm-watch.js'

export type JpLevelName = 'grand' | 'major' | 'minor' | 'mini' | 'fortunate'

/**
 * 這個等級在 list.json 裡對應到哪一個池：
 *   `top`    → `high` / `low`（最大獎池）
 *   `second` → `mhigh` / `mlow`（第二獎池）
 *   `null`   → list.json 沒有對應（這款遊戲沒把這個等級指定給任何一個）
 */
export type WatchRole = 'top' | 'second' | null

export type ThresholdSource = 'watch' | 'watch_stale' | 'manual' | 'default'

export type ThresholdFlag =
  /** 這一層 list.json 本來就沒有對應（只有最大池與第二池） */
  | 'watch_not_applicable'
  /** list.json 裡沒有這個 channel × 機種 的組合 */
  | 'watch_unmatched'
  /** 配到組合了，但這一層沒設範圍 */
  | 'watch_missing'
  /** 多台辨識機給了不同範圍——不合成，退回手動／預設 */
  | 'watch_conflict'
  /** 有辨識機在這一層沒設範圍 */
  | 'watch_partial'
  /** list.json 只設了單邊（例如只有上界） */
  | 'half_range'
  /** 這次沒抓到 list.json：用的是上次讀取值或預設 */
  | 'watch_unavailable'
  /** 手動設定與 list.json 不一致 */
  | 'manual_mismatch'

export interface ManualThreshold { min: number; max: number }

export interface ResolveInput {
  level: JpLevelName
  /** 這個等級對到 list.json 的哪個池；由每款遊戲的設定決定，不是寫死的 */
  role: WatchRole
  /** list.json 索引查出來的組合；查不到給 null */
  entry: WatchEntry | null
  manual: ManualThreshold | null
  defaults: ManualThreshold
  /** 目前手上的 list.json 是不是舊的（這次沒抓成功、沿用上次） */
  watchStale: boolean
  /** 從來沒成功抓過 list.json */
  watchNever: boolean
}

export interface ResolvedThreshold {
  min: number
  max: number
  minSource: ThresholdSource
  maxSource: ThresholdSource
  flags: ThresholdFlag[]
  /** 範圍來自哪幾台辨識機（只有 watch / watch_stale 時才有意義） */
  servers: string[]
}

export function resolveJpThreshold(input: ResolveInput): ResolvedThreshold {
  const { role, entry, manual, defaults, watchStale, watchNever } = input
  const flags: ThresholdFlag[] = []

  const baseSource: ThresholdSource = manual ? 'manual' : 'default'
  const base = manual ?? defaults
  const fallback = (extra: ThresholdFlag[]): ResolvedThreshold => ({
    min: base.min, max: base.max, minSource: baseSource, maxSource: baseSource,
    flags: [...flags, ...extra], servers: [],
  })

  // 沒有被指定給最大／第二大的等級：list.json 沒有對應，用手動／預設是正常狀態，不是缺陷
  if (role === null) return fallback(['watch_not_applicable'])

  // ⚠️ 「這次沒抓到」與「來源沒設」要分開。前者修得好，後者修接口也不會有值。
  if (watchNever) return fallback(['watch_unavailable'])
  if (watchStale) flags.push('watch_unavailable')

  if (!entry) return fallback(['watch_unmatched'])

  const conflict = role === 'top' ? entry.grandConflict : entry.majorConflict
  const partial = role === 'top' ? entry.grandPartial : entry.majorPartial
  const range = role === 'top' ? entry.grand : entry.major

  // 衝突不合成範圍：不同辨識機吃到不同設定，本身就代表至少有一台不是預期的
  if (conflict) return fallback(['watch_conflict'])
  if (!range) return fallback(partial ? ['watch_missing', 'watch_partial'] : ['watch_missing'])
  if (partial) flags.push('watch_partial')

  const watchSource: ThresholdSource = watchStale ? 'watch_stale' : 'watch'
  const min = range.min ?? base.min
  const max = range.max ?? base.max
  const minSource: ThresholdSource = range.min !== undefined ? watchSource : baseSource
  const maxSource: ThresholdSource = range.max !== undefined ? watchSource : baseSource
  if (range.min === undefined || range.max === undefined) flags.push('half_range')

  if (manual && (
    (range.min !== undefined && manual.min !== range.min) ||
    (range.max !== undefined && manual.max !== range.max)
  )) flags.push('manual_mismatch')

  return { min, max, minSource, maxSource, flags, servers: entry.sources.map(s => s.server) }
}

/** 一句話講清楚這組門檻的來歷，給畫面與 Lark 告警共用（兩邊講不一樣是最難查的 bug）。 */
export function describeThreshold(r: ResolvedThreshold): string {
  const src = (s: ThresholdSource) =>
    s === 'watch' ? 'list.json 設定值'
    : s === 'watch_stale' ? 'list.json 上次讀取值'
    : s === 'manual' ? '手動設定'
    : '內建預設'
  const parts: string[] = []
  parts.push(r.minSource === r.maxSource ? src(r.minSource) : `下限 ${src(r.minSource)}／上限 ${src(r.maxSource)}`)
  for (const f of r.flags) {
    if (f === 'watch_not_applicable') parts.push('此層 list.json 無對應')
    else if (f === 'watch_unmatched') parts.push('list.json 查無此 channel×機種')
    else if (f === 'watch_missing') parts.push('來源未提供門檻')
    else if (f === 'watch_conflict') parts.push('範圍衝突，無法唯一判定')
    else if (f === 'watch_partial') parts.push('部分辨識機未設此層')
    else if (f === 'half_range') parts.push('來源只設了單邊')
    else if (f === 'watch_unavailable') parts.push('list.json 這次未取得')
    else if (f === 'manual_mismatch') parts.push('手動設定與 list.json 不一致')
  }
  return parts.join('｜')
}

export interface CoverageRow { gameid: string; role: WatchRole; source: ThresholdSource; flags: ThresholdFlag[] }

/**
 * 覆蓋率以**目前監控對象**為分母（CodeX review）——不是用 list.json 自己的統計，
 * 否則 list.json 裡完全不存在的機種會從分母消失，看起來覆蓋得比實際好。
 */
export function summarizeCoverage(rows: CoverageRow[]) {
  // 只算「有被指定給最大／第二大」的那些列——沒指定的等級 list.json 本來就沒有，
  // 算進分母的話覆蓋率會被無關的等級稀釋
  const watchRows = rows.filter(r => r.role !== null)
  const byGame = new Map<string, CoverageRow[]>()
  for (const r of watchRows) {
    const list = byGame.get(r.gameid) ?? []
    list.push(r)
    byGame.set(r.gameid, list)
  }
  let full = 0, partial = 0, none = 0, conflict = 0, unmatched = 0
  for (const [, list] of byGame) {
    const fromWatch = list.filter(r => r.source === 'watch' || r.source === 'watch_stale').length
    if (list.some(r => r.flags.includes('watch_conflict'))) conflict++
    if (list.every(r => r.flags.includes('watch_unmatched'))) unmatched++
    if (fromWatch === list.length) full++
    else if (fromWatch > 0) partial++
    else none++
  }
  return { games: byGame.size, full, partial, none, conflict, unmatched }
}
