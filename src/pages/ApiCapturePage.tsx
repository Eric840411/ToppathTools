/**
 * API 參數紀錄（docs/features/35-api-capture.md）。版面：CodeX 2026-11 設計圖（設定列＋流程進度列＋左本次紀錄四分頁＋右與上次比對）。
 * 修仙版只換配色（CSS data-theme-mode），資訊結構不變。新版畫面不放 emoji；彈窗走 createPortal。
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { PageActions } from '../redesign/PageActions'
import { UrlPoolPickerModal } from '../components/UrlPoolPickerModal'
import './ApiCapturePage.css'

type Env = 'qat' | 'uat'
type Status = 'running' | 'collecting' | 'done' | 'incomplete' | 'failed' | 'cancelled'
interface Calibration { method: 'recordBet' | 'server-clock' | 'none'; offsetMs: number; pairs: number; spreadMs: number | null; note: string }
interface Run {
  id: string; env: Env; channelId: string; account: string; machine: string; machineKey: string; lobbyUrl: string
  stopCondition: 'payout' | 'spins'; spins: number | null; maxSpins: number | null; agentHost: string | null
  status: Status; statusLabel: string; phase: string | null; message: string | null
  startedAt: number; finishedAt: number | null; frontStartedAt: number | null; frontFinishedAt: number | null
  calibration: Calibration | null
  completeness: { front: { complete: boolean; reasons: string[] }; backend: { complete: boolean; reasons: string[]; inWindow: number; outsideWindow: number } } | null
  summary: { front?: { stopReason: string; spins: { n: number; win: number | null }[]; exitOk: boolean } } | null
  baselineRunId: string | null; operatorName: string | null; quarantined: boolean
}
interface TimelineRow { t: number; kind: 'step' | 'backend'; action: string; api: string; direction: string; req: string; res: string; source: string }
interface WsRow { t: number; source: 'frame' | 'console'; dir: string; route: string; text: string }
interface HttpRow { t: number; method: string; url: string; status: number; req: string; res: string; noise: boolean; comparable: boolean }
interface Detail { run: Run; timeline: TimelineRow[]; ws: WsRow[]; wsTotal: number; wsTruncated: boolean; http: HttpRow[]; backendOutside: { t: number; event: string }[] }
interface DiffItem { part: 'request' | 'response'; path: string; kind: 'added' | 'missing' | 'type' | 'value'; before: string; after: string; volatile: boolean }
interface ApiDiff { key: string; label: string; source: 'backend' | 'http' | 'ws'; direction: string; status: 'same' | 'changed' | 'new-api' | 'unobserved'; items: DiffItem[] }
interface Compare {
  baseline: Run | null; defaultBaselineId: string | null
  diff: { hasBaseline: boolean; counts: { added: number; missing: number; type: number; value: number; volatileIgnored: number; newApi: number; unobserved: number }; apis: ApiDiff[] } | null
  candidates: { id: string; env: Env; account: string; machine: string; status: Status; startedAt: number; sameTarget: boolean }[]
}
interface Meta { isAdmin: boolean; configured: Record<Env, { ready: boolean; channelId: string; verified: boolean }>; agents: { agentId: string; hostname: string; busy: boolean; capable: boolean; updateStatus: string }[] }

async function api<T>(method: string, url: string, body?: unknown): Promise<T & { ok: boolean; message?: string }> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  try { return await r.json() } catch { return { ok: false, message: `HTTP ${r.status}` } as T & { ok: boolean; message?: string } }
}

const ENV_LABEL: Record<Env, string> = { qat: 'QAT', uat: 'UAT' }
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
/** UTC+8 顯示（後台時鐘） */
function fmt(ms: number | null | undefined, withMs = false) {
  if (!ms) return '—'
  const d = new Date(ms + 8 * 3600_000)
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${withMs ? `.${pad(d.getUTCMilliseconds(), 3)}` : ''}`
}
function pretty(s: string) {
  const t = (s ?? '').trim()
  if (!/^[{[]/.test(t)) return s ?? ''
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return s }
}
const short = (s: string, n = 48) => { const one = (s ?? '').replace(/\s+/g, ' '); return one.length > n ? one.slice(0, n) + '…' : one }
const usernameOf = (url: string) => { try { return new URL(url).searchParams.get('username') ?? '' } catch { return '' } }

const STATUS_TEXT: Record<Status, string> = { running: '執行中', collecting: '查後台中', done: '完成', incomplete: '資料不完整', failed: '失敗', cancelled: '已取消' }
const KIND_LABEL = { added: '新增', missing: '缺少', type: '型別變更', value: '值變更' } as const
const API_STATUS_LABEL = { changed: '有差異', 'new-api': '新 API', unobserved: '未觀測', same: '相同' } as const
const STEPS = [
  { key: 'login', label: '登入大廳' },
  { key: 'enter', label: '進機台／最小注' },
  { key: 'front', label: '前台 WS／HTTP' },
  { key: 'backend', label: '後台紀錄' },
  { key: 'done', label: '彙整完成' },
] as const

function stepStates(run: Run | null): ('todo' | 'doing' | 'ok' | 'bad')[] {
  if (!run) return STEPS.map(() => 'todo')
  const order = ['login', 'enter', 'spin', 'exit', 'backend', 'done']
  const idx = order.indexOf(run.phase ?? 'login')
  const at = idx <= 0 ? 0 : idx === 1 ? 1 : idx <= 3 ? 2 : idx === 4 ? 3 : 4
  const finished = !['running', 'collecting'].includes(run.status)
  return STEPS.map((_, i) => {
    if (finished) {
      if (run.status === 'done') return 'ok'
      if (run.status === 'incomplete') {
        if (i === 2) return run.completeness?.front.complete === false ? 'bad' : 'ok'
        if (i === 3) return run.completeness?.backend.complete === false ? 'bad' : 'ok'
        return 'ok'
      }
      // 失敗／取消：前台有結束時間才算前幾步做過
      return i < (run.frontFinishedAt ? 3 : at) ? 'ok' : i === (run.frontFinishedAt ? 3 : at) ? 'bad' : 'todo'
    }
    return i < at ? 'ok' : i === at ? 'doing' : 'todo'
  })
}

function stopText(run: Run) {
  const f = run.summary?.front
  if (!f) return run.stopCondition === 'payout' ? '停止條件：有派彩' : `停止條件：${run.spins} 局`
  const n = f.spins?.length ?? 0
  return f.stopReason === 'payout' ? `第 ${n} 局派彩後停止` : f.stopReason === 'spins' ? `跑滿 ${n} 局停止` : f.stopReason === 'max-spins' ? `${n} 局仍沒派彩，達上限停止` : f.stopReason === 'cancelled' ? `取消（已跑 ${n} 局）` : `中斷（已跑 ${n} 局）`
}

export function ApiCapturePage() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [env, setEnv] = useState<Env>('qat')
  const [lobbyUrl, setLobbyUrl] = useState('')
  const [machine, setMachine] = useState('')
  const [channelId, setChannelId] = useState('')
  const [stopCondition, setStopCondition] = useState<'payout' | 'spins'>('payout')
  const [spins, setSpins] = useState(10)
  const [maxSpins, setMaxSpins] = useState(100)
  const [agentId, setAgentId] = useState('')
  const [headed, setHeaded] = useState(false)
  const [picker, setPicker] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tab, setTab] = useState<'timeline' | 'ws' | 'http' | 'info'>('timeline')
  const [picked, setPicked] = useState<number | null>(null)
  const [showNoise, setShowNoise] = useState(false)
  const [baselineSel, setBaselineSel] = useState('')
  const [ignoreVolatile, setIgnoreVolatile] = useState(true)
  const [compare, setCompare] = useState<Compare | null>(null)
  const [openApi, setOpenApi] = useState<Record<string, boolean>>({})

  const account = usernameOf(lobbyUrl)
  const run = detail?.run ?? null
  const live = !!run && ['running', 'collecting'].includes(run.status)

  const loadMeta = useCallback(async () => { const r = await api<Meta>('GET', '/api/api-capture/meta'); if (r.ok) setMeta(r) }, [])
  const loadRuns = useCallback(async () => {
    const r = await api<{ runs: Run[] }>('GET', '/api/api-capture/runs?limit=50')
    if (r.ok) { setRuns(r.runs); setRunId(cur => cur ?? r.runs[0]?.id ?? null) }
  }, [])
  useEffect(() => { void loadMeta(); void loadRuns() }, [loadMeta, loadRuns])

  const loadDetail = useCallback(async (id: string) => {
    const r = await api<Detail>('GET', `/api/api-capture/runs/${encodeURIComponent(id)}`)
    if (r.ok) setDetail(r)
    return r.ok ? r.run : null
  }, [])
  useEffect(() => {
    if (!runId) { setDetail(null); return }
    let stop = false
    let timer: number | undefined
    const tick = async () => {
      const r = await loadDetail(runId)
      if (stop) return
      if (r && ['running', 'collecting'].includes(r.status)) timer = window.setTimeout(tick, 2000)
      else void loadRuns()
    }
    setPicked(null)
    void tick()
    return () => { stop = true; if (timer) window.clearTimeout(timer) }
  }, [runId, loadDetail, loadRuns])

  useEffect(() => {
    if (!runId || live) { setCompare(null); return }
    const q = new URLSearchParams({ ignoreVolatile: ignoreVolatile ? '1' : '0' })
    if (baselineSel) q.set('baseline', baselineSel)
    void api<Compare>('GET', `/api/api-capture/runs/${encodeURIComponent(runId)}/compare?${q}`).then(r => { if (r.ok) setCompare(r) })
  }, [runId, live, baselineSel, ignoreVolatile, run?.status])

  useEffect(() => { setBaselineSel('') }, [runId])

  async function start() {
    setBusy(true); setFlash(null)
    const r = await api<{ runId: string; agent: string }>('POST', '/api/api-capture/start', { env, lobbyUrl: lobbyUrl.trim(), machine: machine.trim(), channelId: channelId.trim(), stopCondition, spins, maxSpins, agentId, headed })
    setBusy(false)
    if (!r.ok) { setFlash({ ok: false, text: r.message || '開始失敗' }); return }
    setFlash({ ok: true, text: `已派工給 ${r.agent}` })
    setRunId(r.runId); setTab('timeline')
    void loadRuns()
  }
  async function stopRun() {
    if (!run) return
    const r = await api('POST', `/api/api-capture/runs/${encodeURIComponent(run.id)}/stop`)
    setFlash(r.ok ? { ok: true, text: '已送出取消，等 agent 退出機台' } : { ok: false, text: r.message || '取消失敗' })
  }
  async function releaseQuarantine() {
    if (!run || !window.confirm('確認 agent 已經退出機台、不會再下注？解除後別人就能用這台機台與帳號。')) return
    const r = await api('POST', `/api/api-capture/runs/${encodeURIComponent(run.id)}/release`)
    setFlash(r.ok ? { ok: true, text: '已解除隔離' } : { ok: false, text: r.message || '解除失敗' })
    void loadDetail(run.id)
  }
  function exportExcel() {
    if (!run) return
    const q = new URLSearchParams({ ignoreVolatile: ignoreVolatile ? '1' : '0', noise: showNoise ? '1' : '0' })
    if (baselineSel) q.set('baseline', baselineSel)
    window.location.href = `/api/api-capture/runs/${encodeURIComponent(run.id)}/excel?${q}`
  }

  const cfg = meta?.configured[env]
  const capable = (meta?.agents ?? []).filter(a => a.capable)
  const canStart = !busy && !!lobbyUrl.trim() && !!account && !!machine.trim() && !!cfg?.ready && !live
  const states = stepStates(run)
  const httpRows = useMemo(() => (detail?.http ?? []).filter(h => showNoise || !h.noise), [detail, showNoise])
  const pickedRow = picked !== null ? detail?.timeline[picked] : null

  return (
    <div className="acp-page">
      <PageActions className="acp-actions">
        {meta?.isAdmin && <button className="acp-btn" onClick={() => setSettingsOpen(true)}>後台設定</button>}
      </PageActions>

      {/* 設定列 */}
      <section className="acp-card acp-setup">
        <div className="acp-setup-row">
          <div className="acp-field">
            <label>環境</label>
            <div className="acp-seg">
              {(['qat', 'uat'] as Env[]).map(e => <button key={e} className={env === e ? 'is-on' : ''} onClick={() => setEnv(e)}>{ENV_LABEL[e]}</button>)}
            </div>
          </div>
          <div className="acp-field acp-grow">
            <label>帳號（大廳連結）</label>
            <div className="acp-inline">
              <input className="acp-input acp-grow" placeholder="貼上含 token 的大廳連結，或從帳號池選" value={lobbyUrl} onChange={e => setLobbyUrl(e.target.value)} />
              <button className="acp-btn" onClick={() => setPicker(true)}>帳號池</button>
            </div>
            <div className="acp-hint">{lobbyUrl ? (account ? <>帳號 <b className="acp-mono">{account}</b>（後台以這個 userName 查）</> : <span className="acp-bad">連結裡沒有 username</span>) : '連結只用來開大廳，不存檔；紀錄裡的 token 一律遮成 ***'}</div>
          </div>
          <div className="acp-field">
            <label>機台</label>
            <input className="acp-input acp-w140" placeholder="144 或 DFDCGRAND-0144" value={machine} onChange={e => setMachine(e.target.value)} />
          </div>
          <div className="acp-field">
            <label>停止條件</label>
            <div className="acp-inline">
              <select className="acp-input" value={stopCondition} onChange={e => setStopCondition(e.target.value as 'payout' | 'spins')}>
                <option value="payout">有派彩</option>
                <option value="spins">固定局數</option>
              </select>
              {stopCondition === 'spins' && <input className="acp-input acp-w64" type="number" min={1} max={300} value={spins} onChange={e => setSpins(Math.max(1, Number(e.target.value) || 1))} />}
            </div>
          </div>
          <div className="acp-field">
            <label>最多局數</label>
            <input className="acp-input acp-w64" type="number" min={1} max={300} value={maxSpins} onChange={e => setMaxSpins(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div className="acp-field">
            <label>&nbsp;</label>
            {live
              ? <button className="acp-btn acp-btn--danger acp-start" onClick={stopRun}>取消這筆</button>
              : <button className="acp-btn acp-btn--primary acp-start" disabled={!canStart} onClick={start}>{busy ? '派工中…' : '開始新紀錄'}</button>}
          </div>
        </div>
        <div className="acp-setup-row acp-setup-sub">
          <span>自動登入大廳 → 進機台 → 最小注下注；達條件後停止下注、退出機台並完成紀錄</span>
          <span className="acp-sep" />
          <label className="acp-mini">渠道
            <input className="acp-input acp-w80" placeholder={cfg?.channelId ?? ''} value={channelId} onChange={e => setChannelId(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="acp-mini">Local Agent
            <select className="acp-input" value={agentId} onChange={e => setAgentId(e.target.value)}>
              <option value="">自動挑空閒的</option>
              {(meta?.agents ?? []).map(a => <option key={a.agentId} value={a.agentId} disabled={!a.capable}>{a.hostname}{a.busy ? '（忙碌）' : ''}{a.capable ? '' : '（版本太舊）'}</option>)}
            </select>
          </label>
          <label className="acp-mini"><input type="checkbox" checked={headed} onChange={e => setHeaded(e.target.checked)} /> 顯示瀏覽器視窗</label>
        </div>
        {meta && !cfg?.ready && <div className="acp-flash acp-flash--bad">{ENV_LABEL[env]} 的後台帳密還沒設定{meta.isAdmin ? '，請按右上「後台設定」填寫' : '，請洽管理員'}</div>}
        {meta && cfg && !cfg.verified && <div className="acp-note">{ENV_LABEL[env]} 的後台 Log 查詢端點尚未實測，結果若標「不完整」請回報</div>}
        {meta && !capable.length && <div className="acp-note">{meta.agents.length ? '你的 Local Agent 版本太舊、沒有這個功能：請到 Local Agent 頁按「更新程式碼」並重開 agent' : '目前沒有連線中的 Local Agent'}</div>}
        {flash && <div className={`acp-flash ${flash.ok ? 'acp-flash--ok' : 'acp-flash--bad'}`} onClick={() => setFlash(null)}>{flash.text}</div>}
      </section>

      {/* 流程進度列 */}
      <section className="acp-card acp-progress">
        <div className="acp-steps">
          {STEPS.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && <span className="acp-arrow">→</span>}
              <span className={`acp-step is-${states[i]}`}><i />{s.label}</span>
            </Fragment>
          ))}
        </div>
        {run && (
          <div className="acp-progress-meta">
            <span>本次：{fmt(run.startedAt)}</span>
            <span>{stopText(run)}</span>
            <span className={run.calibration?.method === 'recordBet' ? '' : 'acp-warn'}>
              {run.calibration ? (run.calibration.method === 'recordBet' ? '時間已校正（UTC+8）' : run.calibration.method === 'server-clock' ? '時間未以 recordBet 校正' : '時間未校正') : live ? (run.message || '執行中') : '—'}
            </span>
          </div>
        )}
      </section>

      <div className="acp-main">
        {/* 本次紀錄 */}
        <section className="acp-card acp-left">
          <div className="acp-card-head">
            <h3>本次紀錄</h3>
            <select className="acp-input acp-runsel" value={runId ?? ''} onChange={e => setRunId(e.target.value || null)}>
              {!runs.length && <option value="">還沒有紀錄</option>}
              {runs.map(r => <option key={r.id} value={r.id}>{fmt(r.startedAt)}｜{ENV_LABEL[r.env]} {r.account}｜機台 {r.machine}｜{r.statusLabel}</option>)}
            </select>
            <button className="acp-btn acp-btn--outline" disabled={!run || live} onClick={exportExcel}>匯出 Excel</button>
          </div>
          {run && (
            <div className={`acp-status acp-status--${run.status}`}>
              <b>{run.statusLabel}</b>{run.message ? `｜${run.message}` : ''}{run.agentHost ? `｜Agent ${run.agentHost}` : ''}
              {run.quarantined && <button className="acp-btn acp-btn--danger acp-release" onClick={releaseQuarantine}>人工確認已停止</button>}
            </div>
          )}
          <div className="acp-tabs">
            {([['timeline', '時間軸'], ['ws', '前台 WS'], ['http', '前台 HTTP'], ['info', '說明']] as const).map(([k, l]) => (
              <button key={k} className={`acp-tab ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>{l}
                {k === 'timeline' && detail ? <b>{detail.timeline.length}</b> : k === 'ws' && detail ? <b>{detail.wsTotal}</b> : k === 'http' && detail ? <b>{httpRows.length}</b> : null}
              </button>
            ))}
          </div>
          <div className="acp-chips">
            <span className="acp-chip">token：***</span>
            <label className="acp-chip acp-chip--toggle"><input type="checkbox" checked={!showNoise} onChange={e => setShowNoise(!e.target.checked)} /> HTTP 預設排除 GA、xtrace</label>
          </div>

          {!detail && <div className="acp-empty">{runs.length ? '載入中…' : '還沒有紀錄。填好上方設定後按「開始新紀錄」。'}</div>}

          {detail && tab === 'timeline' && (
            <>
              <div className="acp-table-wrap">
                <table className="acp-table">
                  <thead><tr><th>時間</th><th>動作</th><th>API</th><th>方向</th><th>送出參數</th><th>回傳參數</th><th>來源</th></tr></thead>
                  <tbody>
                    {detail.timeline.map((r, i) => (
                      <tr key={i} className={`${r.kind === 'backend' ? 'is-be' : 'is-step'} ${picked === i ? 'is-picked' : ''}`} onClick={() => setPicked(i)}>
                        <td className="acp-mono acp-nowrap">{fmt(r.t, true).slice(6)}</td>
                        <td className="acp-act">{r.action}</td>
                        <td className="acp-mono acp-nowrap">{r.api}</td>
                        <td className="acp-nowrap">{r.direction}</td>
                        <td className="acp-mono acp-dim acp-cell">{short(r.req)}</td>
                        <td className="acp-mono acp-dim acp-cell">{short(r.res)}</td>
                        <td className="acp-nowrap acp-dim">{r.source.split('｜')[0]}</td>
                      </tr>
                    ))}
                    {!detail.timeline.length && <tr><td colSpan={7} className="acp-empty">{live ? '前台錄製中，結束後才會查後台並彙整' : '沒有資料'}</td></tr>}
                  </tbody>
                </table>
              </div>
              {pickedRow && (
                <div className="acp-detail">
                  <div className="acp-detail-head">{pickedRow.api !== '—' ? pickedRow.api : pickedRow.action}・完整內容</div>
                  <div className="acp-detail-body">
                    <div><h4>送出參數</h4><pre>{pretty(pickedRow.req) || '（無）'}</pre></div>
                    <div><h4>回傳參數</h4><pre>{pretty(pickedRow.res) || '（無）'}</pre></div>
                  </div>
                  <div className="acp-detail-foot">來源：{pickedRow.source}{pickedRow.kind === 'backend' ? '・後台依同帳號、同時段擷取 Log Third Http Req＋Log Third Bet Req' : ''}</div>
                </div>
              )}
            </>
          )}

          {detail && tab === 'ws' && (
            <div className="acp-table-wrap">
              {detail.wsTruncated && <div className="acp-note">只顯示前 {detail.ws.length} 筆（共 {detail.wsTotal} 筆），完整內容請匯出 Excel</div>}
              <table className="acp-table">
                <thead><tr><th>時間</th><th>來源</th><th>方向</th><th>route</th><th>內容</th></tr></thead>
                <tbody>
                  {detail.ws.map((w, i) => (
                    <tr key={i}><td className="acp-mono acp-nowrap">{fmt(w.t, true).slice(6)}</td><td className="acp-nowrap">{w.source === 'frame' ? '原始幀' : '已解碼'}</td><td className="acp-nowrap">{w.dir === 'send' ? 'H5 → OSM' : 'OSM → H5'}</td><td className="acp-mono">{w.route}</td><td className="acp-mono acp-dim acp-break">{short(w.text, 160)}</td></tr>
                  ))}
                  {!detail.ws.length && <tr><td colSpan={5} className="acp-empty">沒有 WebSocket 紀錄</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {detail && tab === 'http' && (
            <div className="acp-table-wrap">
              <table className="acp-table">
                <thead><tr><th>時間</th><th>Method</th><th>URL</th><th>Status</th><th>送出</th><th>回傳</th></tr></thead>
                <tbody>
                  {httpRows.map((h, i) => (
                    <tr key={i} className={h.noise ? 'acp-dim' : ''}><td className="acp-mono acp-nowrap">{fmt(h.t, true).slice(6)}</td><td>{h.method}</td><td className="acp-mono acp-break">{short(h.url, 90)}</td><td>{h.status}</td><td className="acp-mono acp-dim acp-cell">{short(h.req)}</td><td className="acp-mono acp-dim acp-cell">{short(h.res)}</td></tr>
                  ))}
                  {!httpRows.length && <tr><td colSpan={6} className="acp-empty">沒有 HTTP 紀錄</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {detail && tab === 'info' && run && (
            <div className="acp-info">
              <dl>
                <dt>紀錄編號</dt><dd className="acp-mono">{run.id}</dd>
                <dt>環境／渠道</dt><dd>{ENV_LABEL[run.env]}／{run.channelId}</dd>
                <dt>帳號／機台</dt><dd>{run.account}／{run.machine}</dd>
                <dt>大廳連結</dt><dd className="acp-mono acp-break">{run.lobbyUrl}</dd>
                <dt>操作者</dt><dd>{run.operatorName ?? '—'}</dd>
                <dt>前台時段</dt><dd>{fmt((run.frontStartedAt ?? 0) + (run.calibration?.offsetMs ?? 0))} ～ {fmt((run.frontFinishedAt ?? 0) + (run.calibration?.offsetMs ?? 0))}（後台時鐘）</dd>
                <dt>時間校正</dt><dd>{run.calibration ? `${run.calibration.note}；前台時間 ${run.calibration.offsetMs >= 0 ? '+' : ''}${(run.calibration.offsetMs / 1000).toFixed(1)} 秒` : '—'}</dd>
                <dt>前台資料</dt><dd className={run.completeness?.front.complete === false ? 'acp-bad' : ''}>{run.completeness ? (run.completeness.front.complete ? '完整' : run.completeness.front.reasons.join('；')) : '—'}</dd>
                <dt>後台資料</dt><dd className={run.completeness?.backend.complete === false ? 'acp-bad' : ''}>{run.completeness ? `${run.completeness.backend.complete ? '完整' : run.completeness.backend.reasons.join('；')}（時間窗內 ${run.completeness.backend.inWindow} 筆，窗外 ${run.completeness.backend.outsideWindow} 筆不列入）` : '—'}</dd>
              </dl>
              <p className="acp-dim">後台來源：Log Third Http Req／Log Third Bet Req 的 API（內容＝Show Details 完整內容）。Excel 四分頁：時間軸／前台WS／前台HTTP／說明，比對摘要併入說明頁。</p>
            </div>
          )}
        </section>

        {/* 與上次比對 */}
        <section className="acp-card acp-right">
          <div className="acp-card-head"><h3>與上次比對</h3></div>
          <select className="acp-input acp-full" value={baselineSel} disabled={!run || live} onChange={e => setBaselineSel(e.target.value)}>
            <option value="">上次成功紀錄・同環境／渠道／帳號／機台</option>
            <option value="none">不比對</option>
            {(compare?.candidates ?? []).map(c => <option key={c.id} value={c.id}>{fmt(c.startedAt)}｜{ENV_LABEL[c.env]} {c.account} 機台 {c.machine}{c.sameTarget ? '' : '（不同對象）'}｜{STATUS_TEXT[c.status]}</option>)}
          </select>
          <div className="acp-hint">{live ? '紀錄完成後才會比對' : compare?.baseline ? `基準：${fmt(compare.baseline.startedAt)}（${compare.baseline.account}／機台 ${compare.baseline.machine}）` : '無基準'}</div>
          {compare?.diff?.hasBaseline && (
            <>
              <div className="acp-counts">
                <div className="acp-count acp-count--add">新增 <b>{compare.diff.counts.added}</b></div>
                <div className="acp-count acp-count--miss">缺少 <b>{compare.diff.counts.missing}</b></div>
                <div className="acp-count acp-count--type">型別變更 <b>{compare.diff.counts.type}</b></div>
                <div className="acp-count acp-count--val">值變更 <b>{compare.diff.counts.value}</b></div>
              </div>
              <div className="acp-hint">新 API {compare.diff.counts.newApi}・未觀測 {compare.diff.counts.unobserved}{ignoreVolatile ? `・已忽略時間戳／流水號值差異 ${compare.diff.counts.volatileIgnored} 處` : ''}</div>
              <div className="acp-apis">
                {compare.diff.apis.filter(a => a.status !== 'same').map(a => (
                  <div key={a.key} className={`acp-api acp-api--${a.status}`}>
                    <button className="acp-api-head" onClick={() => setOpenApi(o => ({ ...o, [a.key]: !o[a.key] }))}>
                      <span className="acp-api-name">{a.label}</span>
                      <span className={`acp-tag acp-tag--${a.status}`}>{API_STATUS_LABEL[a.status]}{a.items.length ? ` ${a.items.length}` : ''}</span>
                      <span className="acp-api-dir">{a.direction}</span>
                      <span className="acp-caret">{openApi[a.key] ? '▾' : '▸'}</span>
                    </button>
                    {(openApi[a.key] || a.items.length <= 2) && a.items.length > 0 && (
                      <ul>
                        {a.items.map((it, i) => (
                          <li key={i}>
                            <span className={`acp-tag acp-tag--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                            <span className="acp-mono">{it.part}.{it.path}</span>
                            {it.kind === 'type' || it.kind === 'value' ? <span className="acp-mono acp-dim">{short(it.before, 30)} → <em>{short(it.after, 30)}</em></span> : it.kind === 'added' ? <span className="acp-mono acp-dim">→ <em>{it.after}</em></span> : <span className="acp-mono acp-dim">{it.before}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {a.status === 'unobserved' && <div className="acp-api-note">這次沒錄到這支 API（不算刪除）</div>}
                    {a.status === 'new-api' && <div className="acp-api-note">基準沒有這支 API</div>}
                  </div>
                ))}
                {!compare.diff.apis.some(a => a.status !== 'same') && <div className="acp-empty">參數結構一致，沒有差異</div>}
              </div>
            </>
          )}
          <div className="acp-foot">
            <div>依 API、方向、參數路徑比對</div>
            <label className="acp-check"><input type="checkbox" checked={ignoreVolatile} onChange={e => setIgnoreVolatile(e.target.checked)} /> 忽略時間戳、流水號的值差異</label>
            <div className="acp-dim">型別與值分開標示；未擷取的 API 標示「未觀測」</div>
          </div>
        </section>
      </div>

      {picker && <UrlPoolPickerModal title="選擇帳號" claimedByLabel="API 參數紀錄" onSelect={url => { setLobbyUrl(url); setPicker(false) }} onClose={() => setPicker(false)} />}
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); void loadMeta() }} />}
    </div>
  )
}

interface EnvSetting { baseUrl: string; origin: string; username: string; channelId: string; hasPassword: boolean; verified: boolean }

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [env, setEnv] = useState<Env>('qat')
  const [all, setAll] = useState<Record<Env, EnvSetting> | null>(null)
  const [form, setForm] = useState<EnvSetting & { password: string }>({ baseUrl: '', origin: '', username: '', channelId: '', hasPassword: false, verified: true, password: '' })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { void api<{ settings: Record<Env, EnvSetting> }>('GET', '/api/api-capture/settings').then(r => { if (r.ok) setAll(r.settings); else setMsg({ ok: false, text: r.message || '讀取失敗' }) }) }, [])
  useEffect(() => { if (all) setForm({ ...all[env], password: '' }) }, [all, env])
  async function save() {
    const r = await api('PUT', '/api/api-capture/settings', { env, baseUrl: form.baseUrl, origin: form.origin, username: form.username, channelId: form.channelId, password: form.password })
    if (!r.ok) { setMsg({ ok: false, text: r.message || '儲存失敗' }); return }
    setMsg({ ok: true, text: '已儲存（密碼加密存放）' })
    setAll(a => a ? { ...a, [env]: { ...form, hasPassword: form.hasPassword || !!form.password } } : a)
  }
  const set = (k: keyof EnvSetting | 'password') => (e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))
  return createPortal(
    <div className="acp-portal acp-mask" onClick={onClose}>
      <div className="acp-modal" onClick={e => e.stopPropagation()}>
        <div className="acp-modal-head"><h3>後台設定（管理員）</h3><button className="acp-x" onClick={onClose}>✕</button></div>
        <p className="acp-dim">查 Log Third Http Req／Bet Req 用的 OSM 後台帳號。密碼加密存放、不回傳畫面；留空＝沿用原本的密碼。</p>
        <div className="acp-seg">{(['qat', 'uat'] as Env[]).map(e => <button key={e} className={env === e ? 'is-on' : ''} onClick={() => setEnv(e)}>{ENV_LABEL[e]}</button>)}</div>
        {!form.verified && <div className="acp-note">UAT 網域取自 OSM QA 記憶，Log 端點尚未實測</div>}
        <div className="acp-form">
          <label>後台 API 網址<input className="acp-input" value={form.baseUrl} onChange={set('baseUrl')} /></label>
          <label>Origin（後台前端網址）<input className="acp-input" value={form.origin} onChange={set('origin')} /></label>
          <label>預設渠道 ID<input className="acp-input" value={form.channelId} onChange={set('channelId')} /></label>
          <label>後台帳號<input className="acp-input" value={form.username} onChange={set('username')} autoComplete="off" /></label>
          <label>密碼{form.hasPassword ? '（已設定，留空沿用）' : '（尚未設定）'}<input className="acp-input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" /></label>
        </div>
        {msg && <div className={`acp-flash ${msg.ok ? 'acp-flash--ok' : 'acp-flash--bad'}`}>{msg.text}</div>}
        <div className="acp-modal-foot"><button className="acp-btn" onClick={onClose}>關閉</button><button className="acp-btn acp-btn--primary" onClick={save} disabled={!form.baseUrl || !form.username || !form.channelId}>儲存</button></div>
      </div>
    </div>,
    document.body,
  )
}
