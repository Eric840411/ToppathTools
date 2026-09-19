/**
 * 告警設定視窗裡「輸入框下方那行 list.json 對照值」要顯示哪一種狀態。
 *
 * ⚠️ **四種「沒有數字」必須是四種狀態，不可以合併成一句「—」或「未提供」。**
 *    它們的後續動作完全不同：
 *      `not_applicable` → 這一層 list.json 根本沒有（Minor/Mini/Fortunate），永遠不會有值
 *      `unmatched`      → list.json 裡沒有這個 channel×機種，要去 list.json 加這台
 *      `missing`        → 有這個機種但沒設門檻，要去 list.json 補範圍
 *      `conflict`       → 多台辨識機給不同範圍，要去修到一致（我們不挑、也不合成）
 *    合併之後畫面上全都長一樣，看到的人只會覺得「這功能壞了」。
 */

export type JpLevelName = 'grand' | 'major' | 'minor' | 'mini' | 'fortunate'

/**
 * 這個等級對到 list.json 的哪個池。
 * ⚠️ **哪一層是「最大獎池」每款遊戲不一樣**（有些是 Grand、有些是 Fortunate、有些沒有第二層），
 *    所以這裡收 role 而不是等級名稱——寫死 grand/major 的話，設定改了畫面也不會跟著改。
 */
export type WatchRole = 'top' | 'second' | null

export interface WatchThresholdRow {
  grand: { min?: number; max?: number } | null
  major: { min?: number; max?: number } | null
  grandConflict: boolean
  majorConflict: boolean
  matched: boolean
  servers: string[]
  /** 這個機種出現在哪些 channel（顯示用）。⚠️ 比對不看 channel */
  channels?: string[]
}

export type WatchCompareState =
  | { kind: 'loading' }
  | { kind: 'not_applicable' }
  | { kind: 'unmatched' }
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'value'; value: number; differs: boolean; servers: string[]; channels: string[] }

export function watchCompareState(
  row: WatchThresholdRow | undefined,
  role: WatchRole,
  bound: 'min' | 'max',
  current: number,
): WatchCompareState {
  if (role === null) return { kind: 'not_applicable' }
  // ⚠️ undefined 是「還沒回來」，跟「查無此機種」不同；當成 unmatched 的話，
  //    讀取中的那一瞬間會謊稱 list.json 沒有這台
  if (!row) return { kind: 'loading' }
  if (!row.matched) return { kind: 'unmatched' }
  if (role === 'top' ? row.grandConflict : row.majorConflict) return { kind: 'conflict' }
  const range = role === 'top' ? row.grand : row.major
  const value = range?.[bound]
  if (value === undefined || value === null) return { kind: 'missing' }
  return { kind: 'value', value, differs: value !== current, servers: row.servers, channels: row.channels ?? [] }
}
