import { useEffect, useRef, useState } from 'react'

type ThemeMode = 'classic' | 'xianxia'

/**
 * 圖片比對、Bonus V2 用的 iframe（內容是後端吐的獨立 HTML）。
 * - 首次載入用 ?ui=redesign&theme= 告訴裡面現在的外框與模式
 * - 之後切模式只用 postMessage 通知，**不改 src、不換 key**：重載會清掉擷取結果與 SSE 連線
 * - 裡面載完會送 toppath-frame-ready，這裡補送一次最新模式（避免載入期間切過模式漏接）
 * - 沒給 themeMode（GameApp 等別的外框）→ 不帶參數、不送訊息，iframe 維持原本長相
 * 接收端在 server/static/redesign-frame.js。（CodeX 1102 定案 B）
 */
export function RedesignFrame({ src, title, themeMode }: { src: string; title: string; themeMode?: ThemeMode }) {
  const ref = useRef<HTMLIFrameElement>(null)
  // 只取第一次的模式組網址；之後模式變了也不能讓 src 變
  const [initialSrc] = useState(() => themeMode ? `${src}${src.includes('?') ? '&' : '?'}ui=redesign&theme=${themeMode}` : src)
  const latest = useRef(themeMode)
  latest.current = themeMode

  const send = (theme: ThemeMode | undefined) => {
    if (!theme) return
    ref.current?.contentWindow?.postMessage({ type: 'toppath-frame-theme', ui: 'redesign', theme }, window.location.origin)
  }

  useEffect(() => { send(themeMode) }, [themeMode])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== ref.current?.contentWindow) return
      if (e.data && e.data.type === 'toppath-frame-ready') send(latest.current)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <iframe
      ref={ref}
      src={initialSrc}
      className="rd-frame"
      style={{ flex: 1, border: 'none', width: '100%', display: 'block', minHeight: 0 }}
      title={title}
    />
  )
}
