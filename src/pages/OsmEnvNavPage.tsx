/**
 * OSM 環境導航（第一階段預覽）：整頁內容由 /osm-env-nav/page 下發（server 驗登入＋osm-env-nav 權限），
 * 這裡只負責放 iframe 並把普通版／仙俠版帶過去。說明見 docs/features/36-osm-env-nav.md。
 *
 * 切主題不重載 iframe（重載會把頁內還沒存的編輯清掉，CodeX 審 379cc7f P2）：
 * src 只用第一次的主題，之後直接改同源內框的 data-theme-mode。
 */
import { useEffect, useRef, useState } from 'react'

type ThemeMode = 'classic' | 'xianxia'

function applyTheme(frame: HTMLIFrameElement | null, themeMode: ThemeMode) {
  const doc = frame?.contentDocument
  if (!doc?.documentElement) return
  doc.documentElement.dataset.themeMode = themeMode
  doc.querySelectorAll<HTMLElement>('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === themeMode))
}

export function OsmEnvNavPage({ themeMode }: { themeMode: ThemeMode }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [initialTheme] = useState(themeMode)
  const src = `/osm-env-nav/page?embed=1&theme=${initialTheme}`

  useEffect(() => { applyTheme(frameRef.current, themeMode) }, [themeMode])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: 'calc(100vh - 210px)', minHeight: 480 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted, #8aa0bf)' }}>
        預覽版：頁內的新增／編輯／拖動排序只在這個畫面有效，重新整理就會還原，不會存到伺服器。
      </div>
      <iframe
        ref={frameRef}
        title="OSM 環境導航"
        src={src}
        onLoad={() => applyTheme(frameRef.current, themeMode)}
        style={{ flex: 1, width: '100%', border: 0, borderRadius: 10, background: 'transparent' }}
      />
    </div>
  )
}
