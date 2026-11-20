/**
 * OSM 環境導航（第一階段預覽）：整頁內容由 /osm-env-nav/page 下發（server 驗登入＋osm-env-nav 權限），
 * 這裡只負責放 iframe 並把普通版／仙俠版帶過去。說明見 docs/features/36-osm-env-nav.md。
 */
type ThemeMode = 'classic' | 'xianxia'

export function OsmEnvNavPage({ themeMode }: { themeMode: ThemeMode }) {
  const src = `/osm-env-nav/page?embed=1&theme=${themeMode}`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: 'calc(100vh - 210px)', minHeight: 480 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted, #8aa0bf)' }}>
        預覽版：頁內的新增／編輯／拖動排序只在這個畫面有效，重新整理就會還原，不會存到伺服器。
      </div>
      <iframe
        key={themeMode}
        title="OSM 環境導航"
        src={src}
        style={{ flex: 1, width: '100%', border: 0, borderRadius: 10, background: 'transparent' }}
      />
    </div>
  )
}
