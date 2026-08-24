/**
 * net-capture.js 的型別宣告。
 * 本體刻意寫成純 JS，因為 Backend runner（run-lark-tc-backend.js）是用純 node
 * 直接跑的、載不了 .ts；這份 .d.ts 只給 agent-runner.ts / frontend-auto.ts 用。
 */
import type { Page } from 'playwright'

export interface NetCaptureThresholds {
  api: number
  image: number
  other: number
}

export interface NetRecord {
  url: string
  method: string
  kind: 'api' | 'image' | 'other'
  resourceType: string
  status: number | null
  durationMs: number | null
  /** 推測值，不是事實：Playwright 沒有暴露 fromDiskCache，見本體註解 */
  likelyCached: boolean
  isRedirect: boolean
  isPreflight: boolean
  ts: number
  overThresholdMs?: number
  thresholdMs?: number
}

export interface NetFailure {
  url: string
  method: string
  kind: 'api' | 'image' | 'other'
  resourceType: string
  failure: string
  ts: number
}

export interface NetStats {
  count: number
  avgMs: number | null
  maxMs: number | null
  p95Ms: number | null
}

export interface NetSummary {
  thresholds: NetCaptureThresholds
  totals: {
    captured: number
    counted: number
    likelyCached: number
    redirects: number
    preflights: number
    failed: number
    dropped: number
  }
  api: NetStats
  image: NetStats
  other: NetStats
  slow: NetRecord[]
  slowest: NetRecord[]
  failures: NetFailure[]
}

export interface NetCollector {
  detach(): void
  records(): NetRecord[]
  summary(): NetSummary
  formatSummary(): string
}

export declare const DEFAULT_THRESHOLDS: NetCaptureThresholds

export declare function attachNetworkCapture(
  page: Page,
  options?: {
    thresholds?: Partial<NetCaptureThresholds>
    onSlow?: (record: NetRecord) => void
  },
): NetCollector

/** stdout 夾帶結構化快照用的行前綴（印的端與解析的端共用同一個常數）*/
export declare const STATS_LINE_PREFIX: string
export declare function formatStatsLine(payload: unknown): string
export declare function parseStatsLine(line: string): unknown | null

/**
 * 把 URL 收斂成可比對的樣式：拿掉 query，路徑裡的純數字／uuid／長 hex 換成 *。
 * 錄製時要記下這個，之後「把這筆 API 變成斷言」才不會因為 id/token/時間戳而對不上。
 */
export declare function toUrlPattern(rawUrl: string): string
