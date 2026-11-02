import { useEffect, useState, type CSSProperties } from 'react'
import './OfficePage.css'

/**
 * 文書工具：把 Eric Office（craft-office 的 13 個 WASM 工具）嵌進 Toppath。
 * 靜態檔由後端 /office/<app>/ 送出，登入與「office」權限在後端驗（server/routes/office.ts）。
 *
 * - 開過的工具保留在分頁裡（iframe 不卸載），切換不會遺失未存的內容；
 *   但 WASM 很吃記憶體，同時最多 MAX_OPEN 個，滿了請使用者自己關一個，不自動踢掉（會丟未存的內容）。
 * - Film／Effect 需要 cross-origin isolation，iframe 拿不到，改開新分頁（CodeX 2026-11-02）。
 */

type OfficeApp = { id: string; label: string; group: string; isolate: boolean }
type AppsResponse = { ok: boolean; deployed: boolean; release: string | null; apps: OfficeApp[]; message?: string }

const MAX_OPEN = 3

const ICONS: Record<string, string> = {
  word: 'word.svg', excel: 'excel.svg', ppt: 'ppt.png', pdf: 'pdf.svg',
  photo: 'photo.png', light: 'light.png', vector: 'vector.png', design: 'design.png', fig: 'fig.png', cad: 'cad.png',
  film: 'film.png', effect: 'effect.png', sound: 'sound.png',
}
const ACCENT: Record<string, string> = {
  word: '#4f7cf0', excel: '#2fa36b', ppt: '#e2763a', pdf: '#d9534f',
  photo: '#3b9be8', light: '#e8b73b', vector: '#e86a3b', design: '#c94fd1', fig: '#9b6cf0', cad: '#3bc6c6',
  film: '#5b6cf0', effect: '#e84f8a', sound: '#4fd18a',
}

function AppIcon({ id, size }: { id: string; size: number }) {
  return <img src={`/office-icons/${ICONS[id] ?? 'word.svg'}`} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}

export function OfficePage({ themeMode }: { themeMode: 'classic' | 'xianxia' }) {
  const [data, setData] = useState<AppsResponse | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/api/office/apps')
      .then(async r => {
        const d = await r.json().catch(() => null) as AppsResponse | null
        if (!alive) return
        if (!r.ok || !d?.ok) setError(d?.message || `讀取工具清單失敗（HTTP ${r.status}）`)
        else setData(d)
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  const apps = data?.apps ?? []
  const groups = [...new Set(apps.map(a => a.group))]
  const byId = (id: string) => apps.find(a => a.id === id)

  function launch(app: OfficeApp) {
    setNotice('')
    if (app.isolate) {
      window.open(`/office/${app.id}/`, '_blank', 'noopener')
      return
    }
    if (open.includes(app.id)) { setCurrent(app.id); return }
    if (open.length >= MAX_OPEN) {
      setNotice(`同時最多開 ${MAX_OPEN} 個工具（很吃記憶體）。請先存檔並關掉一個，再開 ${app.label}。`)
      return
    }
    setOpen([...open, app.id])
    setCurrent(app.id)
  }

  function close(id: string) {
    const app = byId(id)
    if (!window.confirm(`關閉 ${app?.label ?? id}？沒存的內容會不見。`)) return
    const next = open.filter(x => x !== id)
    setOpen(next)
    if (current === id) setCurrent(next[next.length - 1] ?? null)
    setNotice('')
  }

  const xx = themeMode === 'xianxia'

  return (
    <div className="office-page">
      {error && <div className="office-alert">{error}</div>}
      {!error && !data && <div className="office-muted">讀取工具清單中…</div>}
      {data && !data.deployed && (
        <section className="section-card office-empty">
          <h2 className="section-title">文書工具尚未部署</h2>
          <p>伺服器上還沒有 Eric Office 的檔案。部署步驟見 docs/features/34-office.md。</p>
        </section>
      )}

      {data?.deployed && (
        <>
          <section className="section-card">
            <div className="office-head">
              <h2 className="section-title">{xx ? '文房四寶' : '工具'}</h2>
              <span className="office-muted">檔案在瀏覽器本機處理，不會上傳到 Toppath 伺服器{data.release ? ` · 版本 ${data.release}` : ''}</span>
            </div>
            {groups.map(g => (
              <div key={g} className="office-group">
                <div className="office-group-label">{g}</div>
                <div className="office-apps">
                  {apps.filter(a => a.group === g).map(a => (
                    <button
                      key={a.id}
                      type="button"
                      className={`office-app${open.includes(a.id) ? ' office-app--open' : ''}`}
                      style={{ '--office-accent': ACCENT[a.id] ?? '#4f7cf0' } as CSSProperties}
                      onClick={() => launch(a)}
                      title={a.isolate ? `${a.label} 需要獨立分頁才能執行，會在新分頁開啟` : `開啟 ${a.label}`}
                    >
                      <AppIcon id={a.id} size={30} />
                      <span>{a.label}</span>
                      {a.isolate && <em className="office-app-tag">新分頁</em>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {notice && <div className="office-notice">{notice}</div>}
          </section>

          <section className="section-card office-ws">
            <div className="office-tabs" role="tablist">
              {open.length === 0 && <span className="office-muted">點上面的工具開啟；開過的會留在這排，切換不會遺失未存的內容（最多 {MAX_OPEN} 個）</span>}
              {open.map(id => {
                const a = byId(id)
                return (
                  <div key={id} className="office-tab" role="tab" aria-selected={current === id} style={{ '--office-accent': ACCENT[id] ?? '#4f7cf0' } as CSSProperties}>
                    <button type="button" className="office-tab-main" onClick={() => setCurrent(id)}>
                      <AppIcon id={id} size={16} />{a?.label ?? id}
                    </button>
                    <button type="button" className="office-tab-close" aria-label={`關閉 ${a?.label ?? id}`} onClick={() => close(id)}>×</button>
                  </div>
                )
              })}
            </div>
            <div className="office-area">
              {open.length === 0 && <div className="office-placeholder">開啟的工具會顯示在這裡</div>}
              {open.map(id => (
                <iframe
                  key={id}
                  className={`office-frame${current === id ? ' office-frame--active' : ''}`}
                  src={`/office/${id}/`}
                  title={byId(id)?.label ?? id}
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
