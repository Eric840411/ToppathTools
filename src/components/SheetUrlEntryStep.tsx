import type { ReactNode } from 'react'
import { StepGuide } from './JiraStepWidgets'
import { SheetSourceToggle } from './SheetSourceToggle'
import type { SheetSource } from '../pages/JiraPage'

/**
 * 批量評論/批量更新狀態/批量修改 3 個工具的 Step 1（貼 Sheet URL）畫面——
 * 標題、說明文字、guide 內容不同，但版面結構（來源切換 → 錯誤訊息 →
 * URL 輸入框 + 讀取按鈕 → 操作說明）完全一樣，抽成共用元件。
 *
 * 批量開單的 Step 2 沒有用這個元件——它的版面明顯不同（欄位用 .field
 * label 包、讀取按鈕獨立在最下面一整排、多一大塊「Sheet 欄位說明」表格），
 * 硬套同一個元件會需要一堆例外參數，不划算，維持它自己的實作。
 */
export function SheetUrlEntryStep({
  title, description, source, onSourceChange, url, onUrlChange, error, loading, onSubmit,
  larkPlaceholder = 'https://casinoplus.sg.larksuite.com/wiki/... 或 Lark Sheet URL',
  googlePlaceholder = 'https://docs.google.com/spreadsheets/d/xxx/edit#gid=0',
  guideTitle, children,
}: {
  title: string
  description: string
  source: SheetSource
  onSourceChange: (s: SheetSource) => void
  url: string
  onUrlChange: (v: string) => void
  error: string
  loading: boolean
  onSubmit: () => void
  larkPlaceholder?: string
  googlePlaceholder?: string
  guideTitle: string
  children: ReactNode
}) {
  return (
    <div className="section-card">
      <h2 className="section-title">{title}</h2>
      <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
        {description}
      </p>
      <SheetSourceToggle value={source} onChange={onSourceChange} />
      {error && <div className="alert-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          value={url}
          onChange={e => onUrlChange(e.target.value)}
          placeholder={source === 'lark' ? larkPlaceholder : googlePlaceholder}
          style={{ flex: 1, padding: '7px 12px', borderRadius: 6, border: '1px solid #2d3f55', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
        />
        <button
          type="button"
          className="submit-btn submit-btn--step"
          disabled={loading || !url.trim()}
          onClick={onSubmit}
          style={{ whiteSpace: 'nowrap' }}
        >
          {loading ? '讀取中…' : '讀取'}
        </button>
      </div>

      <StepGuide title={guideTitle}>
        {children}
      </StepGuide>
    </div>
  )
}
