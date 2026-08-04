import type { ReactNode } from 'react'
import { XianxiaIcon } from './XianxiaIcon'

/** 各步驟操作說明卡片——可摺疊說明樣式，JiraPage 各批量工具共用 */
export function StepGuide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="jira-sheet-guide" style={{ marginBottom: 20, maxWidth: '100%' }}>
      <details>
        <summary className="jira-sheet-guide-summary"><XianxiaIcon name="guide" size={17} /> {title}</summary>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#94a3b8', lineHeight: 1.7, wordBreak: 'break-word' }}>
          {children}
        </ul>
      </details>
    </div>
  )
}

export function ReloadSheetButton({ loading, msg, onClick }: { loading: boolean; msg: string; onClick: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button type="button"
        onClick={onClick}
        disabled={loading}
        title="重新從 Sheet 讀取最新資料，不會中斷目前的操作進度"
        style={{
          fontSize: 12, padding: '4px 10px', borderRadius: 6,
          border: '1px solid #2d3f55', background: loading ? '#1e293b' : '#132033',
          color: loading ? '#475569' : '#94a3b8', cursor: loading ? 'default' : 'pointer',
          whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
        {loading ? '讀取中…' : '更新 重新讀取 Sheet'}
      </button>
      {msg && <span style={{ fontSize: 11, color: '#4ade80' }}>{msg}</span>}
    </span>
  )
}
