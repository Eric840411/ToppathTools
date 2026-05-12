import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ModelSelector } from '../components/ModelSelector'
import { URL_POOL_DATA } from '../data/urlPoolData'
import type { UrlPoolEntry } from '../data/urlPoolData'
import type { AccountInfo } from '../components/JiraAccountModal'

interface StepResult {
  step: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message: string
  durationMs: number
}

interface MachineResult {
  machineCode: string
  overall: 'pass' | 'fail' | 'warn'
  steps: StepResult[]
  consoleLogs: string[]
  startedAt: string
  finishedAt: string
}

interface TestEvent {
  type: string
  machineCode?: string
  agentHostname?: string
  status?: string
  message: string
  result?: MachineResult
  statuses?: JobStatus[]
  ts: string
}

interface JobStatus {
  machineCode: string
  state: 'pending' | 'running' | 'done' | 'failed'
  agentId?: string
  startedAt?: number
  finishedAt?: number
}

interface StepConfig {
  entry: boolean
  stream: boolean
  spin: boolean
  audio: boolean
  ideck: boolean
  touchscreen: boolean
  cctv: boolean
  exit: boolean
}

const STEP_LABELS: Record<keyof StepConfig, string> = {
  entry: '進入機台',
  stream: '推流檢測',
  spin: 'Spin 測試',
  audio: '音頻檢測',
  ideck: 'iDeck 測試',
  touchscreen: '觸屏測試',
  cctv: 'CCTV 號碼比對',
  exit: '退出測試',
}

const STEP_BADGE: Record<keyof StepConfig, string> = {
  entry: '',
  stream: '',
  spin: '',
  audio: '',
  ideck: '',
  touchscreen: '',
  cctv: '',
  exit: '',
}

type BonusAction = 'auto_wait' | 'spin' | 'takewin' | 'touchscreen'

interface AudioConfig {
  peakWarnDb?: number | null
  centroidWarnHz?: number | null
  rmsMinDb?: number | null
  rmsMaxDb?: number | null
}

interface MachineProfile {
  machineType: string
  bonusAction: BonusAction
  /** Text labels of <span> elements on the touchscreen panel, e.g. ["3,2","6,5"] */
  touchPoints?: string[] | null
  /** Also click .btn_take after all touchscreen positions */
  clickTake?: boolean | null
  /** gameid URL param for fallback matching, e.g. "osmbwjl" */
  gmid?: string | null
  /** machineType from enterGMNtc response for fallback matching, e.g. "wlzbhelix15" */
  enterMachineType?: string | null
  spinSelector?: string | null
  balanceSelector?: string | null
  exitSelector?: string | null
  notes?: string | null
  /** Stage 1 entry touchscreen: select DENOM */
  entryTouchPoints?: string[] | null
  /** Stage 2 entry touchscreen: YES/NO confirmation */
  entryTouchPoints2?: string[] | null
  /** iDeck test XPath list (replaces AutoSpin bet_random config) */
  ideckXpaths?: string[] | null
  /** Per-machine audio thresholds */
  audioConfig?: AudioConfig | null
  /** Whether a reference WAV exists for this machine type (server-side flag) */
  hasAudioRef?: boolean
}

const BONUS_ACTION_LABELS: Record<BonusAction, string> = {
  auto_wait:   '自動等待（不操作）',
  spin:        '點擊 Spin 啟動',
  takewin:     '點擊 TakeWin',
  touchscreen: '點擊觸屏座標',
}

const EMPTY_PROFILE: MachineProfile = {
  machineType: '', bonusAction: 'auto_wait',
  touchPoints: [], clickTake: false,
  gmid: '', enterMachineType: '',
  spinSelector: '', balanceSelector: '', exitSelector: '', notes: '',
  entryTouchPoints: [], entryTouchPoints2: [],
  ideckXpaths: [],
  audioConfig: null,
}

const isValidCoord = (s: string) => /^\d+,\d+$/.test(s.trim())

