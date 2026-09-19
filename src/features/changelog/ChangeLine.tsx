import { CHANGE_TYPE_COLORS, parseChangeLine, renderInline } from './entry-format'

/**
 * 更新日誌的一行。**彈窗與整頁共用這一個元件**——原本兩邊各自有一份
 * 一模一樣的 regex 與樣式，改一邊另一邊就會不一樣。
 */
export function ChangeLine({ line }: { line: string }) {
  const parsed = parseChangeLine(line)
  const color = parsed.type ? CHANGE_TYPE_COLORS[parsed.type] ?? '#94a3b8' : ''
  const body = renderInline(parsed.text).map((token, i) => {
    if (token.kind === 'bold') return <b key={i} style={{ color: '#e2e8f0' }}>{token.value}</b>
    if (token.kind === 'code') {
      return (
        <code key={i} style={{
          padding: '1px 5px', borderRadius: 4,
          background: 'rgba(148,163,184,.16)', color: '#cbd5e1',
          fontFamily: 'Consolas, Monaco, monospace', fontSize: '.92em',
        }}>{token.value}</code>
      )
    }
    return <span key={i}>{token.value}</span>
  })

  // 沒有標籤的行（純說明、補充）：不畫色塊，但行內語法一樣要渲染
  if (!parsed.type) {
    return <li style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.55 }}>{body}</li>
  }

  return (
    <li style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.55, listStyle: 'none', marginLeft: -18 }}>
      {/* emoji 放在色塊之前——它是寫的人標的輕重，不該被吃掉 */}
      {parsed.emoji && <span style={{ marginRight: 5 }}>{parsed.emoji}</span>}
      <span style={{
        fontSize: 11, fontWeight: 700, color,
        background: `${color}18`, border: `1px solid ${color}30`,
        borderRadius: 4, padding: '1px 6px',
        marginRight: 7, fontFamily: 'monospace', letterSpacing: '.3px',
        whiteSpace: 'nowrap',
      }}>
        {parsed.type}{parsed.scope}
      </span>
      {body}
    </li>
  )
}
