/**
 * 每日排程面板（Backend 分頁）。
 *
 * **組合式**：一個排程帶一串腳本（有順序）＋要在星期幾跑。所以
 * 「平日早上跑冒煙那三支、週五晚上跑完整一輪」用兩個排程就寫得出來。
 *
 * 🚨 **為什麼要看得到別人的排程**：只顯示自己的話，會出現「我沒排啊，怎麼自己跑了」
 *    這種查不出來的狀況。所以清單列全部，但只有建立者能改／刪。
 *
 * ⚠️ 排程是**借用建立者自己的登入 session** 去跑的（後台帳密綁帳號）。
 *    他的 session 過期排程就會停——這件事必須寫在畫面上，不能讓人以為排了就會永遠跑。
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Schedule = {
  id: string; scriptIds: string[]; owner: string; hhmm: string; site: 'cp' | 'nc'
  agentId: string; weekdays: number[]; enabled: boolean
  lastRunAt: number | null; lastStatus: string | null; mine: boolean
}

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

export function SchedulePanel({ scripts, site, agentId, onClose }: {
  scripts: Array<{ id: string; title: string }>
  site: 'cp' | 'nc'
  agentId: string
  /** 有給就會包成彈框（按 Esc 或點背景關閉） */
  onClose?: () => void
}) {
  const [rows, setRows] = useState<Schedule[]>([])
  /** 這次要組的那一串（順序就是執行順序） */
  const [picked, setPicked] = useState<string[]>([])
  const [hhmm, setHhmm] = useState('09:00')
  const [days, setDays] = useState<number[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await (await fetch('/api/osm-uat/schedules')).json() as { ok: boolean; schedules?: Schedule[]; message?: string }
      if (data.ok) setRows(data.schedules ?? [])
      else setMsg(data.message ?? '讀取排程失敗')
    } catch (error) { setMsg(error instanceof Error ? error.message : '讀取排程失敗') }
  }, [])
  useEffect(() => { void load() }, [load])

  const titleOf = (id: string) => scripts.find(s => s.id === id)?.title ?? `（已刪除的腳本 ${id.slice(0, 8)}）`
  const reset = () => { setPicked([]); setEditing(null); setDays([]); setHhmm('09:00') }

  const move = (index: number, delta: number) => {
    setPicked(current => {
      const next = [...current]
      const to = index + delta
      if (to < 0 || to >= next.length) return current
      ;[next[index], next[to]] = [next[to], next[index]]
      return next
    })
  }

  const save = async () => {
    if (!picked.length) { setMsg('至少要選一支腳本'); return }
    setMsg('')
    const response = await fetch('/api/osm-uat/schedules', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editing ?? undefined, scriptIds: picked, hhmm, weekdays: days, site, agentId, enabled: true }),
    })
    const data = await response.json() as { ok: boolean; message?: string }
    setMsg(data.ok
      ? `已排程：${days.length ? `每週${days.map(d => DAY_LABELS[d]).join('、')}` : '每天'} ${hhmm}，依序跑 ${picked.length} 支（${site.toUpperCase()}）`
      : (data.message ?? '排程失敗'))
    if (data.ok) { reset(); void load() }
  }

  const edit = (row: Schedule) => {
    setEditing(row.id); setPicked(row.scriptIds); setHhmm(row.hhmm); setDays(row.weekdays)
    setMsg('編輯中——改完按「儲存排程」')
  }
  const toggle = async (row: Schedule) => {
    await fetch('/api/osm-uat/schedules', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, scriptIds: row.scriptIds, hhmm: row.hhmm, weekdays: row.weekdays, site: row.site, agentId: row.agentId, enabled: !row.enabled }),
    })
    void load()
  }
  const remove = async (row: Schedule) => {
    await fetch(`/api/osm-uat/schedules/${row.id}`, { method: 'DELETE' })
    if (editing === row.id) reset()
    void load()
  }

  // ⚠️ Esc 要關得掉。沒有這個的話，鍵盤使用者會被一張關不掉的彈框黏住。
  useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const body = (
    <section className="uat-panel uat-schedule">
      {onClose && (
        <button type="button" className="uat-schedule-close" onClick={onClose} aria-label="關閉每日排程">✕</button>
      )}
      <div className="uat-section-title">
        <span>DAILY SCHEDULE</span>
        <h3>每日排程 <small>{rows.length}</small></h3>
        <p>到點把一組腳本<strong>依序</strong>跑完，結果照常回寫 Lark。用你自己的登入身分執行——<strong>你的登入過期時排程會停</strong>，狀態欄會寫原因。</p>
      </div>

      {/* ── 組合：先挑腳本、排順序，再決定時間與星期 ── */}
      <select className="uat-field" value="" aria-label="加入腳本"
        onChange={event => { const id = event.target.value; if (id && !picked.includes(id)) setPicked([...picked, id]) }}>
        <option value="">＋ 加入腳本…</option>
        {scripts.filter(item => !picked.includes(item.id)).map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
      </select>

      {picked.length > 0 && (
        <ol className="uat-schedule-picked">
          {picked.map((id, index) => (
            <li key={id}>
              <span>{index + 1}. {titleOf(id)}</span>
              <div>
                <button type="button" className="uat-btn is-quiet" disabled={!index} onClick={() => move(index, -1)} aria-label="上移">↑</button>
                <button type="button" className="uat-btn is-quiet" disabled={index === picked.length - 1} onClick={() => move(index, 1)} aria-label="下移">↓</button>
                <button type="button" className="uat-btn is-quiet" onClick={() => setPicked(picked.filter(x => x !== id))} aria-label="移除">✕</button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="uat-schedule-days" role="group" aria-label="星期">
        {DAY_LABELS.map((label, day) => (
          <button type="button" key={label}
            className={days.includes(day) ? 'is-on' : ''}
            onClick={() => setDays(days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort())}>
            {label}
          </button>
        ))}
        <small>{days.length ? '' : '一天都沒選＝每天跑'}</small>
      </div>

      <div className="uat-schedule-form">
        <input className="uat-field" type="time" value={hhmm} onChange={event => setHhmm(event.target.value)} aria-label="幾點跑" />
        <button type="button" className="uat-btn is-primary" onClick={() => void save()}>{editing ? '儲存排程' : '加入排程'}</button>
        {editing && <button type="button" className="uat-btn is-quiet" onClick={reset}>取消編輯</button>}
      </div>
      <small className="uat-hint">會用目前「執行設定」選的站台（{site.toUpperCase()}）與執行位置。一支跑完才跑下一支——UAT 一次只能有一個執行中的測試。</small>
      {msg && <p className="uat-schedule-msg">{msg}</p>}

      <div className="uat-schedule-list">
        {rows.map(row => (
          <div className={`uat-schedule-row${row.enabled ? '' : ' is-off'}`} key={row.id}>
            <div>
              <strong>{row.hhmm}</strong>
              <span>{row.weekdays.length ? `每週${row.weekdays.map(d => DAY_LABELS[d]).join('、')}` : '每天'}・{row.scriptIds.length} 支</span>
              <small>{row.scriptIds.map((id, i) => `${i + 1}. ${titleOf(id)}`).join('　')}</small>
              <small>{row.site.toUpperCase()}・{row.owner}{row.lastRunAt ? `・上次 ${new Date(row.lastRunAt).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : '・尚未跑過'}</small>
              {row.lastStatus && <em>{row.lastStatus}</em>}
            </div>
            {row.mine
              ? <div className="uat-schedule-actions">
                <button type="button" className="uat-btn is-quiet" onClick={() => edit(row)}>編輯</button>
                <button type="button" className="uat-btn is-quiet" onClick={() => void toggle(row)}>{row.enabled ? '停用' : '啟用'}</button>
                <button type="button" className="uat-btn is-quiet" onClick={() => void remove(row)}>刪除</button>
              </div>
              : <span className="uat-schedule-readonly">別人建的</span>}
          </div>
        ))}
        {!rows.length && <p className="uat-list-empty">還沒有排程。挑幾支腳本排好順序、選星期與時間，就會自動跑。</p>}
      </div>
    </section>
  )

  if (!onClose) return body
  /**
   * ⚠️ 點背景才關，點到面板本身不關——否則在面板裡選日期／拖順序時手一滑就整個關掉，
   *    而且已經填好的組合會消失。
   */
  return createPortal(
    /**
     * ⚠️ **overlay 要自己帶 `uat-studio`**：portal 出去之後就不在原本那棵樹底下了，
     *    所有 `.uat-studio .xxx` 的樣式（面板底色、文字色、欄位樣式）通通不會套用——
     *    症狀是彈框整個透明、只看得到按鈕，背後的頁面透出來。
     *    （`MultiTcRecorder` 的彈框也是這樣掛的。）
     */
    <div className="uat-studio uat-schedule-overlay" role="dialog" aria-modal="true" aria-label="每日排程"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      {body}
    </div>,
    document.body,
  )
}
