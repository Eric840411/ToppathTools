import { memo } from 'react'
import type { CSSProperties } from 'react'

/**
 * 修仙版「文字浮現」——逐字進場。
 *
 * ⚠️ 只在修仙版使用。這個元件本身不判斷模式，呼叫端要 gate 在
 *    `themeMode === 'xianxia'`——CSS 那邊有 `App.tsx` 整份移除當保護，
 *    JSX 沒有，漏 gate 就會在普通版長出一堆莫名其妙的 <span>。
 *
 * ⚠️ 延遲用 inline `--i` 交給 CSS 算，不是 `:nth-child(n)`。
 *    mockup 原本的寫法只列到第 8 個字，超過的字**永遠停在 opacity:0**
 *    ——整句後半段直接看不見，而且不會有任何錯誤訊息。
 *
 * ⚠️ 呼叫端要給 `key={text}`，否則父元件每次 re-render（例如 Dashboard
 *    每 30 秒輪詢）都會重跑一次進場動畫，變成畫面一直在閃。
 */
function XianxiaRevealInner({ text, className, style }: {
  text: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span className={`xx-reveal${className ? ' ' + className : ''}`} style={style}>
      {Array.from(text).map((ch, i) => (
        <span className="xx-w" key={i} style={{ '--i': i } as CSSProperties}>{ch}</span>
      ))}
    </span>
  )
}

export const XianxiaReveal = memo(XianxiaRevealInner)
