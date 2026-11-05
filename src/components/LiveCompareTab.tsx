import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import '../redesign/pages/live-compare.css'

/**
 * AutoSpin「即時對照」：跑的當下逐台比 AutoSpin／Game Record／Instant Meter。
 * 版面依 CodeX 2026-11-04 設計圖；判定規則在 server/live-compare-core.ts。
 *
 * ⚠️ 讀不到、快取值一律顯示「—」，不能顯示成 0。
 */

type Status = 'match' | 'pending' | 'mismatch' | 'cache' | 'unreadable'
interface Side { count: number | null; amount: number | null }
interface Row {
  sessionId: string; gmid: string; machineType: string; channelId: string; channelName: string
  clientMachineName: string; username: string; status: Status; reason: string
  startedAt: number; t0: number | null
  as: Side & { betKnown: number; readAt: number }
  asSinceT0: (Side & { betKnown: number }) | null
  gr: (Side & { readAt: number }) | null; grError?: string
  meter: (Side & { readAt: number }) | null; meterError?: string
  meterCached: boolean; cacheHourStr: string
  meterStart: { gamesPlayed: number; coinIn: number } | null
  meterNow: { gamesPlayed: number; coinIn: number } | null
  denom: number | null
  grMinusAs: Side; meterMinusAs: Side
}
interface Resp { ok: boolean; running: boolean; startedAt: number | null; polledAt: number; rows: Row[]; error?: string; message?: string }

const STATUS_LABEL: Record<Status, string> = { match: '一致', pending: '等待入帳', mismatch: '不一致', cache: '快取不可比', unreadable: '讀不到' }
const STATUS_ORDER: Status[] = ['match', 'pending', 'mismatch', 'cache', 'unreadable']
const INTERVALS = [30, 60] as const

