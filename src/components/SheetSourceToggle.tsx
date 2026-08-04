import type { SheetSource } from '../pages/JiraPage'

/**
 * Lark Spreadsheet / Google Sheets 來源切換按鈕組——4 個批量工具（批量開單/
 * 評論/更新狀態/修改）的 Step 1 都有這一模一樣的兩顆按鈕，只有 state 變數
 * 名字不同，抽成共用元件。
 *
 * 只抽這個按鈕組，不含後面的 URL 輸入框——4 個工具的輸入框版面（inline 按鈕
 * vs 獨立一行、placeholder 文字、鍵盤送出綁定）差異夠大，硬塞進同一個元件
 * 反而會需要一堆條件參數，不划算。
 */
export function SheetSourceToggle({ value, onChange }: {
  value: SheetSource
  onChange: (source: SheetSource) => void
}) {
  return (
    <div className="source-toggle">
      <button type="button" className={`source-btn source-btn--step${value === 'lark' ? ' active' : ''}`}
        onClick={() => onChange('lark')}>
        <span className="source-icon lark-icon">L</span>Lark Spreadsheet
      </button>
      <button type="button" className={`source-btn source-btn--step${value === 'google' ? ' active' : ''}`}
        onClick={() => onChange('google')}>
        <span className="source-icon google-icon">G</span>Google Sheets
      </button>
    </div>
  )
}
