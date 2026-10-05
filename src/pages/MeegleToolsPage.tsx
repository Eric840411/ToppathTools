import { useState } from 'react'
import type { AccountInfo } from '../accountTypes'
import { MeegleBatchCreateTab } from './MeegleBatchCreateTab'
import { MeegleBatchCommentTab } from './MeegleBatchCommentTab'
import { MeegleBatchStatusTab } from './MeegleBatchStatusTab'
import { MeegleBatchEditTab } from './MeegleBatchEditTab'
import { MeegleBackfillTab } from './MeegleBackfillTab'

/**
 * Meegle 批量工具（側邊欄原本的「Jira 批量開單」，Jira 停用後只剩 Meegle 五個分頁——2026-10-02 移除 Jira 第 3 步）。
 * 原本寄住在 JiraPage 裡，Jira 程式整個刪掉後獨立成這頁。權限 key 仍是 'jira'、'jira-ai-format'、'jira-ai-review'
 * （CodeX：只改顯示名不改 key，改了大家的權限會跑掉）。
 */
const TABS = [
  { key: 'create', label: 'Meegle 開單' },
  { key: 'comment', label: 'Meegle 評論' },
  { key: 'status', label: 'Meegle 狀態' },
  { key: 'edit', label: 'Meegle 修改' },
  { key: 'backfill', label: 'Meegle 補回填' },
] as const
type TabKey = typeof TABS[number]['key']

/**
 * 各分頁共用「最後讀成功的 Sheet 網址」：在開單讀過一份，切到評論／狀態／修改會自動帶入。
 * Jira 時代就有這個行為，v5.0.0 搬出 Jira 時每個分頁都改成傳空字串，這個功能就不見了（使用者 2026-10-05 回報）。
 * 存 localStorage：重整頁面也帶得回來（只是方便，讀不到就空白，不影響功能）。
 */
const LAST_SHEET_KEY = 'meegle-tools-last-sheet'
const readLastSheet = () => { try { return localStorage.getItem(LAST_SHEET_KEY) ?? '' } catch { return '' } }

export function MeegleToolsPage({ isAdmin = false, permissions = [] }: { account?: AccountInfo | null; isAdmin?: boolean; permissions?: string[] }) {
  const [tab, setTab] = useState<TabKey>(() => {
    try { const t = localStorage.getItem('meegle-tools-tab'); return (TABS.some(x => x.key === t) ? t : 'create') as TabKey } catch { return 'create' }
  })
  const pick = (t: TabKey) => { setTab(t); try { localStorage.setItem('meegle-tools-tab', t) } catch { /* 無痕視窗等 */ } }
  const [lastSheet, setLastSheet] = useState(readLastSheet)
  const onSheetLoaded = (url: string) => { setLastSheet(url); try { localStorage.setItem(LAST_SHEET_KEY, url) } catch { /* 無痕視窗等 */ } }
  const canAiFormat = isAdmin || permissions.includes('jira-ai-format')
  const canAiReview = isAdmin || permissions.includes('jira-ai-review')
  return (
    <div className="page-layout">
      <div style={{ display: 'flex', gap: 8, padding: '6px 0 2px', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => pick(t.key)}
            style={{
              padding: '5px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${tab === t.key ? '#3b82f6' : '#2d3f55'}`,
              background: tab === t.key ? '#1e3a5f' : 'transparent',
              color: tab === t.key ? '#93c5fd' : '#64748b',
            }}
          >{t.label}</button>
        ))}
      </div>
      {tab === 'create' && <MeegleBatchCreateTab initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'comment' && <MeegleBatchCommentTab initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} canAiFormat={canAiFormat} canAiReview={canAiReview} />}
      {tab === 'status' && <MeegleBatchStatusTab initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'edit' && <MeegleBatchEditTab initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'backfill' && <MeegleBackfillTab />}
    </div>
  )
}
