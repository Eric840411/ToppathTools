/**
 * Meegle 的兩個空間：測試開單、正式開單（使用者 2026-10-05：每頁自己切換，同一份 Sheet 不會兩邊都開）。
 * 前後端共用這一份：代號、顯示名稱、預設值（CodeX 拍板：預設測試）。
 * 空間的 project key 只在後端（server/meegle-space.ts），前端只認代號。
 */
export type MeegleSpace = 'test' | 'prod'

export const MEEGLE_SPACES: ReadonlyArray<{ key: MeegleSpace; label: string }> = [
  { key: 'test', label: '測試' },
  { key: 'prod', label: '正式' },
]

export const DEFAULT_MEEGLE_SPACE: MeegleSpace = 'test'

export const isMeegleSpace = (v: unknown): v is MeegleSpace => v === 'test' || v === 'prod'

export const meegleSpaceLabel = (s: string | null | undefined): string =>
  MEEGLE_SPACES.find(x => x.key === s)?.label ?? String(s ?? '')