function ProfilesPanel() {
  const [profiles, setProfiles] = useState<MachineProfile[]>([])
  const [editing, setEditing] = useState<MachineProfile | null>(null)
  const [originalMachineType, setOriginalMachineType] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [cctvRefs, setCctvRefs] = useState<Set<string>>(new Set())
  const [cctvUploading, setCctvUploading] = useState<string | null>(null)
  const [audioRefs, setAudioRefs] = useState<Set<string>>(new Set())
  const [audioUploading, setAudioUploading] = useState<string | null>(null)
  const [cctvPreview, setCctvPreview] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/api/machine-test/profiles').then(r => r.json())
      .then((d: { profiles?: MachineProfile[] }) => setProfiles(d.profiles ?? []))
      .catch(() => {})
    fetch('/api/machine-test/cctv-refs').then(r => r.json())
      .then((d: { machineTypes?: string[] }) => setCctvRefs(new Set(d.machineTypes ?? [])))
      .catch(() => {})
    fetch('/api/machine-test/audio-refs').then(r => r.json())
      .then((d: { machineTypes?: string[] }) => setAudioRefs(new Set(d.machineTypes ?? [])))
      .catch(() => {})
  }, [])

  const handleCctvUpload = async (machineType: string, file: File) => {
    setCctvUploading(machineType)
    const fd = new FormData()
    fd.append('image', file)
    await fetch(`/api/machine-test/cctv-refs/${machineType}`, { method: 'POST', body: fd })
    setCctvUploading(null)
    fetch('/api/machine-test/cctv-refs').then(r => r.json())
      .then((d: { machineTypes?: string[] }) => setCctvRefs(new Set(d.machineTypes ?? [])))
      .catch(() => {})
  }

  const handleCctvDelete = async (machineType: string) => {
    await fetch(`/api/machine-test/cctv-refs/${machineType}`, { method: 'DELETE' })
    setCctvRefs(prev => { const s = new Set(prev); s.delete(machineType); return s })
  }

  const handleAudioRefUpload = async (machineType: string, file: File) => {
    setAudioUploading(machineType)
    const fd = new FormData()
    fd.append('audio', file)
    await fetch(`/api/machine-test/audio-refs/${machineType}`, { method: 'POST', body: fd })
    setAudioUploading(null)
    fetch('/api/machine-test/audio-refs').then(r => r.json())
      .then((d: { machineTypes?: string[] }) => setAudioRefs(new Set(d.machineTypes ?? [])))
      .catch(() => {})
  }

  const handleAudioRefDelete = async (machineType: string) => {
    await fetch(`/api/machine-test/audio-refs/${machineType}`, { method: 'DELETE' })
    setAudioRefs(prev => { const s = new Set(prev); s.delete(machineType); return s })
  }

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    if (!editing || !editing.machineType.trim()) return
    const newType = editing.machineType.trim().toUpperCase()
    if (newType !== originalMachineType && profiles.some(p => p.machineType === newType)) {
      alert(`機型代碼「${newType}」已存在！\n請先刪除舊設定，或點擊「編輯」修改現有設定。`)
      return
    }
    if (editing.bonusAction === 'touchscreen' && (editing.touchPoints ?? []).filter(s => s.trim()).length === 0) {
      alert('Bonus 啟動方式選擇「點擊觸屏座標」時，至少需要設定一個座標點位！')
      return
    }
    const allCoords = [
      ...(editing.touchPoints ?? []),
      ...(editing.entryTouchPoints ?? []),
      ...(editing.entryTouchPoints2 ?? []),
    ].filter(s => s.trim() !== '')
    const badCoords = allCoords.filter(s => !isValidCoord(s))
    // ideckXpaths: only basic non-empty check (no format constraint)
    const badXpaths = (editing.ideckXpaths ?? []).filter(s => !s.trim())
    if (badCoords.length > 0) {
      alert(`座標格式錯誤：${badCoords.join('、')}\n請使用「數字,數字」格式，例如 18,9`)
      return
    }
    if (badXpaths.length > 0) {
      alert('iDeck XPath 列表中有空白項目，請移除或填入 XPath 字串')
      return
    }
    setSaving(true)
    await fetch('/api/machine-test/profiles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...editing, machineType: editing.machineType.trim().toUpperCase() }),
    })
    setSaving(false)
    setEditing(null)
    load()
  }

  const handleDelete = async (machineType: string) => {
    if (!confirm(`確定刪除 ${machineType} 的設定？`)) return
    await fetch(`/api/machine-test/profiles/${machineType}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="section-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 className="section-title" style={{ margin: 0 }}>⚙️ 機台設定檔</h2>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 13, padding: '6px 14px' }}
          onClick={() => { setEditing({ ...EMPTY_PROFILE }); setOriginalMachineType('') }}
        >+ 新增機型</button>
      </div>

      {profiles.length === 0 && !editing && (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>尚無設定。新增機型後，測試時會自動套用對應的 Bonus 啟動方式與 Selector。</p>
      )}

      {profiles.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: editing ? 16 : 0 }}>
          <table className="version-table">
            <thead>
              <tr>
                <th>機型</th>
                <th>進入觸屏</th>
                <th>Bonus 啟動方式</th>
                <th>備注</th>
                <th>CCTV 基準圖</th>
                <th>音頻參考檔</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.machineType}>
                  <td><code style={{ fontSize: 12 }}>{p.machineType}</code></td>
                  <td style={{ fontSize: 11, color: '#64748b' }}>
                    {(p.entryTouchPoints?.length ?? 0) > 0 ? (
                      <span>
                        <span style={{ color: '#0891b2', fontWeight: 600 }}>S1:</span> {p.entryTouchPoints!.join(', ')}
                        {(p.entryTouchPoints2?.length ?? 0) > 0 &&
                          <><br /><span style={{ color: '#7c3aed', fontWeight: 600 }}>S2:</span> {p.entryTouchPoints2!.join(', ')}</>}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {BONUS_ACTION_LABELS[p.bonusAction]}
                    {p.bonusAction === 'touchscreen' && (p.touchPoints?.length ?? 0) > 0 &&
                      <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 6 }}>
                        [{p.touchPoints!.join(', ')}]{p.clickTake ? ' + Take' : ''}
                      </span>}
                  </td>
                  <td style={{ fontSize: 12, color: '#64748b' }}>{p.notes || '—'}</td>
                  <td>
                    {cctvRefs.has(p.machineType) ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <img
                          src={`/api/machine-test/cctv-refs/${p.machineType}/image`}
                          alt={p.machineType}
                          style={{ width: 48, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid #2d3f55', cursor: 'zoom-in' }}
                          onClick={() => setCctvPreview(`/api/machine-test/cctv-refs/${p.machineType}/image`)}
                        />
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                          <label style={{ cursor: 'pointer' }}>
                            <input type="file" accept="image/*" style={{ display: 'none' }}
                              onChange={e => { const f = e.target.files?.[0]; if (f) handleCctvUpload(p.machineType, f) }} />
                            <span style={{ fontSize: 11, color: '#64748b', textDecoration: 'underline', cursor: 'pointer' }}>
                              {cctvUploading === p.machineType ? '更換中...' : '更換'}
                            </span>
                          </label>
                          <span style={{ fontSize: 11, color: '#ef4444', cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => handleCctvDelete(p.machineType)}>刪除</span>
                        </span>
                      </span>
                    ) : (
                      <label style={{ cursor: 'pointer' }}>
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleCctvUpload(p.machineType, f) }} />
                        <span className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: '#64748b' }}>
                          {cctvUploading === p.machineType ? '上傳中...' : '+ 上傳基準圖'}
                        </span>
                      </label>
                    )}
                  </td>
                  <td>
                    {audioRefs.has(p.machineType) ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, color: '#059669' }}>🎵 已上傳</span>
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                          <label style={{ cursor: 'pointer' }}>
                            <input type="file" accept="audio/wav,.wav" style={{ display: 'none' }}
                              onChange={e => { const f = e.target.files?.[0]; if (f) handleAudioRefUpload(p.machineType, f) }} />
                            <span style={{ fontSize: 11, color: '#64748b', textDecoration: 'underline', cursor: 'pointer' }}>
                              {audioUploading === p.machineType ? '更換中...' : '更換'}
                            </span>
                          </label>
                          <span style={{ fontSize: 11, color: '#ef4444', cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => handleAudioRefDelete(p.machineType)}>刪除</span>
                        </span>
                      </span>
                    ) : (
                      <label style={{ cursor: 'pointer' }}>
                        <input type="file" accept="audio/wav,.wav" style={{ display: 'none' }}
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleAudioRefUpload(p.machineType, f) }} />
                        <span className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: '#64748b' }}>
                          {audioUploading === p.machineType ? '上傳中...' : '+ 上傳參考音頻'}
                        </span>
                      </label>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '3px 10px', marginRight: 6 }}
                      onClick={() => { setEditing({ ...p }); setOriginalMachineType(p.machineType); setShowAdvanced(!!(p.spinSelector || p.balanceSelector || p.exitSelector)) }}>
                      編輯
                    </button>
                    <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '3px 10px', color: '#ef4444' }}
                      onClick={() => handleDelete(p.machineType)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="mt-profile-form">
          <div className="mt-profile-form-row">
            <label className="field" style={{ flex: '0 0 140px' }}>
              <span>機型代碼 <em className="req">*</em></span>
              <input value={editing.machineType} onChange={e => setEditing(p => ({ ...p!, machineType: e.target.value.toUpperCase() }))}
                placeholder="JJBX" style={{ textTransform: 'uppercase' }} />
            </label>
            <label className="field" style={{ flex: '0 0 130px' }}>
              <span>gmid <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>（選填）</span></span>
              <input value={editing.gmid ?? ''} onChange={e => setEditing(p => ({ ...p!, gmid: e.target.value.toLowerCase() }))}
                placeholder="osmbwjl" />
            </label>
            <label className="field" style={{ flex: '0 0 150px' }}>
              <span>enterMachineType <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>（選填）</span></span>
              <input value={editing.enterMachineType ?? ''} onChange={e => setEditing(p => ({ ...p!, enterMachineType: e.target.value }))}
                placeholder="wlzbhelix15" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Bonus 啟動方式</span>
              <select value={editing.bonusAction} onChange={e => setEditing(p => ({ ...p!, bonusAction: e.target.value as BonusAction }))}
                style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #2d3f55', fontSize: 14 }}>
                {(Object.entries(BONUS_ACTION_LABELS) as [BonusAction, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
          </div>

          {/* ── Unified Touchscreen Settings ── */}
          <div style={{ border: '1px solid #2d3f55', borderRadius: 8, padding: '12px 14px', marginTop: 8, marginBottom: 8, background: '#162032' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 12 }}>觸屏設定</div>

            {/* touchPoints: Bonus touchscreen activation + stepTouchscreen test */}
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1' }}>觸屏點位序列</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>Bonus 觸屏啟動 / 觸屏測試 共用</span>
                <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}
                  onClick={() => setEditing(p => ({ ...p!, touchPoints: [...(p!.touchPoints ?? []), ''] }))}>
                  + 新增點位
                </button>
              </div>
              {editing.bonusAction === 'touchscreen' && (editing.touchPoints ?? []).length === 0 && (
                <p style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, margin: '4px 0' }}>
                  ⚠️ Bonus 觸屏啟動：至少設定一個點位（填入 span 元素文字，例如 <code style={{ fontSize: 11 }}>18,9</code>）
                </p>
              )}
              {(editing.touchPoints ?? []).length === 0 && editing.bonusAction !== 'touchscreen' && (
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>未設定（觸屏測試步驟需要設定）</p>
              )}
              {(editing.touchPoints ?? []).map((label, i) => (
                <div key={i} className="mt-touchpoint-row">
                  <span className="mt-touchpoint-index">{i + 1}</span>
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>元素文字</span>
                    <input value={label} placeholder="例: 18,9"
                      style={label.trim() && !isValidCoord(label) ? { borderColor: '#ef4444', outline: 'none', boxShadow: '0 0 0 2px #fee2e2' } : {}}
                      onChange={e => setEditing(p => {
                        const pts = [...(p!.touchPoints ?? [])]; pts[i] = e.target.value
                        return { ...p!, touchPoints: pts }
                      })} />
                    {label.trim() && !isValidCoord(label) && (
                      <span style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>格式需為「數字,數字」，例如 18,9</span>
                    )}
                  </label>
                  <button type="button" className="btn-ghost" style={{ fontSize: 11, color: '#ef4444', padding: '2px 8px', alignSelf: 'flex-end', marginBottom: 1 }}
                    onClick={() => setEditing(p => ({ ...p!, touchPoints: (p!.touchPoints ?? []).filter((_, j) => j !== i) }))}>
                    刪除
                  </button>
                </div>
              ))}
              {editing.bonusAction === 'touchscreen' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!editing.clickTake}
                    onChange={e => setEditing(p => ({ ...p!, clickTake: e.target.checked }))} />
                  點完所有點位後，額外點擊 <code style={{ fontSize: 11 }}>.btn_take</code>（Take 按鈕）
                </label>
              )}
            </div>

            {/* entryTouchPoints: Stage 1 — DENOM selection */}
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#0891b2' }}>進入前第一階段：選擇 DENOM</span>
                <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}
                  onClick={() => setEditing(p => ({ ...p!, entryTouchPoints: [...(p!.entryTouchPoints ?? []), ''] }))}>
                  + 新增點位
                </button>
              </div>
              {(editing.entryTouchPoints ?? []).length === 0 && (
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>未設定（選填）</p>
              )}
              {(editing.entryTouchPoints ?? []).map((label, i) => (
                <div key={i} className="mt-touchpoint-row">
                  <span className="mt-touchpoint-index">{i + 1}</span>
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>元素文字</span>
                    <input value={label} placeholder="例: 18,9"
                      style={label.trim() && !isValidCoord(label) ? { borderColor: '#ef4444', outline: 'none', boxShadow: '0 0 0 2px #fee2e2' } : {}}
                      onChange={e => setEditing(p => {
                        const pts = [...(p!.entryTouchPoints ?? [])]; pts[i] = e.target.value
                        return { ...p!, entryTouchPoints: pts }
                      })} />
                    {label.trim() && !isValidCoord(label) && (
                      <span style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>格式需為「數字,數字」，例如 18,9</span>
                    )}
                  </label>
                  <button type="button" className="btn-ghost" style={{ fontSize: 11, color: '#ef4444', padding: '2px 8px', alignSelf: 'flex-end', marginBottom: 1 }}
                    onClick={() => setEditing(p => ({ ...p!, entryTouchPoints: (p!.entryTouchPoints ?? []).filter((_, j) => j !== i) }))}>
                    刪除
                  </button>
                </div>
              ))}
            </div>

            {/* entryTouchPoints2: Stage 2 — YES/NO */}
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#7c3aed' }}>進入前第二階段：YES / NO 確認</span>
                <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}
                  onClick={() => setEditing(p => ({ ...p!, entryTouchPoints2: [...(p!.entryTouchPoints2 ?? []), ''] }))}>
                  + 新增點位
                </button>
              </div>
              {(editing.entryTouchPoints2 ?? []).length === 0 && (
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>未設定（選填）</p>
              )}
              {(editing.entryTouchPoints2 ?? []).map((label, i) => (
                <div key={i} className="mt-touchpoint-row">
                  <span className="mt-touchpoint-index">{i + 1}</span>
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>元素文字</span>
                    <input value={label} placeholder="例: 1,2"
                      style={label.trim() && !isValidCoord(label) ? { borderColor: '#ef4444', outline: 'none', boxShadow: '0 0 0 2px #fee2e2' } : {}}
                      onChange={e => setEditing(p => {
                        const pts = [...(p!.entryTouchPoints2 ?? [])]; pts[i] = e.target.value
                        return { ...p!, entryTouchPoints2: pts }
                      })} />
                    {label.trim() && !isValidCoord(label) && (
                      <span style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>格式需為「數字,數字」，例如 1,2</span>
                    )}
                  </label>
                  <button type="button" className="btn-ghost" style={{ fontSize: 11, color: '#ef4444', padding: '2px 8px', alignSelf: 'flex-end', marginBottom: 1 }}
                    onClick={() => setEditing(p => ({ ...p!, entryTouchPoints2: (p!.entryTouchPoints2 ?? []).filter((_, j) => j !== i) }))}>
                    刪除
                  </button>
                </div>
              ))}
            </div>

            {/* iDeck XPath list */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#d97706' }}>iDeck 測試 XPath 列表</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>每行一個 XPath，對應 iDeck 下注按鈕</span>
                <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}
                  onClick={() => setEditing(p => ({ ...p!, ideckXpaths: [...(p!.ideckXpaths ?? []), ''] }))}>
                  + 新增 XPath
                </button>
              </div>
              {(editing.ideckXpaths ?? []).length === 0 && (
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>未設定（選填，設定後 iDeck 測試將使用此列表，忽略 AutoSpin bet_random 設定）</p>
              )}
              {(editing.ideckXpaths ?? []).map((xpath, i) => (
                <div key={i} className="mt-touchpoint-row">
                  <span className="mt-touchpoint-index">{i + 1}</span>
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>XPath</span>
                    <input value={xpath} placeholder="例: //div[@class='row4']//div[contains(@class,'btn_bet')]"
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                      onChange={e => setEditing(p => {
                        const xps = [...(p!.ideckXpaths ?? [])]; xps[i] = e.target.value
                        return { ...p!, ideckXpaths: xps }
                      })} />
                  </label>
                  <button type="button" className="btn-ghost" style={{ fontSize: 11, color: '#ef4444', padding: '2px 8px', alignSelf: 'flex-end', marginBottom: 1 }}
                    onClick={() => setEditing(p => ({ ...p!, ideckXpaths: (p!.ideckXpaths ?? []).filter((_, j) => j !== i) }))}>
                    刪除
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-profile-form-row">
            <label className="field" style={{ flex: 1 }}>
              <span>備注</span>
              <input value={editing.notes ?? ''} onChange={e => setEditing(p => ({ ...p!, notes: e.target.value }))} placeholder="選填" />
            </label>
          </div>

          {/* ── Audio Config ── */}
          <div style={{ border: '1px solid #2d3f55', borderRadius: 8, padding: '12px 14px', marginTop: 8, marginBottom: 8, background: '#162032' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 10 }}>
              🎵 音頻閾值設定
              <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400, marginLeft: 8 }}>
                留空使用全域預設值（峰值 -3 dB、重心 1500 Hz、RMS -60 ~ -20 dB）
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
              <label className="field" style={{ margin: 0 }}>
                <span>峰值警告 dBFS <span style={{ fontSize: 11, color: '#94a3b8' }}>（爆音）</span></span>
                <input
                  type="number" step="0.1"
                  value={editing.audioConfig?.peakWarnDb ?? ''}
                  placeholder="-3"
                  onChange={e => setEditing(p => ({
                    ...p!, audioConfig: { ...(p!.audioConfig ?? {}), peakWarnDb: e.target.value === '' ? null : parseFloat(e.target.value) }
                  }))}
                />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>頻譜重心 Hz <span style={{ fontSize: 11, color: '#94a3b8' }}>（音色偏亮）</span></span>
                <input
                  type="number" step="10"
                  value={editing.audioConfig?.centroidWarnHz ?? ''}
                  placeholder="1500"
                  onChange={e => setEditing(p => ({
                    ...p!, audioConfig: { ...(p!.audioConfig ?? {}), centroidWarnHz: e.target.value === '' ? null : parseFloat(e.target.value) }
                  }))}
                />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>RMS 最低 dB <span style={{ fontSize: 11, color: '#94a3b8' }}>（音量偏低）</span></span>
                <input
                  type="number" step="1"
                  value={editing.audioConfig?.rmsMinDb ?? ''}
                  placeholder="-60"
                  onChange={e => setEditing(p => ({
                    ...p!, audioConfig: { ...(p!.audioConfig ?? {}), rmsMinDb: e.target.value === '' ? null : parseFloat(e.target.value) }
                  }))}
                />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>RMS 最高 dB <span style={{ fontSize: 11, color: '#94a3b8' }}>（音量過大）</span></span>
                <input
                  type="number" step="1"
                  value={editing.audioConfig?.rmsMaxDb ?? ''}
                  placeholder="-20"
                  onChange={e => setEditing(p => ({
                    ...p!, audioConfig: { ...(p!.audioConfig ?? {}), rmsMaxDb: e.target.value === '' ? null : parseFloat(e.target.value) }
                  }))}
                />
              </label>
            </div>
          </div>

          <button type="button" className="btn-ghost" style={{ fontSize: 12, marginBottom: 8 }}
            onClick={() => setShowAdvanced(v => !v)}>
            {showAdvanced ? '▲ 收起進階設定' : '▼ 進階：自訂 Selector'}
          </button>

          {showAdvanced && (
            <div className="mt-profile-form-row">
              <label className="field" style={{ flex: 1 }}>
                <span>自訂 Spin Selector</span>
                <input value={editing.spinSelector ?? ''} onChange={e => setEditing(p => ({ ...p!, spinSelector: e.target.value }))} placeholder=".my-button.btn_spin（留空使用預設）" />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span>自訂餘額 Selector</span>
                <input value={editing.balanceSelector ?? ''} onChange={e => setEditing(p => ({ ...p!, balanceSelector: e.target.value }))} placeholder=".balance-bg.hand_balance（留空使用預設）" />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span>自訂退出 Selector</span>
                <input value={editing.exitSelector ?? ''} onChange={e => setEditing(p => ({ ...p!, exitSelector: e.target.value }))} placeholder=".btn_cashout（留空使用預設）" />
              </label>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="submit-btn" style={{ padding: '9px 20px', fontSize: 14 }}
              disabled={saving || !editing.machineType.trim()} onClick={handleSave}>
              {saving ? '儲存中...' : '儲存'}
            </button>
            <button type="button" className="btn-ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      {/* CCTV image lightbox */}
      {cctvPreview && (
        <div
          onClick={() => setCctvPreview(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={cctvPreview}
            alt="CCTV 基準圖"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}
          />
          <span
            onClick={() => setCctvPreview(null)}
            style={{ position: 'fixed', top: 20, right: 28, color: '#fff', fontSize: 28, cursor: 'pointer', lineHeight: 1 }}
          >✕</span>
        </div>
      )}
    </div>
  )
}

const statusIcon = (s?: string) => {
  if (s === 'pass') return '✅'
  if (s === 'fail') return '❌'
  if (s === 'warn') return '⚠️'
  if (s === 'skip') return '⏭️'
  return '💬'
}

const statusClass = (s?: string) => {
  if (s === 'pass') return 'badge--ok'
  if (s === 'fail') return 'badge--error'
  if (s === 'warn') return 'badge--warn'
  return 'badge--neutral'
}

/** Convert a machine test result into a short QA issue description for Lark Sheet */
function toQAMessage(result: MachineResult): string {
  if (result.overall === 'pass') return ''
  const issues: string[] = []
  for (const step of result.steps) {
    if (step.status !== 'fail' && step.status !== 'warn') continue
    const msg = step.message
    switch (step.step) {
      case '進入機台':
        if (msg.includes('找不到機台代碼')) issues.push('offline')
        else if (/aft/i.test(msg)) issues.push('AFT error')
        else issues.push('entry fail')
        break
      case '推流檢測':
        issues.push('no video')
        break
      case '音頻檢測': {
        // Collect all audio issues (independent checks, not else-if)
        if (msg.includes('靜音（')) issues.push('audio silent')  // runner outputs "靜音（RMS..." or "靜音（平均..."
        if (msg.includes('音量偏小')) issues.push('audio low')
        if (msg.includes('音量可能過大')) issues.push('audio loud')
        if (msg.includes('干擾')) issues.push('audio interference')
        if (msg.includes('爆音/失真') || msg.includes('爆音風險')) issues.push('audio clip')
        if (msg.includes('AI判斷異常')) {
          const aiMatch = msg.match(/AI判斷異常：([^、｜]{1,60})/)
          issues.push(aiMatch ? `AI: ${aiMatch[1].trim()}` : 'AI audio error')
        }
        if (issues.length === 0) issues.push('audio error')
        break
      }
      case 'Spin 測試':
        if (msg.includes('餘額未變化')) issues.push('spin no response')
        else issues.push('spin error')
        break
      case 'iDeck 測試': {
        const noResp = (msg.match(/btn\[\d+\] ✗/g) ?? []).length
        issues.push(noResp > 0 ? `iDeck ${noResp} btn no response` : 'iDeck error')
        break
      }
      case '觸屏測試': {
        const m = msg.match(/API 確認 (\d+)\/(\d+)/)
        if (m) issues.push(`touchscreen ${m[1]}/${m[2]} no response`)
        else issues.push('touchscreen error')
        break
      }
      case 'CCTV 號碼比對':
        if (msg.includes('找不到 video') || msg.includes('找不到 .header_btn_item') || msg.includes('找不到 CCTV')) issues.push('CCTV no video')
        else if (msg.includes('模糊')) issues.push('CCTV blurry')
        else if (msg.includes('識別碼')) {
          const code = msg.match(/識別碼：([^，,]+)/)?.[1]
          issues.push(code ? `CCTV OCR:${code.trim()}` : 'CCTV OCR warn')
        }
        else issues.push('CCTV error')
        break
    }
  }
  return issues.join(', ')
}

// ─── Audio Player (inline play/download for test recording) ───────────────────

function AudioPlayer({ machineCode, sessionId }: { machineCode: string; sessionId?: string | null }) {
  const [open, setOpen] = useState(false)
  const url = `/api/machine-test/audio-saves/${machineCode}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`
  if (!open) {
    return (
      <button
        type="button"
        title="播放錄音"
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
      >
        🔊
      </button>
    )
  }
  return (
    <audio
      src={url}
      controls
      autoPlay
      style={{ height: 28, verticalAlign: 'middle', maxWidth: 160 }}
      onError={() => setOpen(false)}
    />
  )
}

// ─── My History Panel ─────────────────────────────────────────────────────────

interface SessionRow {
  id: string
  account: string
  label: string
  started_at: number
  results: MachineResult[]
}

function MyHistoryPanel({ account }: { account: AccountInfo }) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [cctvPreview, setCctvPreview] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    fetch(`/api/machine-test/sessions?account=${encodeURIComponent(account.email)}`)
      .then(r => r.json())
      .then((d: { ok: boolean; sessions: SessionRow[] }) => { if (d.ok) setSessions(d.sessions) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { if (open) load() }, [open])

  return (
    <div className="section-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setOpen(o => { if (!o) load(); return !o })}>
        <h2 className="section-title" style={{ margin: 0 }}>📋 我的測試紀錄</h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>{account.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 18, color: '#94a3b8' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={load} disabled={loading}>
              {loading ? '載入中...' : '🔄 重新整理'}
            </button>
          </div>

          {sessions.length === 0 && !loading && (
            <div style={{ color: '#64748b', fontSize: 13, padding: '16px 0', textAlign: 'center' }}>尚無測試紀錄</div>
          )}

          {sessions.map(s => {
            const pass = s.results.filter(r => r.overall === 'pass').length
            const warn = s.results.filter(r => r.overall === 'warn').length
            const fail = s.results.filter(r => r.overall === 'fail').length
            const isExp = expandedSession === s.id
            const date = new Date(s.started_at)
            const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
            return (
              <div key={s.id} style={{ border: '1px solid #2d3f55', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: isExp ? '#1e293b' : '#162032' }}
                  onClick={() => setExpandedSession(isExp ? null : s.id)}
                >
                  <span style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 500 }}>{dateStr}</span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{s.results.length} 台</span>
                  <span style={{ fontSize: 12, color: '#22c55e' }}>✅ {pass}</span>
                  {warn > 0 && <span style={{ fontSize: 12, color: '#f59e0b' }}>⚠️ {warn}</span>}
                  {fail > 0 && <span style={{ fontSize: 12, color: '#ef4444' }}>❌ {fail}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>{isExp ? '▲' : '▼'}</span>
                </div>

                {isExp && (
                  <div style={{ overflowX: 'auto', borderTop: '1px solid #f3f4f6' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#162032' }}>
                          <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1' }}>機台</th>
                          <th style={{ padding: '6px 10px', fontWeight: 600, color: '#cbd5e1' }}>整體</th>
                          {Object.values(STEP_LABELS).map(l => (
                            <th key={l} style={{ padding: '6px 8px', fontWeight: 600, color: '#cbd5e1', fontSize: 11 }}>{l.replace('測試', '').replace('檢測', '').replace('號碼比對', '')}</th>
                          ))}
                          <th style={{ padding: '6px 8px', fontWeight: 600, color: '#cbd5e1' }}>CCTV</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600, color: '#cbd5e1' }}>音頻</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.results.map(r => (
                          <tr key={r.machineCode} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '6px 10px' }}><code style={{ fontSize: 11 }}>{r.machineCode}</code></td>
                            <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                              <span className={`badge ${statusClass(r.overall)}`} style={{ fontSize: 10 }}>{statusIcon(r.overall)}</span>
                            </td>
                            {Object.keys(STEP_LABELS).map(k => {
                              const step = r.steps.find(s2 => s2.step === STEP_LABELS[k as keyof StepConfig])
                              return (
                                <td key={k} style={{ padding: '6px 8px', textAlign: 'center' }}>
                                  {step ? <span title={step.message}>{statusIcon(step.status)}</span> : <span style={{ color: '#e2e8f0' }}>—</span>}
                                </td>
                              )
                            })}
                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                              <img
                                src={`/api/machine-test/cctv-saves/${r.machineCode}?sessionId=${encodeURIComponent(s.id)}`}
                                alt=""
                                style={{ height: 24, width: 'auto', borderRadius: 2, cursor: 'pointer', border: '1px solid #2d3f55' }}
                                onClick={() => setCctvPreview(`/api/machine-test/cctv-saves/${r.machineCode}?sessionId=${encodeURIComponent(s.id)}`)}
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                              <AudioPlayer machineCode={r.machineCode} sessionId={s.id} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {cctvPreview && createPortal(
        <div onClick={() => setCctvPreview(null)} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={cctvPreview} alt="CCTV" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} onClick={e => e.stopPropagation()} />
          <span onClick={() => setCctvPreview(null)} style={{ position: 'fixed', top: 20, right: 28, color: '#fff', fontSize: 28, cursor: 'pointer' }}>✕</span>
        </div>,
        document.body,
      )}
    </div>
  )
}

// ─── URL Pool Picker Modal ─────────────────────────────────────────────────────

function UrlPoolPickerModal({ workerIndex, onSelect, onClose }: {
  workerIndex: number
  onSelect: (url: string) => void
  onClose: () => void
}) {
  const [entries, setEntries] = useState<UrlPoolEntry[]>([])
  const [claims, setClaims] = useState<Record<string, { claimedBy: string | null }>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [hideUsed, setHideUsed] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/url-pool/overrides').then(r => r.json()).catch(() => ({})),
      fetch('/api/url-pool/status').then(r => r.json()).catch(() => ({})),
    ]).then(([overrides, claimsData]: [Record<string, string>, Record<string, { claimedBy: string | null }>]) => {
      setEntries(URL_POOL_DATA.map(r => ({ ...r, url: overrides[r.account] ?? r.url })))
      setClaims(claimsData)
      setLoading(false)
    })
  }, [])

  const filtered = entries.filter(e => {
    if (hideUsed && claims[e.account]?.claimedBy) return false
    const q = search.toLowerCase()
    return !q || e.username.toLowerCase().includes(q) || e.account.includes(q)
  })

  const handleSelect = async (e: UrlPoolEntry) => {
    // Claim the account so URL pool page reflects it as "佔用"
    await fetch(`/api/url-pool/${e.account}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimedBy: 'machine-test' }),
    }).catch(() => { /* non-fatal */ })
    onSelect(e.url)
    onClose()
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#1e293b', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 520, maxWidth: '95vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>帳號池 — 選取 W{workerIndex + 1} 大廳 URL</span>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} style={{ padding: '2px 8px', fontSize: 16 }}>✕</button>
        </div>

        {/* Filters */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            autoFocus
            placeholder="搜尋使用者名稱或帳號..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={hideUsed} onChange={e => setHideUsed(e.target.checked)} />
            只顯示空閒
          </label>
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#64748b' }}>載入中...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#64748b' }}>無符合帳號</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#162032', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1', borderBottom: '1px solid #e5e7eb' }}>使用者名稱</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#cbd5e1', borderBottom: '1px solid #e5e7eb' }}>狀態</th>
                  <th style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => {
                  const claimedBy = claims[e.account]?.claimedBy
                  return (
                    <tr key={e.account} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '7px 12px', color: '#cbd5e1' }}>{e.username}</td>
                      <td style={{ padding: '7px 12px' }}>
                        {claimedBy
                          ? <span style={{ color: '#ef4444', fontSize: 12 }}>佔用（{claimedBy}）</span>
                          : <span style={{ color: '#22c55e', fontSize: 12 }}>空閒</span>}
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 12, padding: '3px 10px', color: '#2563eb' }}
                          onClick={() => handleSelect(e)}
                        >
                          選取
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #f3f4f6', fontSize: 12, color: '#64748b' }}>
          共 {filtered.length} 個帳號
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── Agent Install Guide ───────────────────────────────────────────────────────

