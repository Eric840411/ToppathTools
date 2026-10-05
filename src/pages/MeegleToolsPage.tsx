import { useEffect, useState } from 'react'
import type { AccountInfo } from '../accountTypes'
import { MeegleBatchCreateTab } from './MeegleBatchCreateTab'
import { MeegleBatchCommentTab } from './MeegleBatchCommentTab'
import { MeegleBatchStatusTab } from './MeegleBatchStatusTab'
import { MeegleBatchEditTab } from './MeegleBatchEditTab'
import { MeegleBackfillTab } from './MeegleBackfillTab'
import { MeegleSpaceBar } from '../components/MeegleSpace'
import { DEFAULT_MEEGLE_SPACE, isMeegleSpace, type MeegleSpace } from '../../shared/meegle-space'

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

/**
 * 雙空間（v5.10.0，CodeX 2026-10-05）：**每個分頁各自記住**選的空間；沒選過的分頁拿「最後一次選的」當初始值。
 * 不用全域狀態同步——在 A 分頁切到正式，不能把 B 分頁已經選好的改掉。
 * 切換空間＝那個分頁整個重來（用 key 重新掛載）：需求、人員、狀態選擇、預覽一起清掉，
 * 舊空間晚回來的請求也只會落到已經卸載的元件，蓋不到新畫面。
 */
type SpaceTab = Exclude<TabKey, 'backfill'>
const SPACE_KEY = (t: SpaceTab) => `meegle-tools-space-${t}`
const LAST_SPACE_KEY = 'meegle-tools-space-last'
function readSpace(key: string): MeegleSpace | null {
  try { const v = localStorage.getItem(key); return isMeegleSpace(v) ? v : null } catch { return null }
}

export function MeegleToolsPage({ isAdmin = false, permissions = [] }: { account?: AccountInfo | null; isAdmin?: boolean; permissions?: string[] }) {
  const [tab, setTab] = useState<TabKey>(() => {
    try { const t = localStorage.getItem('meegle-tools-tab'); return (TABS.some(x => x.key === t) ? t : 'create') as TabKey } catch { return 'create' }
  })
  const pick = (t: TabKey) => { setTab(t); setBusy(false); try { localStorage.setItem('meegle-tools-tab', t) } catch { /* 無痕視窗等 */ } }
  const [lastSheet, setLastSheet] = useState(readLastSheet)
  const onSheetLoaded = (url: string) => { setLastSheet(url); try { localStorage.setItem(LAST_SHEET_KEY, url) } catch { /* 無痕視窗等 */ } }
  const [spaces, setSpaces] = useState<Partial<Record<SpaceTab, MeegleSpace>>>(() => {
    const out: Partial<Record<SpaceTab, MeegleSpace>> = {}
    for (const t of ['create', 'comment', 'status', 'edit'] as const) { const v = readSpace(SPACE_KEY(t)); if (v) out[t] = v }
    return out
  })
  const [lastSpace, setLastSpace] = useState<MeegleSpace>(() => readSpace(LAST_SPACE_KEY) ?? DEFAULT_MEEGLE_SPACE)
  const spaceOf = (t: SpaceTab) => spaces[t] ?? lastSpace
  const pickSpace = (t: SpaceTab, s: MeegleSpace) => {
    setSpaces(m => ({ ...m, [t]: s })); setLastSpace(s); setBusy(false)
    try { localStorage.setItem(SPACE_KEY(t), s); localStorage.setItem(LAST_SPACE_KEY, s) } catch { /* 無痕視窗等 */ }
  }
  // 第一次進某個分頁就把當下的初始值存成它自己的：不然它一直跟著 lastSpace 走，
  // 在別頁選正式再回來，這頁沒動過也會變成正式（CodeX review 025fe7c [P2]）
  useEffect(() => {
    if (tab === 'backfill' || spaces[tab]) return
    const s = lastSpace
    setSpaces(m => (m[tab] ? m : { ...m, [tab]: s }))
    try { localStorage.setItem(SPACE_KEY(tab), s) } catch { /* 無痕視窗等 */ }
  }, [tab, spaces, lastSpace])
  // 分頁送出中 → 不能切空間（切了會把送到一半的畫面整個卸掉）
  const [busy, setBusy] = useState(false)
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
      {tab !== 'backfill' && <MeegleSpaceBar space={spaceOf(tab)} onChange={s => pickSpace(tab, s)} disabled={busy} />}
      {tab === 'create' && <MeegleBatchCreateTab key={`create:${spaceOf('create')}`} space={spaceOf('create')} onBusyChange={setBusy} initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'comment' && <MeegleBatchCommentTab key={`comment:${spaceOf('comment')}`} space={spaceOf('comment')} onBusyChange={setBusy} initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} canAiFormat={canAiFormat} canAiReview={canAiReview} />}
      {tab === 'status' && <MeegleBatchStatusTab key={`status:${spaceOf('status')}`} space={spaceOf('status')} onBusyChange={setBusy} initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'edit' && <MeegleBatchEditTab key={`edit:${spaceOf('edit')}`} space={spaceOf('edit')} onBusyChange={setBusy} initialSheetUrl={lastSheet} onSheetLoaded={onSheetLoaded} />}
      {tab === 'backfill' && <MeegleBackfillTab />}
    </div>
  )
}