const fmtN = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US')
const fmtA = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtD = (v: number | null | undefined, money = false) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${money ? fmtA(Math.abs(v)) : fmtN(Math.abs(v))}`
const fmtT = (ms: number | null | undefined) => ms ? new Date(ms).toLocaleTimeString('zh-TW', { hour12: false }) : '—'

export default function LiveCompareTab({ userLabel }: { userLabel: string }) {
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [every, setEvery] = useState<number>(30)
  const [open, setOpen] = useState<string | null>(null)
  const [credOpen, setCredOpen] = useState(false)

  const headers = useMemo<Record<string, string>>(() => { const h: Record<string, string> = {}; if (userLabel) h['x-user-label'] = userLabel; return h }, [userLabel])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/autospin/live-compare?env=qat', { headers })
      const j = await r.json() as Resp
      if (!j.ok) { setErr(j.message || '讀取失敗'); return }
      setErr(''); setData(j)
    } catch (e) { setErr(`讀取失敗：${e}`) } finally { setLoading(false) }
  }, [headers])

  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, every * 1000)
    return () => clearInterval(t)
  }, [load, every])

  const rows = data?.rows ?? []
  const counts = STATUS_ORDER.reduce((m, s) => ({ ...m, [s]: rows.filter(r => r.status === s).length }), {} as Record<Status, number>)
  const needCred = rows.some(r => /渠道後台帳號/.test(r.meterError ?? ''))

  return (
    <div className="lc-root">
      <section className="section-card lc-panel">
        <div className="section-title lc-head">
          <span>即時對照 <small className="lc-sub">三方下注核對</small></span>
          <span className="lc-head-actions">
            <label className="lc-every">更新頻率
              <select className="lst-field" value={every} onChange={e => setEvery(Number(e.target.value))}>
                {INTERVALS.map(s => <option key={s} value={s}>{s} 秒</option>)}
              </select>
            </label>
            <button type="button" className="submit-btn lst-btn" onClick={() => void load()} disabled={loading}>{loading ? '讀取中…' : '重新整理'}</button>
          </span>
        </div>

        <div className="lc-meta">
          <i className={`lc-dot ${data?.running ? 'is-run' : ''}`} />
          {data?.running ? '執行中' : '目前沒有在跑的 AutoSpin'}
          {userLabel && <> ・ 帳號 {userLabel}</>}
          {data?.startedAt && <> ・ 本輪 {fmtT(data.startedAt)} 起</>}
          {data && <> ・ 最後輪詢 {fmtT(data.polledAt)}</>}
          <span className="lc-env">QAT</span>
        </div>

        {err && <div className="lc-banner is-fail">{err}</div>}
        {data?.error && <div className="lc-banner is-fail">{data.error}</div>}

        <div className="lc-stats">
          <div className="lc-stat"><span>監控機台</span><b>{rows.length}</b></div>
          {STATUS_ORDER.map(s => (
            <div key={s} className={`lc-stat is-${s}`}><span>{STATUS_LABEL[s]}</span><b>{counts[s]}</b></div>
          ))}
        </div>

        <div className="lc-banner is-info">渠道自動辨識（依機台編號前綴，13 個 QAT 後台）</div>
        <div className="lc-banner is-warn">Instant Meter 為整台機台累計，可能包含其他玩家；快取值不參與比對。</div>

        <div className="table-wrap lc-tbl-wrap">
          <table className="version-table lc-tbl">
            <thead>
              <tr>
                <th>機台／渠道</th>
                <th>AutoSpin<small>次數／下注總額</small></th>
                <th>Game Record<small>筆數／下注加總・本帳號</small></th>
                <th>Instant Meter<small>次數／Coin In・起點差值</small></th>
                <th>GR − AS<small>次數／金額</small></th>
                <th>Meter − AS<small>次數／金額</small></th>
                <th>狀態</th>
                <th aria-label="展開" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} className="lc-empty">{data?.running ? '還沒有收到這一輪的 spin 紀錄，第一局跑完就會出現。' : '開始 AutoSpin 後，這裡會逐台列出三邊的數字。'}</td></tr>
              )}
              {rows.map(r => {
                const key = `${r.sessionId}|${r.gmid}`
                const isOpen = open === key
                return (
                  <Fragment key={key}>
                    <tr className={`lc-row is-${r.status}`}>
                      <td><b className="lc-gmid">{r.gmid}</b><small>{r.clientMachineName || r.machineType}・{r.channelName}</small></td>
                      <td>{fmtN(r.as.count)}<small title={r.as.amount == null && r.as.count ? `${r.as.betKnown}/${r.as.count} 局推得出注額` : undefined}>{fmtA(r.as.amount)}</small></td>
                      <td>{r.gr ? <>{fmtN(r.gr.count)}<small>{fmtA(r.gr.amount)}</small></> : <>—<small>讀取失敗</small></>}</td>
                      <td>{r.meter ? <>{fmtN(r.meter.count)}<small>{fmtA(r.meter.amount)}</small></> : <>—<small>{r.meterCached ? '快取值不比較' : r.t0 == null ? '尚無起點' : '讀取失敗'}</small></>}</td>
                      <td className={diffCls(r.grMinusAs)}>{fmtD(r.grMinusAs.count)}<small>{fmtD(r.grMinusAs.amount, true)}</small></td>
                      <td className={diffCls(r.meterMinusAs)}>{r.meterCached ? <>—<small>不可比</small></> : <>{fmtD(r.meterMinusAs.count)}<small>{fmtD(r.meterMinusAs.amount, true)}</small></>}</td>
                      <td><span className={`lc-pill is-${r.status}`}>{STATUS_LABEL[r.status]}</span><small className="lc-reason">{shortReason(r)}</small></td>
                      <td><button type="button" className="btn-ghost lc-x" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>{isOpen ? '收合' : '明細'}</button></td>
                    </tr>
                    {isOpen && (
                      <tr className="lc-detail-row"><td colSpan={8}><Detail r={r} /></td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="lc-foot">
          <span>金額已按 Denom 換算；差值＝來源 − AutoSpin。AutoSpin／Game Record 從開跑算，Meter 差值從 Meter 起點算（跟起點後的 AutoSpin 局數比）。</span>
          <span>等待入帳＝有差異但還沒連續 2 輪；起點缺失、累計回退或 Denom 改變時會重設起點。</span>
        </div>
      </section>

      <SiteCred open={credOpen || needCred} onToggle={() => setCredOpen(o => !o)} highlight={needCred} onSaved={() => void load()} />
    </div>
  )
}

function diffCls(d: Side) {
  const off = (v: number | null) => v != null && Math.abs(v) > 0.005
  return off(d.count) || off(d.amount) ? 'lc-diff is-off' : 'lc-diff'
}

function shortReason(r: Row): string {
  if (r.status === 'pending') return '下一輪再確認'
  if (r.status === 'cache') return r.cacheHourStr ? `停在 ${r.cacheHourStr}` : ''
  if (r.status === 'unreadable') return r.grError ? 'Game Record' : 'Instant Meter'
  return ''
}

function Detail({ r }: { r: Row }) {
  return (
    <div className="lc-detail">
      <div className="lc-detail-h">
        <b>{r.gmid}</b>｜{STATUS_LABEL[r.status]}明細
      </div>
      <div className="lc-detail-concl"><span className={`lc-pill is-${r.status}`}>結論</span>{r.reason || '三邊一致'}
        {(r.meterMinusAs.count ?? 0) > 0 && <span className="lc-note">注意：Meter 是整台累計，多出來的可能是其他人在玩，不能直接當成漏帳。</span>}
      </div>
      <div className="lc-detail-grid">
        <div className="lc-box">
          <h4>對照範圍</h4>
          <p>{r.username || '（無帳號）'} ／ {r.channelName} ・ {r.gmid}</p>
          <p>AutoSpin／Game Record：{fmtT(r.startedAt)} 起</p>
          <p>Meter 差值：{r.t0 ? `${fmtT(r.t0)} 起` : '尚未設起點'}{r.asSinceT0 && <>（這段 AutoSpin {fmtN(r.asSinceT0.count)} 局）</>}</p>
        </div>
        <div className="lc-box">
          <h4>Meter 起點 → 現在</h4>
          {r.meterStart && r.meterNow ? <>
            <p>SAS 05　{fmtN(r.meterStart.gamesPlayed)} → {fmtN(r.meterNow.gamesPlayed)}</p>
            <p>SAS 00　{fmtN(r.meterStart.coinIn)} → {fmtN(r.meterNow.coinIn)}</p>
            <p>Denom　{r.denom ?? '—'}</p>
            <p className="lc-mono">({fmtN(r.meterNow.coinIn)} − {fmtN(r.meterStart.coinIn)}) × {r.denom} = {fmtA(r.meter?.amount)}</p>
          </> : <p>{r.meterCached ? `快取值（停在 ${r.cacheHourStr || '?'}），不設起點` : (r.meterError || '尚未設起點')}</p>}
        </div>
        <div className="lc-box">
          <h4>來源讀取時間</h4>
          <p>AutoSpin　{fmtT(r.as.readAt)}</p>
          <p>Game Record　{r.gr ? fmtT(r.gr.readAt) : `讀取失敗：${r.grError ?? ''}`}</p>
          <p>Instant Meter　{r.meter ? fmtT(r.meter.readAt) : (r.meterError ? `讀取失敗：${r.meterError}` : '—')}</p>
          {r.as.count != null && r.as.amount == null && <p className="lc-muted">AutoSpin 只有 {r.as.betKnown}/{r.as.count} 局推得出注額，下注總額不計算</p>}
        </div>
      </div>
    </div>
  )
}

/** 13 個渠道後台共用的登入帳號（主帳號只登得進自己的渠道時才需要）。存在 QAT OSM 後台設定裡。 */
function SiteCred({ open, onToggle, highlight, onSaved }: { open: boolean; onToggle: () => void; highlight: boolean; onSaved: () => void }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [hasPw, setHasPw] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    if (!open) return
    fetch('/api/osm/meter-reconcile/config?env=qat&profile=osm').then(r => r.json()).then(j => {
      if (j.ok) { setU(j.site_username || ''); setHasPw(!!j.hasSitePassword) }
    }).catch(() => {})
  }, [open])
  const save = async () => {
    setMsg('')
    const r = await fetch('/api/osm/meter-reconcile/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: 'qat', profile: 'osm', site_username: u, ...(p ? { site_password: p } : {}) }),
    })
    const j = await r.json().catch(() => ({}))
    if (j.ok) { setMsg('已儲存'); setP(''); setHasPw(hasPw || !!p); onSaved() } else setMsg(j.message || '儲存失敗')
  }
  return (
    <section className={`section-card lc-cred ${highlight ? 'is-need' : ''}`}>
      <div className="section-title lc-head">
        <span>渠道後台帳號</span>
        {!highlight && <button type="button" className="btn-ghost lst-btn" onClick={onToggle}>{open ? '收合' : '展開'}</button>}
      </div>
      {open && (
        <div className="lc-cred-body">
          <p className="field-hint">Instant Meter 要分別登入 13 個 QAT 渠道後台。Performance Meter 那組帳號只登得進自己的渠道時，在這裡填一組每個渠道都能登入的帳號；沒填就沿用那組。</p>
          <div className="lc-cred-form">
            <label>帳號<input className="lst-field" value={u} onChange={e => setU(e.target.value)} autoComplete="off" /></label>
            <label>密碼<input className="lst-field" type="password" value={p} onChange={e => setP(e.target.value)} placeholder={hasPw ? '已設定（不改就留空）' : ''} autoComplete="new-password" /></label>
            <button type="button" className="submit-btn lst-btn" onClick={() => void save()}>儲存</button>
            {msg && <span className="lc-muted">{msg}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