function AgentInstallGuide({ agentCount }: { agentCount: number }) {
  const [open, setOpen] = useState(false)
  // Dev: vite on :5173, API on :3000 — prod: both served via nginx on standard port
  const serverUrl = location.port === '5173'
    ? `${location.protocol}//${location.hostname}:3000`
    : location.origin

  return (
    <div className="section-card" style={{ marginBottom: 12 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ fontSize: 16 }}>🤖</span>
        <h2 className="section-title" style={{ margin: 0, flex: 1 }}>
          分散式 Agent 安裝指南
          {agentCount > 0 && (
            <span style={{ marginLeft: 8, fontSize: 12, background: '#dcfce7', color: '#16a34a', borderRadius: 10, padding: '2px 8px', fontWeight: 500 }}>
              {agentCount} 台 Agent 已連線
            </span>
          )}
        </h2>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{open ? '▲ 收合' : '▼ 展開'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, color: '#64748b', marginTop: 0 }}>
            將測試任務分派給多台 Worker 電腦執行，每台負責一部分機台，節省測試時間。
            Worker 電腦需要安裝 Node.js 與 Playwright，並可選擇性安裝 VB-Cable 以啟用音頻測試。
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Left column: install steps */}
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 10, marginTop: 0 }}>安裝步驟</h3>
              <ol style={{ fontSize: 13, color: '#cbd5e1', paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                <li>
                  安裝 <strong>Node.js 20 LTS</strong>（若尚未安裝）：
                  <br /><code style={{ fontSize: 11 }}>https://nodejs.org/en/download/</code>
                </li>
                <li>
                  下載並執行安裝包（雙擊即可）：
                  <br />
                  <a
                    href={`${serverUrl}/api/machine-test/agent/install.bat`}
                    style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}
                  >
                    ⬇ 下載 install.bat
                  </a>
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
                    （自動下載原始碼、npm install、playwright install）
                  </span>
                </li>
                <li>
                  <strong>【音頻測試】</strong>安裝 VB-Cable 虛擬音效卡：
                  <br /><code style={{ fontSize: 11 }}>https://vb-audio.com/Cable/</code>
                  <br />
                  <span style={{ fontSize: 11, color: '#dc2626' }}>
                    安裝後需重開機，並確認「CABLE Input (VB-Audio Virtual Cable)」已出現在音效裝置
                  </span>
                </li>
                <li>
                  安裝完成後，執行 Agent：
                  <br /><code style={{ fontSize: 11, background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>C:\machine-test-agent\start.bat</code>
                </li>
                <li>
                  Agent 連線成功後，本頁面的「<strong>Agent 已連線</strong>」徽章會亮起，
                  下次執行測試會自動分配任務給所有 Agent
                </li>
              </ol>
            </div>

            {/* Right column: notes */}
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 10, marginTop: 0 }}>注意事項</h3>
              <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.9 }}>
                <div style={{ marginBottom: 6, padding: '8px 10px', background: '#fef9c3', borderRadius: 6, border: '1px solid #fde68a' }}>
                  <strong>install.bat 伺服器位址</strong>：自動指向本頁所在主機（<code style={{ fontSize: 11 }}>{serverUrl}</code>）。
                  若 Worker 機器與伺服器不在同一區網，請手動修改 start.bat 中的 CENTRAL_URL。
                </div>
                <div style={{ marginBottom: 6 }}>🟢 Agent 啟動後會持續連線，斷線後每 5 秒自動重連</div>
                <div style={{ marginBottom: 6 }}>🟢 同一台電腦可多次下載安裝，install.bat 會覆蓋舊版本</div>
                <div style={{ marginBottom: 6 }}>🟡 音頻測試（VB-Cable）為選配，不安裝則該步驟標記 SKIP</div>
                <div style={{ marginBottom: 6 }}>🟡 CCTV 測試需要設定 GEMINI_API_KEY（在 start.bat 中加入）</div>
                <div style={{ marginBottom: 6 }}>🔴 與 AutoSpin Agent 不同：本 Agent 使用 Node.js，AutoSpin Agent 使用 Python</div>
              </div>

              <div style={{ marginTop: 12, padding: '8px 10px', background: '#162032', borderRadius: 6, border: '1px solid #2d3f55' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>手動啟動（進階）</div>
                <code style={{ fontSize: 11, color: '#cbd5e1', display: 'block' }}>
                  cd C:\machine-test-agent<br />
                  set CENTRAL_URL={serverUrl}<br />
                  set AGENT_LABEL=MyPC<br />
                  npx tsx server/agent-runner.ts
                </code>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function MachineTestPage({ account }: { account: AccountInfo | null }) {
  const [lobbyUrls, setLobbyUrls] = useState<string[]>([''])
  const [urlPickerOpen, setUrlPickerOpen] = useState<number | null>(null)
  const [codesText, setCodesText] = useState('')
  const [larkSheetUrl, setLarkSheetUrl] = useState('')
  const [larkRowMap, setLarkRowMap] = useState<Record<string, number>>({})  // gmid → rowIndex
  const [larkLoading, setLarkLoading] = useState(false)
  const [larkStatus, setLarkStatus] = useState('')
  const [gameCountMap, setGameCountMap] = useState<Record<string, number>>({})
  const [steps, setSteps] = useState<StepConfig>({
    entry: true, stream: true, spin: true, audio: true, ideck: false, touchscreen: false, cctv: false, exit: true,
  })
  const [flowPanelOpen, setFlowPanelOpen] = useState(false)
  const [profileList, setProfileList] = useState<MachineProfile[]>([])
  const [cctvModel, setCctvModel] = useState('gemini')
  const [headedMode, setHeadedMode] = useState(false)
  const [aiAudio, setAiAudio] = useState(false)
  const [osmEnv, setOsmEnv] = useState<'qat' | 'prod'>('qat')
  const [debugMode, setDebugMode] = useState(false)
  const [debugGmid, setDebugGmid] = useState('')
  const [running, setRunning] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [activeSessionBanner, setActiveSessionBanner] = useState(false)
  const [logs, setLogs] = useState<TestEvent[]>([])
  const [results, setResults] = useState<MachineResult[]>([])
  const [queueStatuses, setQueueStatuses] = useState<JobStatus[]>([])
  const [expandedCode, setExpandedCode] = useState<string | null>(null)
  const [cctvPreview, setCctvPreview] = useState<string | null>(null)
  const [osmConnected, setOsmConnected] = useState(false)
  const [osmCount, setOsmCount] = useState(0)
  const [osmMachines, setOsmMachines] = useState<Record<string, { status: number; label: string }>>({})
  const [osmPanelOpen, setOsmPanelOpen] = useState(false)
  const [osmLastUpdated, setOsmLastUpdated] = useState<Date | null>(null)

  // ── Admin PIN ──────────────────────────────────────────────────────────────
  const ADMIN_KEY = 'jira_admin_pin'
  const [isAdmin, setIsAdmin] = useState(() => !!sessionStorage.getItem(ADMIN_KEY))
  const [showPinModal, setShowPinModal] = useState(false)
  const [pinValue, setPinValue] = useState('')
  const [pinError, setPinError] = useState('')
  const [pinLoading, setPinLoading] = useState(false)
  const pinInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showPinModal) setTimeout(() => pinInputRef.current?.focus(), 50)
  }, [showPinModal])

  const handleVerifyPin = async () => {
    if (!pinValue.trim()) return
    setPinLoading(true)
    setPinError('')
    try {
      const r = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinValue }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (d.ok) {
        sessionStorage.setItem(ADMIN_KEY, pinValue)
        setIsAdmin(true)
        setShowPinModal(false)
        setPinValue('')
        handleStart(pinValue)
      } else {
        setPinError(d.message ?? 'PIN 錯誤')
      }
    } catch {
      setPinError('網路錯誤')
    } finally {
      setPinLoading(false)
    }
  }

  const logBoxRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const allResultsRef = useRef<MachineResult[]>([])
  const sessionIdRef = useRef<string | null>(null)
  const capturedSheetUrlRef = useRef('')
  const capturedRowMapRef = useRef<Record<string, number>>({})
  const writebackCountRef = useRef(0)
  const [agentStatus, setAgentStatus] = useState<{ agentId: string; hostname: string; busy: boolean }[]>([])

  // Poll agent + session status every 5s;
  // on first load show a banner if a session is already active (don't auto-connect)
  const didInitCheck = useRef(false)
  useEffect(() => {
    const check = (isFirstLoad = false) => {
      fetch('/api/machine-test/status')
        .then(r => r.json())
        .then((d: { ok?: boolean; active?: boolean; sessionId?: string; agents?: { agentId: string; hostname: string; busy: boolean }[] }) => {
          setAgentStatus(d.agents ?? [])
          if (isFirstLoad && !didInitCheck.current) {
            didInitCheck.current = true
            if (d.active && d.sessionId) {
              setSessionId(d.sessionId)
              setActiveSessionBanner(true)
            }
          }
        })
        .catch(() => {})
    }
    check(true)
    const t = setInterval(() => check(false), 5000)
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // SSE real-time OSMWatcher status push
  useEffect(() => {
    const es = new EventSource('/api/machine-test/osm-status-stream')
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data) as { count?: number; machines?: Record<string, { status: number; label: string }> }
        setOsmConnected((d.count ?? 0) > 0)
        setOsmCount(d.count ?? 0)
        setOsmMachines(d.machines ?? {})
        setOsmLastUpdated(new Date())
      } catch { /* ignore parse errors */ }
    }
    es.onerror = () => setOsmConnected(false)
    return () => es.close()
  }, [])

  useEffect(() => {
    fetch('/api/machine-test/profiles')
      .then(r => r.json())
      .then((d: { profiles?: MachineProfile[] }) => setProfileList(d.profiles ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!running) return
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs, running])

  const machineCodes = codesText
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)

  const handleLoadLark = async () => {
    if (!larkSheetUrl.trim()) return
    setLarkLoading(true)
    setLarkStatus('')
    try {
      const resp = await fetch('/api/machine-test/lark-machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: larkSheetUrl.trim() }),
      }).then(r => r.json()) as { ok: boolean; machines?: { gmid: string; rowIndex: number }[]; message?: string }

      if (!resp.ok || !resp.machines) {
        setLarkStatus(`❌ ${resp.message ?? '讀取失敗'}`)
        return
      }
      const machines = resp.machines
      setCodesText(machines.map(m => m.gmid).join('\n'))
      const map: Record<string, number> = {}
      machines.forEach(m => { map[m.gmid] = m.rowIndex })
      setLarkRowMap(map)
      // Count by game code (middle segment of GMID: studioId-GAMECODE-machineId)
      const counts: Record<string, number> = {}
      machines.forEach(m => {
        const parts = m.gmid.split('-')
        const gameCode = (parts.length >= 2 ? parts[1] : parts[0]).toLowerCase()
        counts[gameCode] = (counts[gameCode] ?? 0) + 1
      })
      setGameCountMap(counts)
      setLarkStatus(`✅ 讀取 ${machines.length} 台（已排除驗證通過）`)
    } catch {
      setLarkStatus('❌ 網路錯誤')
    } finally {
      setLarkLoading(false)
    }
  }

  const writebackOne = (r: MachineResult) => {
    const sheetUrl = capturedSheetUrlRef.current
    const rowMap = capturedRowMapRef.current
    if (!sheetUrl || !rowMap[r.machineCode]) return
    const rowIndex = rowMap[r.machineCode]
    const isPassing = r.overall === 'pass'
    setLarkStatus(`回寫 ${r.machineCode}...`)
    fetch('/api/machine-test/lark-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheetUrl,
        writes: [{ rowIndex, message: isPassing ? 'OK' : toQAMessage(r), qaStatus: isPassing ? '驗證通過' : '驗證未過' }],
      }),
    })
      .then(res => res.json())
      .then((d: { ok: boolean; results?: { ok: boolean; larkMsg?: string }[] }) => {
        const ok = d.results?.[0]?.ok ?? false
        writebackCountRef.current++
        if (ok) {
          setLarkStatus(`✅ 已回寫 ${writebackCountRef.current} 筆`)
        } else {
          const msg = d.results?.[0]?.larkMsg ?? '未知錯誤'
          setLarkStatus(`⚠️ ${r.machineCode} 回寫失敗：${msg}`)
        }
      })
      .catch(e => setLarkStatus(`❌ ${r.machineCode} 回寫錯誤：${String(e)}`))
  }

  const connectWS = () => {
    let retryCount = 0
    const MAX_RETRIES = 8
    let done = false

    const doConnect = () => {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${wsProtocol}//${location.host}/ws/machine-test/events`)
      wsRef.current = ws

      ws.onopen = () => {
        if (retryCount > 0) { retryCount = 0; setReconnecting(false) }
      }

      ws.onmessage = (e) => {
        const ev: TestEvent = JSON.parse(e.data as string)

        // New session starting — reset state for all viewers
        if (ev.type === 'session_start') {
          allResultsRef.current = []
          setLogs([{ ...ev }])
          setResults([])
          setQueueStatuses([])
          setRunning(true)
          return
        }

        // Work-stealing queue status update
        if (ev.type === 'queue_update' && ev.statuses) {
          setQueueStatuses(ev.statuses)
          return
        }

        setLogs(prev => {
          const key = `${ev.ts}|${ev.type}|${ev.message}`
          if (prev.some(p => `${p.ts}|${p.type}|${p.message}` === key)) return prev
          return [...prev, ev]
        })

        if (ev.type === 'machine_done' && ev.result) {
          if (!allResultsRef.current.find(r => r.machineCode === ev.result!.machineCode)) {
            allResultsRef.current.push(ev.result)
            setResults(prev => [...prev, ev.result!])
            writebackOne(ev.result)
          }
        }

        if (ev.type === 'session_done' || ev.type === 'error') {
          done = true
          setReconnecting(false)
          setRunning(false)
          ws.close()
          if (allResultsRef.current.length > 0) {
            fetch('/api/machine-test/save-history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                results: allResultsRef.current,
                account: account?.email ?? null,
                accountLabel: account?.label ?? null,
                sessionId: sessionIdRef.current,
              }),
            }).catch(() => {})
          }
        }
      }

      ws.onclose = (e) => {
        if (done) return
        if (e.code === 4004 || retryCount >= MAX_RETRIES) {
          setReconnecting(false)
          setRunning(false)
          return
        }
        retryCount++
        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 8000)
        setReconnecting(true)
        reconnectTimerRef.current = setTimeout(doConnect, delay)
      }
    }

    doConnect()
  }

  const handleStart = async (pin?: string) => {
    const adminPin = pin ?? sessionStorage.getItem(ADMIN_KEY) ?? ''
    setLogs([])
    setResults([])
    setQueueStatuses([])
    allResultsRef.current = []
    setRunning(true)

    const resp = await fetch('/api/machine-test/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-pin': adminPin },
      body: JSON.stringify({ lobbyUrls: lobbyUrls.filter(u => u.trim()), machineCodes, steps, osmEnv, account: account?.email ?? '', ...(headedMode ? { headedMode: true } : {}), ...(aiAudio && steps.audio ? { aiAudio: true } : {}), ...(debugMode && debugGmid.trim() ? { debugGmid: debugGmid.trim() } : {}), ...(steps.cctv ? { cctvModelSpec: cctvModel } : {}) }),
    }).then(r => r.json()) as { ok: boolean; sessionId?: string; message?: string }

    if (!resp.ok || !resp.sessionId) {
      setLogs([{ type: 'error', message: resp.message ?? '啟動失敗', ts: new Date().toISOString() }])
      setRunning(false)
      return
    }

    const sid = resp.sessionId
    setSessionId(sid)
    sessionIdRef.current = sid

    // Set up writeback context for this session
    capturedSheetUrlRef.current = larkSheetUrl.trim()
    capturedRowMapRef.current = { ...larkRowMap }
    writebackCountRef.current = 0

    connectWS()
  }

  const handleStop = async () => {
    // Cancel any pending reconnect before stopping
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Close WS with code 4004 so onclose handler won't trigger reconnect
    wsRef.current?.close(4004)
    setReconnecting(false)
    setRunning(false)
    if (sessionId) {
      await fetch(`/api/machine-test/stop/${sessionId}`, { method: 'POST' })
    }
  }

  const passCount = results.filter(r => r.overall === 'pass').length
  const failCount = results.filter(r => r.overall === 'fail').length
  const warnCount = results.filter(r => r.overall === 'warn').length

  return (
    <div className="page-layout">
      {/* ── PIN Modal ── */}
      {showPinModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowPinModal(false)}>
          <div className="modal-box" style={{ width: 360 }}>
            <div className="modal-header">
              <h2 style={{ margin: 0 }}>🔒 管理員驗證</h2>
              <button className="modal-close" onClick={() => setShowPinModal(false)}>✕</button>
            </div>
            <div style={{ padding: '20px' }}>
              <p style={{ fontSize: 14, color: '#4b5563', marginTop: 0 }}>機台測試需要管理員 PIN 才能執行</p>
              <input
                ref={pinInputRef}
                type="password"
                placeholder="輸入 PIN"
                value={pinValue}
                onChange={e => setPinValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleVerifyPin()}
                style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #2d3f55', fontSize: 14, boxSizing: 'border-box' }}
              />
              {pinError && <p style={{ color: '#dc2626', fontSize: 13, margin: '8px 0 0' }}>{pinError}</p>}
              <button
                type="button"
                onClick={handleVerifyPin}
                disabled={pinLoading}
                style={{ marginTop: 12, width: '100%', padding: '10px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
              >
                {pinLoading ? '驗證中...' : '確認'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Active Session Banner ── */}
      {activeSessionBanner && !running && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: '#fffbeb', border: '1.5px solid #fbbf24', borderRadius: 8,
          padding: '10px 16px', marginBottom: 12, fontSize: 13,
        }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <span style={{ flex: 1, color: '#92400e' }}>
            <strong>目前有測試正在進行中。</strong>若要查看即時進度，請點擊「觀看」加入廣播頻道。
          </span>
          <button
            type="button"
            onClick={() => {
              setActiveSessionBanner(false)
              setLogs([]); setResults([]); allResultsRef.current = []
              setRunning(true)
              connectWS()
            }}
            style={{ padding: '6px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}
          >
            👁 觀看
          </button>
          <button
            type="button"
            onClick={() => setActiveSessionBanner(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18, lineHeight: 1, padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── OSMWatcher Status Banner ── */}
      <div className={`mt-osm-banner ${osmConnected ? 'mt-osm-banner--on' : 'mt-osm-banner--off'}`}
        style={{ cursor: osmConnected ? 'pointer' : 'default' }}
        onClick={() => osmConnected && setOsmPanelOpen(v => !v)}
      >
        <span className={`mt-osm-dot ${osmConnected ? 'mt-osm-dot--on' : ''}`} />
        {osmConnected
          ? `✅ OSMWatcher 已連線（監控 ${osmCount} 台機台）— 特殊遊戲偵測已啟用`
          : `⚪ OSMWatcher 未連線 — 特殊遊戲偵測停用（Spin 後不會等待 Free Game / Jackpot 結束）`}
        {!osmConnected && (
          <span className="mt-osm-hint">Webhook URL：<code>POST /api/machine-test/osm-status</code></span>
        )}
        {osmConnected && (
          <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{osmPanelOpen ? '▲ 收合' : '▼ 展開監控'}</span>
        )}
      </div>

      {/* ── OSMWatcher 即時監控面板 ── */}
      {osmPanelOpen && osmConnected && (
        <div style={{ background: '#1e293b', border: '1px solid #2d3f55', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ color: '#64748b', fontSize: 12 }}>
              即時機台狀態 — SSE 即時推送
              {osmLastUpdated && <span style={{ marginLeft: 8, opacity: 0.7 }}>最後更新：{osmLastUpdated.toLocaleTimeString()}</span>}
            </span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>{osmCount} 台</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
            {Object.entries(osmMachines).map(([id, { status, label }]) => {
              const isSpecial = status !== 0
              const cardBg = status === 0 ? '#162032'
                : status === 3 || status === 4 ? '#fffbeb'
                : status === 9 ? '#fef2f2'
                : '#f5f3ff'
              const cardBorder = status === 0 ? '#e2e8f0'
                : status === 3 || status === 4 ? '#fcd34d'
                : status === 9 ? '#fca5a5'
                : '#a5b4fc'
              const statusColor = status === 0 ? '#16a34a'
                : status === 3 || status === 4 ? '#d97706'
                : status === 9 ? '#dc2626'
                : '#4f46e5'
              return (
                <div key={id} style={{
                  background: cardBg,
                  border: `1px solid ${cardBorder}`,
                  borderRadius: 6,
                  padding: '7px 10px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  minHeight: 44,
                  gap: 8,
                  minWidth: 0,
                }}>
                  <span style={{ color: '#1e293b', fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{id}</span>
                  <span style={{ color: statusColor, fontSize: 12, fontWeight: 600, background: isSpecial ? `${cardBorder}66` : 'transparent', padding: '2px 6px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {isSpecial ? '⚡ ' : ''}{label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 操作流程 Panel ── */}
      <div className="section-card" style={{ marginBottom: 12 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setFlowPanelOpen(v => !v)}
        >
          <span style={{ fontSize: 15 }}>📋</span>
          <h2 className="section-title" style={{ margin: 0, flex: 1 }}>操作流程</h2>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{flowPanelOpen ? '▲ 收合' : '▼ 展開'}</span>
        </div>

        {flowPanelOpen && (() => {
          // Build ordered step sequence based on enabled steps
          const stepSeq: { key: keyof StepConfig; label: string; enabled: boolean; detail?: string }[] = [
            { key: 'entry', label: '進入機台', enabled: steps.entry },
            { key: 'stream', label: '推流檢測', enabled: steps.stream },
            { key: 'touchscreen', label: '觸屏測試', enabled: steps.touchscreen },
            { key: 'ideck', label: 'iDeck 測試', enabled: steps.ideck },
            { key: 'spin', label: 'Spin 測試', enabled: steps.spin },
            { key: 'audio', label: '音頻檢測', enabled: steps.audio },
            { key: 'cctv', label: 'CCTV 號碼比對', enabled: steps.cctv },
            { key: 'exit', label: '退出測試', enabled: steps.exit },
          ]
          const activeSteps = stepSeq.filter(s => s.enabled)

          // Parse machine codes to derive machineTypes
          const machineCodes = codesText.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
          // Extract machineType: middle segment of "studioId-MACHINETYPE-num" or fallback to whole string
          const typesInTest = [...new Set(machineCodes.map(code => {
            const parts = code.split('-')
            return parts.length >= 3 ? parts.slice(1, parts.length - 1).join('-').toUpperCase() : code.toUpperCase()
          }))]
          const relevantProfiles = profileList.filter(p => typesInTest.some(t => t === p.machineType || t.startsWith(p.machineType)))

          return (
            <div style={{ marginTop: 14 }}>
              {/* Step flow */}
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
                {activeSteps.length === 0 && (
                  <span style={{ fontSize: 13, color: '#94a3b8' }}>未選擇任何測試項目</span>
                )}
                {activeSteps.map((s, i) => (
                  <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: 16,
                      fontSize: 12,
                      fontWeight: 600,
                      background: s.key === 'entry' ? '#e0f2fe' : s.key === 'exit' ? '#fce7f3' : '#f0fdf4',
                      color: s.key === 'entry' ? '#0369a1' : s.key === 'exit' ? '#9d174d' : '#15803d',
                      border: `1px solid ${s.key === 'entry' ? '#bae6fd' : s.key === 'exit' ? '#fbcfe8' : '#bbf7d0'}`,
                    }}>
                      {s.label}
                    </span>
                    {i < activeSteps.length - 1 && (
                      <span style={{ color: '#94a3b8', fontSize: 14 }}>→</span>
                    )}
                  </span>
                ))}
              </div>

              {/* Profile details for machines in test */}
              {machineCodes.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8 }}>機台設定檔對應</div>
                  {relevantProfiles.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>目前機台清單無對應設定檔</p>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {relevantProfiles.map(p => (
                        <div key={p.machineType} style={{ border: '1px solid #2d3f55', borderRadius: 8, padding: '10px 14px', background: '#162032', minWidth: 200 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b', marginBottom: 6 }}>
                            <code style={{ fontSize: 12 }}>{p.machineType}</code>
                          </div>
                          <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
                            {(p.entryTouchPoints ?? []).length > 0 && (
                              <div><span style={{ color: '#0891b2', fontWeight: 600 }}>進入觸屏 S1:</span> {p.entryTouchPoints!.join(', ')}</div>
                            )}
                            {(p.entryTouchPoints2 ?? []).length > 0 && (
                              <div><span style={{ color: '#7c3aed', fontWeight: 600 }}>進入觸屏 S2:</span> {p.entryTouchPoints2!.join(', ')}</div>
                            )}
                            {steps.ideck && (
                              <div>
                                <span style={{ color: '#d97706', fontWeight: 600 }}>iDeck XPath:</span>{' '}
                                {(p.ideckXpaths ?? []).length > 0
                                  ? <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{p.ideckXpaths!.length} 個</span>
                                  : <span style={{ color: '#94a3b8' }}>未設定</span>}
                              </div>
                            )}
                            {steps.touchscreen && (
                              <div>
                                <span style={{ color: '#0f766e', fontWeight: 600 }}>觸屏點位:</span>{' '}
                                {(p.touchPoints ?? []).length > 0
                                  ? p.touchPoints!.join(', ')
                                  : <span style={{ color: '#94a3b8' }}>未設定</span>}
                              </div>
                            )}
                            <div>
                              <span style={{ fontWeight: 600 }}>Bonus:</span> {p.bonusAction}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* ── Settings ── */}
      <div className="two-col">
        <div className="section-card">
          <h2 className="section-title">測試設定</h2>
          <div className="form-stack">
            <div className="field">
              <span>
                大廳 URL <em className="req">*</em>
                <span className="mt-worker-count"> — {lobbyUrls.filter(u => u.trim()).length} 個 Worker</span>
              </span>
              {lobbyUrls.map((url, i) => (
                <div key={i} className="mt-url-row">
                  <span className="mt-worker-badge">W{i + 1}</span>
                  <input
                    value={url}
                    onChange={e => setLobbyUrls(prev => prev.map((u, j) => j === i ? e.target.value : u))}
                    placeholder="https://example.com/lobby?token=..."
                    disabled={running}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn-ghost"
                    title="從帳號池選取"
                    style={{ fontSize: 13, padding: '4px 8px', flexShrink: 0, color: '#2563eb' }}
                    disabled={running}
                    onClick={() => setUrlPickerOpen(i)}>
                    📋
                  </button>
                  {lobbyUrls.length > 1 && (
                    <button type="button" className="btn-ghost"
                      style={{ fontSize: 12, padding: '4px 8px', color: '#ef4444', flexShrink: 0 }}
                      disabled={running}
                      onClick={() => setLobbyUrls(prev => prev.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {urlPickerOpen !== null && (
                <UrlPoolPickerModal
                  workerIndex={urlPickerOpen}
                  onSelect={url => setLobbyUrls(prev => prev.map((u, j) => j === urlPickerOpen ? url : u))}
                  onClose={() => setUrlPickerOpen(null)}
                />
              )}
              <button type="button" className="btn-ghost"
                style={{ fontSize: 12, marginTop: 6, padding: '4px 12px', alignSelf: 'flex-start' }}
                disabled={running}
                onClick={() => setLobbyUrls(prev => [...prev, ''])}>
                + 新增 Worker（帳號）
              </button>
              <span className="field-hint">每個 Worker 使用不同 token 的帳號，並行測試機台（各自跑不同機台）</span>
            </div>

            <div className="field">
              <span>Lark 測試表單 <span className="field-hint" style={{ fontWeight: 'normal' }}>（選填，自動讀取機台清單並回寫結果）</span></span>
              <div className="mt-url-row">
                <input
                  value={larkSheetUrl}
                  onChange={e => { setLarkSheetUrl(e.target.value); setLarkStatus('') }}
                  placeholder="https://casinoplus.sg.larksuite.com/sheets/..."
                  disabled={running}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn-ghost"
                  style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
                  disabled={running || larkLoading || !larkSheetUrl.trim()}
                  onClick={handleLoadLark}>
                  {larkLoading ? '讀取中...' : '讀取機台'}
                </button>
              </div>
              {larkStatus && <span className="field-hint">{larkStatus}</span>}
              {Object.keys(gameCountMap).length > 0 && (
                <div style={{ marginTop: 6, padding: '8px 10px', background: '#162032', border: '1px solid #2d3f55', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }}>
                  {Object.entries(gameCountMap)
                    .sort((a, b) => b[1] - a[1])
                    .map(([game, count]) => (
                      <div key={game} style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '1px 0' }}>
                        <span style={{ color: '#cbd5e1' }}>{game}</span>
                        <span style={{ color: '#94a3b8' }}>{count} 台</span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <label className="field">
              <span>機台代碼清單 <em className="req">*</em></span>
              <textarea
                className="mt-codes-textarea"
                value={codesText}
                onChange={e => setCodesText(e.target.value)}
                placeholder={'4179-JJBX-0001\n4179-JJBX-0002\n4179-DFDC-0001\n（每行一個，或逗號分隔）'}
                rows={6}
                disabled={running}
              />
              <span className="field-hint">{machineCodes.length} 個機台</span>
            </label>

            <div>
              <div className="field-label" style={{ marginBottom: 8 }}>測試項目</div>
              <div className="mt-step-checks">
                {(Object.keys(steps) as (keyof StepConfig)[]).map(k => {
                  const isSoon = STEP_BADGE[k] === 'soon'
                  return (
                    <label key={k} className={`mt-step-check${isSoon ? ' mt-step-check--soon' : ''}`}>
                      <input
                        type="checkbox"
                        checked={steps[k]}
                        onChange={e => setSteps(prev => ({ ...prev, [k]: e.target.checked }))}
                        disabled={running || isSoon}
                      />
                      {STEP_LABELS[k]}
                      {isSoon && <span className="mt-soon-badge">待串接</span>}
                    </label>
                  )
                })}
              </div>
            </div>

            {steps.audio && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={aiAudio} onChange={e => setAiAudio(e.target.checked)} disabled={running} />
                <span style={{ color: aiAudio ? '#7c3aed' : '#6b7280', fontWeight: aiAudio ? 600 : 400 }}>🤖 AI 音頻分析</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>錄音傳送 Gemini 判斷靜音/音量/爆音/雜訊（每台多 ~2s）</span>
              </label>
            )}

            {steps.cctv && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: '#cbd5e1', whiteSpace: 'nowrap' }}>CCTV AI 模型</span>
                <ModelSelector value={cctvModel} onChange={setCctvModel} style={{ flex: 1 }} />
              </div>
            )}
          </div>

          <div style={{ marginTop: 12, padding: '10px 12px', background: '#162032', border: '1.5px solid #e2e8f0', borderRadius: 8, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1', whiteSpace: 'nowrap' }}>📡 日誌 API 環境</span>
            {(['qat', 'prod'] as const).map(env => (
              <label key={env} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="osmEnv" value={env} checked={osmEnv === env} onChange={() => setOsmEnv(env)} disabled={running} />
                <span style={{
                  fontWeight: osmEnv === env ? 700 : 400,
                  color: env === 'prod' ? (osmEnv === 'prod' ? '#dc2626' : '#9ca3af') : (osmEnv === 'qat' ? '#2563eb' : '#9ca3af'),
                }}>
                  {env.toUpperCase()}
                </span>
              </label>
            ))}
            <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>
              {osmEnv === 'prod' ? 'prod-osmtrace.osmslot.org' : 'qat-osmtrace.osmslot.org'}
            </span>
          </div>

          <div style={{ marginTop: 0, padding: '10px 12px', background: headedMode ? 'rgba(59,130,246,0.08)' : '#162032', border: `1.5px solid ${headedMode ? 'rgba(59,130,246,0.4)' : '#2d3f55'}`, borderRadius: 8, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={headedMode} onChange={e => setHeadedMode(e.target.checked)} disabled={running} />
              <span style={{ fontSize: 13, fontWeight: 600, color: headedMode ? '#60a5fa' : '#cbd5e1' }}>👀 Headed 模式</span>
              <span style={{ fontSize: 11, color: headedMode ? '#93c5fd' : '#64748b' }}>瀏覽器視窗顯示在螢幕上，可觀看操作流程</span>
            </label>
          </div>

          <div style={{ marginTop: 0, padding: '10px 12px', background: debugMode ? 'rgba(251,191,36,0.08)' : '#162032', border: `1.5px solid ${debugMode ? 'rgba(251,191,36,0.4)' : '#2d3f55'}`, borderRadius: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={debugMode} onChange={e => { setDebugMode(e.target.checked); if (!e.target.checked) setDebugGmid('') }} disabled={running} />
              <span style={{ fontSize: 13, fontWeight: 600, color: debugMode ? '#92400e' : '#374151' }}>Test 調適模式</span>
              {debugMode && <span style={{ fontSize: 11, color: '#b45309' }}>盒子日誌 API 的渠道號前綴將替換為指定值</span>}
            </label>
            {debugMode && (
              <input
                type="text"
                value={debugGmid}
                onChange={e => setDebugGmid(e.target.value)}
                placeholder="渠道號，例如：873"
                disabled={running}
                style={{ marginTop: 8, width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #fbbf24', fontSize: 13, background: '#fffbeb', boxSizing: 'border-box' }}
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 4 }}>
            {isAdmin
              ? <span style={{ fontSize: 12, color: '#16a34a' }}>🔓 管理員已解鎖 <button type="button" onClick={() => { setIsAdmin(false); sessionStorage.removeItem(ADMIN_KEY) }} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>登出</button></span>
              : <span style={{ fontSize: 12, color: '#64748b' }}>🔒 需要管理員 PIN 才能執行測試</span>
            }
          </div>

          {/* Agent status */}
          {agentStatus.length > 0 && (
            <div style={{ fontSize: 12, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
              🤖 {agentStatus.length} 個 Agent 已連線：{agentStatus.map(a => (
                <span key={a.agentId} style={{ marginRight: 8, color: a.busy ? '#f59e0b' : '#16a34a' }}>
                  {a.hostname}{a.busy ? '（執行中）' : '（待機）'}
                </span>
              ))}
            </div>
          )}

          {!account && (
            <div style={{ padding: '10px 14px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 13, color: '#92400e', marginBottom: 8 }}>
              ⚠️ 請先在右上角選擇帳號，才能執行測試（結果將與帳號關聯）
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`submit-btn${running ? ' loading' : ''}`}
              disabled={running || !account || lobbyUrls.every(u => !u.trim()) || machineCodes.length === 0}
              onClick={() => {
                if (!isAdmin) { setShowPinModal(true); return }
                handleStart()
              }}
              style={{ flex: 1 }}
            >
              {running
                ? reconnecting ? '🔄 重新連線中...' : '⏳ 測試進行中...'
                : `▶ 開始測試（${machineCodes.length} 台 × ${lobbyUrls.filter(u => u.trim()).length} Worker${agentStatus.length > 0 ? ` + ${agentStatus.length} Agent` : ''}）`}
            </button>
            {!running && (
              <button
                type="button"
                onClick={() => { setActiveSessionBanner(false); setLogs([]); setResults([]); allResultsRef.current = []; setRunning(true); connectWS() }}
                title="連線廣播頻道，觀看進行中的測試進度"
                style={{ padding: '10px 14px', background: '#f0fdf4', color: '#16a34a', border: '1.5px solid #86efac', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}
              >
                👁 觀看
              </button>
            )}
            {running && (
              <button
                type="button"
                onClick={handleStop}
                style={{ padding: '10px 18px', background: '#fef2f2', color: '#dc2626', border: '1.5px solid #fca5a5', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}
              >
                ■ 停止
              </button>
            )}
          </div>
        </div>

        {/* ── Summary ── */}
        <div className="section-card">
          <h2 className="section-title">測試摘要</h2>
          {results.length === 0 && !running && (
            <span className="idle-hint">填寫左側設定後按「開始測試」</span>
          )}
          {(results.length > 0 || running) && (
            <>
              <div className="mt-summary-row">
                <div className="mt-summary-item mt-summary-pass">
                  <span className="mt-summary-num">{passCount}</span>
                  <span>通過</span>
                </div>
                <div className="mt-summary-item mt-summary-warn">
                  <span className="mt-summary-num">{warnCount}</span>
                  <span>警告</span>
                </div>
                <div className="mt-summary-item mt-summary-fail">
                  <span className="mt-summary-num">{failCount}</span>
                  <span>失敗</span>
                </div>
                <div className="mt-summary-item mt-summary-total">
                  <span className="mt-summary-num">{results.length}</span>
                  <span>/ {queueStatuses.length || machineCodes.length}</span>
                </div>
              </div>

              {running && (
                <div className="mt-progress-bar">
                  <div
                    className="mt-progress-fill"
                    style={{ width: `${(queueStatuses.length || machineCodes.length) ? (results.length / (queueStatuses.length || machineCodes.length)) * 100 : 0}%` }}
                  />
                </div>
              )}
            </>
          )}

          {/* Live log */}
          <div ref={logBoxRef} className="mt-log-box">
            {logs.map((ev, i) => (
              <div key={i} className={`mt-log-line mt-log--${ev.status ?? 'info'}`}>
                <span className="mt-log-ts">{new Date(ev.ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}</span>
                {ev.machineCode && <span className="mt-log-code">[{ev.machineCode}]</span>}
                {ev.agentHostname && <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 4 }}>@{ev.agentHostname}</span>}
                <span>{ev.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Work-Stealing Queue Status ── */}
      {queueStatuses.length > 0 && (
        <div className="section-card">
          <h2 className="section-title">分散式佇列狀態</h2>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>機台代碼</th>
                  <th>狀態</th>
                  <th>執行 Agent</th>
                  <th>耗時</th>
                </tr>
              </thead>
              <tbody>
                {queueStatuses.map(j => {
                  const stateColor: Record<string, string> = {
                    pending: '#94a3b8',
                    running: '#0ea5e9',
                    done: '#22c55e',
                    failed: '#ef4444',
                  }
                  const stateLabel: Record<string, string> = {
                    pending: '等待中',
                    running: '執行中',
                    done: '完成',
                    failed: '失敗',
                  }
                  const durationMs = j.finishedAt && j.startedAt
                    ? j.finishedAt - j.startedAt
                    : j.startedAt && j.state === 'running'
                      ? Date.now() - j.startedAt
                      : null
                  const durStr = durationMs != null
                    ? durationMs >= 60000
                      ? `${Math.floor(durationMs / 60000)}m${Math.floor((durationMs % 60000) / 1000)}s`
                      : `${(durationMs / 1000).toFixed(1)}s`
                    : '—'
                  return (
                    <tr key={j.machineCode}>
                      <td><code style={{ fontSize: 12 }}>{j.machineCode}</code></td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                          background: `${stateColor[j.state]}22`, color: stateColor[j.state],
                        }}>
                          {j.state === 'running' ? '⚡ ' : ''}{stateLabel[j.state] ?? j.state}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>{j.agentId ?? '—'}</td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>{durStr}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Results table ── */}
      {results.length > 0 && (
        <div className="section-card">
          <h2 className="section-title">測試結果（{results.length} 台）</h2>
          <div className="table-wrap">
            <table className="version-table">
              <thead>
                <tr>
                  <th>機台代碼</th>
                  <th>整體</th>
                  {Object.values(STEP_LABELS).map(l => <th key={l}>{l}</th>)}
                  <th>耗時</th>
                  <th>詳情</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => {
                  const totalMs = r.steps.reduce((s, x) => s + x.durationMs, 0)
                  const isExp = expandedCode === r.machineCode
                  return (
                    <>
                      <tr key={r.machineCode}>
                        <td><code style={{ fontSize: 12 }}>{r.machineCode}</code></td>
                        <td>
                          <span className={`badge ${statusClass(r.overall)}`}>
                            {statusIcon(r.overall)} {r.overall.toUpperCase()}
                          </span>
                        </td>
                        {Object.keys(STEP_LABELS).map(k => {
                          const step = r.steps.find(s => s.step === STEP_LABELS[k as keyof StepConfig])
                          return (
                            <td key={k}>
                              {step ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span title={step.message}>{statusIcon(step.status)}</span>
                                  {k === 'cctv' && (
                                    <img
                                      src={`/api/machine-test/cctv-saves/${r.machineCode}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`}
                                      alt=""
                                      style={{ height: 28, width: 'auto', borderRadius: 3, cursor: 'pointer', border: '1px solid #2d3f55' }}
                                      onClick={() => setCctvPreview(`/api/machine-test/cctv-saves/${r.machineCode}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`)}
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                    />
                                  )}
                                  {k === 'audio' && (
                                    <AudioPlayer machineCode={r.machineCode} sessionId={sessionId} />
                                  )}
                                </span>
                              ) : (
                                <span style={{ color: '#cbd5e1' }}>—</span>
                              )}
                            </td>
                          )
                        })}
                        <td style={{ fontSize: 12, color: '#64748b' }}>{(totalMs / 1000).toFixed(1)}s</td>
                        <td>
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ fontSize: 12, padding: '3px 10px' }}
                            onClick={() => setExpandedCode(isExp ? null : r.machineCode)}
                          >
                            {isExp ? '收起' : '展開'}
                          </button>
                        </td>
                      </tr>
                      {isExp && (
                        <tr key={`${r.machineCode}-detail`} className="tc-detail-row">
                          <td colSpan={4 + Object.keys(STEP_LABELS).length}>
                            <div className="tc-detail">
                              {r.steps.map((s, i) => (
                                <div key={i} className="tc-detail-item">
                                  <strong>{statusIcon(s.status)} {s.step} <span style={{ fontWeight: 400, fontSize: 11, color: '#94a3b8' }}>({(s.durationMs / 1000).toFixed(1)}s)</span></strong>
                                  <p>{s.message}</p>
                                </div>
                              ))}
                              {r.consoleLogs.length > 0 && (
                                <div className="tc-detail-item">
                                  <strong>🖥️ 前端 Console Log（{r.consoleLogs.length} 筆）</strong>
                                  <div className="mt-console-logs">
                                    {r.consoleLogs.map((l, i) => (
                                      <div key={i} className={`mt-console-line${l.includes('[JS Error]') || l.includes('console.error') ? ' mt-console--error' : ' mt-console--warn'}`}>{l}</div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── CCTV Screenshot Lightbox ── */}
      {cctvPreview && (
        <div
          onClick={() => setCctvPreview(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <img
            src={cctvPreview}
            alt="CCTV"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
            onClick={e => e.stopPropagation()}
          />
          <span
            onClick={() => setCctvPreview(null)}
            style={{ position: 'fixed', top: 20, right: 28, color: '#fff', fontSize: 28, cursor: 'pointer', lineHeight: 1 }}
          >✕</span>
        </div>
      )}

      {/* ── My History Panel ── */}
      {account && <MyHistoryPanel account={account} />}

      {/* ── Machine Profiles ── */}
      <ProfilesPanel />

      {/* ── Agent Install Guide ── */}
      <AgentInstallGuide agentCount={agentStatus.length} />

      {/* ── Phase 2 & 3 Placeholders ── */}
      <div className="two-col">
        <div className="section-card mt-phase-card">
          <div className="mt-phase-header">
            <span className="mt-phase-badge">Phase 2</span>
            <h2 className="section-title" style={{ margin: 0 }}>🎮 iDeck / 觸屏測試</h2>
            <span className="mt-soon-badge" style={{ marginLeft: 'auto', background: '#22c55e', color: '#fff' }}>已串接</span>
          </div>
          <p className="mt-phase-desc">
            透過 Playwright 點擊 iDeck 按鈕與觸屏點位，驗證機台 LOG（daily-analysis API）中出現對應的 success_json 回應（is_ideck / is_touch），確認硬體指令有正確送達並被機台執行。
          </p>
          <div className="mt-phase-todo">
            <div className="mt-todo-item">✅ iDeck：點擊所有下注 XPath，API 確認 success_json is_ideck=true</div>
            <div className="mt-todo-item">✅ 觸屏：點擊 touchPoints 點位，API 確認 success_json is_touch=true</div>
            <div className="mt-todo-item">✅ 基準比對法：點擊前後對比，避免時鐘偏差問題</div>
          </div>
        </div>

        <div className="section-card mt-phase-card">
          <div className="mt-phase-header">
            <span className="mt-phase-badge mt-phase-badge--3">Phase 3</span>
            <h2 className="section-title" style={{ margin: 0 }}>📹 CCTV 號碼比對</h2>
            <span className="mt-soon-badge" style={{ marginLeft: 'auto', background: '#22c55e', color: '#fff' }}>已串接</span>
          </div>
          <p className="mt-phase-desc">
            點擊 <code>.header_btn_item</code> 切換至 CCTV 畫面，確認 <code>video[id*="CCTV"]</code> 有播放，
            截圖後以 Gemini Vision OCR 讀取畫面上的機台號碼。
          </p>
          <div className="mt-phase-todo">
            <div className="mt-todo-item">✅ 點擊第一顆 header_btn_item 切換 CCTV</div>
            <div className="mt-todo-item">✅ 偵測 video 播放狀態（黑畫面判定）</div>
            <div className="mt-todo-item">✅ Gemini Vision OCR 讀取畫面號碼</div>
            <div className="mt-todo-item">⏳ 號碼與機台代碼自動比對（待確認格式）</div>
          </div>
        </div>

      </div>
    </div>
  )
}
