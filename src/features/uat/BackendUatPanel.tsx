import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BACKEND_MODULES, createBackendModule, createCustomBackendModule, createDefaultBackendPlan, matchesBackendModule } from './backend-modules'
import type { BackendModuleId, BackendModuleTone, BackendPlanModule, RunStatus, TcGroup, UatConfig, UatThemeMode } from './types'

const STORAGE_KEY = 'osm_uat_config'
const TONES: BackendModuleTone[] = ['blue', 'cyan', 'violet', 'amber', 'orange', 'green', 'rose', 'slate']

function newInstanceId(prefix = 'custom') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function sanitizeModule(value: unknown): BackendPlanModule | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<BackendPlanModule>
  if (typeof item.instanceId !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.filters)) return null
  const filters = item.filters.filter((filter): filter is string => typeof filter === 'string' && filter.trim().length > 0).map(filter => filter.trim())
  if (!filters.length) return null
  return {
    instanceId: item.instanceId,
    sourceId: item.sourceId ?? 'custom',
    name: item.name,
    xianxiaName: typeof item.xianxiaName === 'string' ? item.xianxiaName : item.name,
    description: typeof item.description === 'string' ? item.description : '',
    tone: TONES.includes(item.tone as BackendModuleTone) ? item.tone as BackendModuleTone : 'blue',
    filters,
  }
}

function loadConfig(): UatConfig {
  const defaults: UatConfig = { larkUrl: '', filter: '', dashGameType: '', dashClientVersion: '', modulePlan: createDefaultBackendPlan() }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<UatConfig> & { modulePlan?: unknown[] }
    let modulePlan = defaults.modulePlan
    if (Array.isArray(stored.modulePlan) && stored.modulePlan.length) {
      if (stored.modulePlan.every(item => typeof item === 'string')) {
        modulePlan = stored.modulePlan.flatMap(id => {
          const definition = BACKEND_MODULES.find(module => module.id === id)
          return definition ? [createBackendModule(definition)] : []
        })
      } else {
        modulePlan = stored.modulePlan.map(sanitizeModule).filter((module): module is BackendPlanModule => Boolean(module))
      }
    }
    return { ...defaults, ...stored, modulePlan: modulePlan.length ? modulePlan : defaults.modulePlan }
  } catch { return defaults }
}

export function BackendUatPanel({ themeMode }: { themeMode: UatThemeMode }) {
  const xianxia = themeMode === 'xianxia'
  const [config, setConfig] = useState(loadConfig)
  const [status, setStatus] = useState<RunStatus>('idle')
  const statusRef = useRef<RunStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [groups, setGroups] = useState<TcGroup[] | null>(null)
  const [total, setTotal] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [draggedModule, setDraggedModule] = useState<string | null>(null)
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(config.modulePlan[0]?.instanceId ?? null)
  const [settingsView, setSettingsView] = useState<'run' | 'module'>('run')
  // 後台測試帳密：依登入帳號各存一份在後端（不再放 repo 裡的 config 檔）。
  // 這裡永遠拿不到密碼本身，只知道「有沒有設過」；密碼欄留空送出＝沿用舊密碼。
  const [creds, setCreds] = useState<{ profile: string; username: string; hasPassword: boolean }[]>([])
  const [credDraft, setCredDraft] = useState<Record<string, { username: string; password: string }>>({})
  const [credMsg, setCredMsg] = useState('')
  const loadCreds = useCallback(async () => {
    try {
      const response = await fetch('/api/osm-uat/backend-credentials')
      const data = await response.json() as { ok: boolean; credentials?: { profile: string; username: string; hasPassword: boolean }[] }
      if (data.ok) setCreds(data.credentials ?? [])
    } catch { /* 設定讀不到就讓畫面留空，不擋住主要流程 */ }
  }, [])
  useEffect(() => { void loadCreds() }, [loadCreds])
  const saveCred = async (profile: string) => {
    const draft = credDraft[profile] ?? { username: '', password: '' }
    const username = draft.username || creds.find(item => item.profile === profile)?.username || ''
    if (!username) { setCredMsg('請先填帳號'); return }
    setCredMsg('儲存中…')
    try {
      const response = await fetch('/api/osm-uat/backend-credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, username, password: draft.password || undefined }),
      })
      const data = await response.json() as { ok: boolean; message?: string; credentials?: typeof creds }
      if (data.ok) {
        setCreds(data.credentials ?? [])
        setCredDraft(prev => ({ ...prev, [profile]: { username: '', password: '' } }))
        setCredMsg('已儲存')
      } else {
        setCredMsg(data.message ?? '儲存失敗')
      }
    } catch { setCredMsg('儲存失敗') }
  }
  const streamRef = useRef<EventSource | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  const connect = useCallback(() => {
    streamRef.current?.close()
    const stream = new EventSource('/api/osm-uat/stream')
    streamRef.current = stream
    stream.addEventListener('log', event => setLogs(lines => [...lines, (JSON.parse(event.data) as { line: string }).line]))
    stream.addEventListener('status', event => {
      const next = (JSON.parse(event.data) as { status: RunStatus }).status
      statusRef.current = next
      setStatus(next)
      if (next === 'done' || next === 'error') { stream.close(); streamRef.current = null }
    })
    stream.onerror = () => {
      stream.close(); streamRef.current = null
      if (statusRef.current === 'running') window.setTimeout(connect, 3000)
    }
  }, [])

  useEffect(() => { connect(); return () => streamRef.current?.close() }, [connect])
  useEffect(() => { if (autoScroll && status === 'running') logEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [autoScroll, logs, status])

  const update = (patch: Partial<UatConfig>) => setConfig(value => {
    const next = { ...value, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  })

  const selectedModule = config.modulePlan.find(module => module.instanceId === selectedModuleId) ?? null
  const modulePlanValid = config.modulePlan.length > 0 && config.modulePlan.every(module => module.name.trim() && module.filters.length > 0)
  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const group of groups ?? []) {
      const specific = config.modulePlan.find(module => !module.filters.includes('*') && matchesBackendModule(module, group.name))
      const fallback = config.modulePlan.find(module => module.filters.includes('*'))
      const match = specific ?? fallback
      if (match) counts.set(match.instanceId, (counts.get(match.instanceId) ?? 0) + group.count)
    }
    return counts
  }, [config.modulePlan, groups])

  const updateModule = (instanceId: string, patch: Partial<BackendPlanModule>) => update({
    modulePlan: config.modulePlan.map(module => module.instanceId === instanceId ? { ...module, ...patch } : module),
  })
  const selectModule = (instanceId: string) => { setSelectedModuleId(instanceId); setSettingsView('module') }
  const addModule = (id: BackendModuleId) => {
    const definition = BACKEND_MODULES.find(module => module.id === id)
    if (!definition) return
    const module = createBackendModule(definition, newInstanceId(id))
    update({ modulePlan: [...config.modulePlan, module] }); selectModule(module.instanceId)
  }
  const addCustomModule = () => {
    const module = createCustomBackendModule(newInstanceId())
    update({ modulePlan: [...config.modulePlan, module] }); selectModule(module.instanceId)
  }
  const duplicateModule = (instanceId: string) => {
    const source = config.modulePlan.find(module => module.instanceId === instanceId)
    if (!source) return
    const copy = { ...source, instanceId: newInstanceId(source.sourceId), name: `${source.name} 副本`, xianxiaName: `${source.xianxiaName} 副本`, filters: [...source.filters] }
    const index = config.modulePlan.findIndex(module => module.instanceId === instanceId)
    const next = [...config.modulePlan]; next.splice(index + 1, 0, copy)
    update({ modulePlan: next }); selectModule(copy.instanceId)
  }
  const removeModule = (instanceId: string) => {
    const next = config.modulePlan.filter(module => module.instanceId !== instanceId)
    update({ modulePlan: next })
    if (selectedModuleId === instanceId) { setSelectedModuleId(next[0]?.instanceId ?? null); setSettingsView(next.length ? 'module' : 'run') }
  }
  const moveModule = (source: string, target: string) => {
    if (source === target) return
    const next = [...config.modulePlan]
    const from = next.findIndex(module => module.instanceId === source); const to = next.findIndex(module => module.instanceId === target)
    if (from < 0 || to < 0) return
    const [moved] = next.splice(from, 1); next.splice(to, 0, moved)
    update({ modulePlan: next })
  }
  const moveModuleBy = (instanceId: string, offset: -1 | 1) => {
    const from = config.modulePlan.findIndex(module => module.instanceId === instanceId); const to = from + offset
    if (from < 0 || to < 0 || to >= config.modulePlan.length) return
    const next = [...config.modulePlan]; [next[from], next[to]] = [next[to], next[from]]; update({ modulePlan: next })
  }

  const scan = async () => {
    if (!config.larkUrl) return
    setScanning(true); setGroups(null)
    try {
      const response = await fetch(`/api/osm-uat/scan?larkUrl=${encodeURIComponent(config.larkUrl)}`)
      const data = await response.json() as { ok?: boolean; total?: number; groups?: TcGroup[]; error?: string }
      if (!data.ok) return window.alert(data.error ?? '掃描失敗')
      setTotal(data.total ?? 0); setGroups(data.groups ?? [])
    } finally { setScanning(false) }
  }

  const run = async () => {
    if (!config.modulePlan.length) return window.alert('請至少加入一個 Backend 測試模組')
    if (!modulePlanValid) return window.alert('每個模組都必須有名稱與至少一條 TC 匹配規則')
    setLogs([]); statusRef.current = 'running'; setStatus('running')
    const response = await fetch('/api/osm-uat/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, filter: config.filter || undefined, dashGameType: config.dashGameType || undefined, dashClientVersion: config.dashClientVersion || undefined }) })
    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: '啟動失敗' })) as { error?: string }
      statusRef.current = 'idle'; setStatus('idle'); return window.alert(`啟動失敗：${data.error}`)
    }
    connect()
  }

  const summary = logs.reduce((result, line) => {
    const match = line.match(/通過:\s*(\d+).*需人工:\s*(\d+).*跳過:\s*(\d+).*失敗:\s*(\d+)/)
    return match ? { pass: +match[1], manual: +match[2], skip: +match[3], fail: +match[4] } : result
  }, { pass: 0, manual: 0, skip: 0, fail: 0 })
  const statusLabel = status === 'idle' ? (xianxia ? '玉簡未啟' : '待機') : status === 'running' ? (xianxia ? '推演中' : '執行中') : status === 'done' ? (xianxia ? '推演完成' : '完成') : (xianxia ? '陣眼失守' : '錯誤')

  return (
    <div className="uat-backend-workbench">
      <aside className="uat-backend-library">
        <div className="uat-pane-heading"><div><span>{xianxia ? 'SPELL LIBRARY' : 'MODULE LIBRARY'}</span><h3>{xianxia ? '術式庫' : '模組庫'}</h3><small>模板可重複加入並獨立編輯</small></div></div>
        <button type="button" className="uat-btn is-primary is-wide uat-backend-create" disabled={status === 'running'} onClick={addCustomModule}>{xianxia ? '新增自訂術式' : '新增自訂模組'}</button>
        {(['核心資料', '營運驗證', '系統治理'] as const).map(category => (
          <section className="uat-backend-library-group" key={category}><h4>{category}</h4>
            {BACKEND_MODULES.filter(module => module.category === category).map(module => <button type="button" className={`uat-backend-library-item is-${module.tone}`} onClick={() => addModule(module.id)} disabled={status === 'running'} key={module.id}><i /><span><strong>{xianxia ? module.xianxiaName : module.name}</strong><small>{module.description}</small></span><b>加入</b></button>)}
          </section>
        ))}
      </aside>

      <main className="uat-backend-flow">
        <div className="uat-backend-flow-head">
          <div className="uat-section-title"><span>{xianxia ? 'TRIAL SEQUENCE' : 'EXECUTION FLOW'}</span><h3>{xianxia ? '推演順序' : '執行流程'} <small>{config.modulePlan.length + 1} 個模組</small></h3><p>拖曳調整順序；點選卡片可編輯名稱、說明與 TC 匹配規則。</p></div>
          <div className="uat-backend-flow-actions"><button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={addCustomModule}>新增模組</button><button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => { const plan = createDefaultBackendPlan(); update({ modulePlan: plan }); setSelectedModuleId(plan[0]?.instanceId ?? null) }}>還原預設</button><button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => { update({ modulePlan: [] }); setSelectedModuleId(null); setSettingsView('run') }}>清空流程</button></div>
        </div>
        <div className="uat-backend-module-list">
          <article className="uat-backend-module is-fixed is-cyan"><span className="uat-backend-module-grip" aria-hidden="true"><i /><i /><i /></span><div><strong>{xianxia ? '共用登入傀儡' : '共用登入與初始化'}</strong><small>取得 Lark token、載入 TC registry、啟動 Chromium 並登入 CP Backend</small></div><em>固定</em></article>
          {config.modulePlan.map((module, index) => (
            <article className={`uat-backend-module is-${module.tone}${draggedModule === module.instanceId ? ' is-dragging' : ''}${selectedModuleId === module.instanceId ? ' is-selected' : ''}`} draggable={status !== 'running'} onClick={() => selectModule(module.instanceId)} onDragStart={() => setDraggedModule(module.instanceId)} onDragEnd={() => setDraggedModule(null)} onDragOver={event => event.preventDefault()} onDrop={() => { if (draggedModule) moveModule(draggedModule, module.instanceId); setDraggedModule(null) }} key={module.instanceId}>
              <span className="uat-backend-module-grip" aria-hidden="true"><i /><i /><i /></span><span className="uat-backend-module-index">{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{xianxia ? module.xianxiaName : module.name}{module.sourceId === 'custom' && <b className="uat-backend-custom-badge">自訂</b>}</strong><small>{module.description}</small><span className="uat-backend-rule-preview">{module.filters.join(' · ')}</span></div>
              {groups && <em>{moduleCounts.get(module.instanceId) ?? 0} TC</em>}
              <span className="uat-backend-module-actions"><button type="button" disabled={status === 'running' || index === 0} onClick={event => { event.stopPropagation(); moveModuleBy(module.instanceId, -1) }}>上移</button><button type="button" disabled={status === 'running' || index === config.modulePlan.length - 1} onClick={event => { event.stopPropagation(); moveModuleBy(module.instanceId, 1) }}>下移</button><button type="button" disabled={status === 'running'} onClick={event => { event.stopPropagation(); duplicateModule(module.instanceId) }}>複製</button><button type="button" disabled={status === 'running'} onClick={event => { event.stopPropagation(); removeModule(module.instanceId) }}>移除</button></span>
            </article>
          ))}
          {!config.modulePlan.length && <div className="uat-backend-flow-empty"><strong>尚未加入測試模組</strong><span>新增自訂模組，或從左側模板庫加入。</span></div>}
        </div>
        <footer className="uat-backend-flow-foot"><span>每個模組都是獨立實例，設定會儲存在此瀏覽器並傳入新的 runner process。</span><b>{groups ? `已掃描 ${total} TC` : '尚未掃描 TC'}</b></footer>
      </main>

      <aside className="uat-backend-settings">
        <div className="uat-backend-settings-tabs"><button type="button" className={settingsView === 'run' ? 'is-active' : ''} onClick={() => setSettingsView('run')}>執行設定</button><button type="button" className={settingsView === 'module' ? 'is-active' : ''} disabled={!selectedModule} onClick={() => setSettingsView('module')}>模組編輯</button></div>
        {settingsView === 'module' && selectedModule ? <>
          <div className="uat-pane-heading"><div><span>{xianxia ? 'SPELL CONTRACT' : 'MODULE CONTRACT'}</span><h3>{xianxia ? '術式設定' : '模組編輯'}</h3><small>修改會即時保存到目前流程</small></div></div>
          <div className="uat-backend-settings-form uat-backend-module-editor">
            <label>普通版名稱<input className="uat-field" value={selectedModule.name} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { name: event.target.value })} /></label>
            <label>修仙版名稱<input className="uat-field" value={selectedModule.xianxiaName} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { xianxiaName: event.target.value })} /></label>
            <label>模組說明<textarea className="uat-field" value={selectedModule.description} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { description: event.target.value })} /></label>
            <label>TC 匹配規則<textarea className="uat-field uat-code-field uat-backend-rules" value={selectedModule.filters.join('\n')} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { filters: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} placeholder={'每行一個關鍵字\n例如：Daily Ranking'} /><small>不區分大小寫，匹配任務類型或子類型；單獨輸入 * 代表接收未分類 TC。</small></label>
            <label>識別色<select className="uat-field" value={selectedModule.tone} disabled={status === 'running'} onChange={event => updateModule(selectedModule.instanceId, { tone: event.target.value as BackendModuleTone })}>{TONES.map(tone => <option value={tone} key={tone}>{tone}</option>)}</select></label>
          </div>
          <div className="uat-backend-editor-meta"><span>模組 ID</span><code>{selectedModule.instanceId}</code><b>{groups ? `${moduleCounts.get(selectedModule.instanceId) ?? 0} TC` : `${selectedModule.filters.length} 條規則`}</b></div>
          <div className="uat-backend-editor-actions"><button type="button" className="uat-btn is-quiet" disabled={status === 'running'} onClick={() => duplicateModule(selectedModule.instanceId)}>複製模組</button><button type="button" className="uat-btn is-danger" disabled={status === 'running'} onClick={() => removeModule(selectedModule.instanceId)}>移除模組</button></div>
        </> : <>
          <div className="uat-pane-heading"><div><span>{xianxia ? 'ARRAY SETTINGS' : 'RUN SETTINGS'}</span><h3>{xianxia ? '陣眼設定' : '執行設定'}</h3><small>套用至本次模組流程</small></div></div>
          <div className="uat-backend-settings-form">
            <div className="uat-backend-cred-box">
              <b>後台登入帳密</b>
              <small>用你自己的帳號跑測試；密碼只會存在伺服器，畫面不會顯示。留空不改密碼。</small>
              {creds.map(item => {
                const draft = credDraft[item.profile] ?? { username: '', password: '' }
                const label = item.profile === 'cpBackend' ? 'CP 後台' : 'NC 後台'
                return (
                  <div className="uat-backend-cred-row" key={item.profile}>
                    <span>{label}{item.hasPassword ? ' · 已設定' : ' · 未設定'}</span>
                    <input className="uat-field" placeholder={item.username || '帳號'} value={draft.username}
                      onChange={event => setCredDraft(prev => ({ ...prev, [item.profile]: { ...draft, username: event.target.value } }))} />
                    <input className="uat-field" type="password" placeholder={item.hasPassword ? '（留空不改）' : '密碼'} value={draft.password}
                      onChange={event => setCredDraft(prev => ({ ...prev, [item.profile]: { ...draft, password: event.target.value } }))} />
                    <button type="button" className="uat-btn is-quiet" onClick={() => void saveCred(item.profile)}>儲存</button>
                  </div>
                )
              })}
              {credMsg && <small>{credMsg}</small>}
            </div>
            <label>{xianxia ? 'Lark 玉簡路徑' : 'Lark TC 路徑'}<textarea className="uat-field uat-backend-url" value={config.larkUrl} onChange={event => update({ larkUrl: event.target.value })} placeholder="https://xxx.larksuite.com/base/...?table=..." /></label>
            <button type="button" className="uat-btn is-quiet is-wide" disabled={!config.larkUrl || scanning} onClick={scan}>{scanning ? '掃描中' : (xianxia ? '重整玉簡索引' : '掃描 Lark TC')}</button>
            <label>{xianxia ? '玉簡篩選' : 'Subtype 追加篩選'}<input className="uat-field" value={config.filter} onChange={event => update({ filter: event.target.value })} placeholder="留空套用模組範圍" /><small>以逗號分隔，會在模組範圍內再縮小。</small></label>
            <div className="uat-backend-setting-pair"><label>Game Type<input className="uat-field" value={config.dashGameType} onChange={event => update({ dashGameType: event.target.value })} placeholder="BWJL" /></label><label>Client Version<input className="uat-field" value={config.dashClientVersion} onChange={event => update({ dashClientVersion: event.target.value })} placeholder="H5(1.5)" /></label></div>
          </div>
          <div className="uat-backend-run-summary"><span><b>{config.modulePlan.length}</b> 個可執行模組</span><span><b>{groups ? config.modulePlan.reduce((sum, module) => sum + (moduleCounts.get(module.instanceId) ?? 0), 0) : '—'}</b> 個匹配 TC</span></div>
          <div className="uat-backend-run-actions"><button type="button" className="uat-btn is-primary is-wide" disabled={status === 'running' || !modulePlanValid || !config.larkUrl} onClick={run}>{xianxia ? '依序啟陣' : '執行模組流程'}</button><button type="button" className="uat-btn is-danger is-wide" disabled={status !== 'running'} onClick={() => fetch('/api/osm-uat/stop', { method: 'POST' })}>{xianxia ? '收陣' : '停止執行'}</button></div>
          <span className={`uat-run-status is-${status}`}><i />{statusLabel}</span>
        </>}
      </aside>

      <section className="uat-backend-results"><div className="uat-stat-grid"><Stat label={xianxia ? '試煉通過' : '通過'} value={summary.pass} tone="pass" /><Stat label={xianxia ? '待真人覆核' : '需人工'} value={summary.manual} tone="manual" /><Stat label={xianxia ? '略過' : '跳過'} value={summary.skip} tone="skip" /><Stat label={xianxia ? '陣眼失守' : '失敗'} value={summary.fail} tone="fail" /></div><section className="uat-panel uat-backend-log"><div className="uat-log-toolbar"><div className="uat-section-title"><span>{xianxia ? 'ARRAY RECORD' : 'PROCESS OUTPUT'}</span><h3>{xianxia ? '陣法行跡錄' : '即時執行日誌'}</h3></div><label className="uat-check"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />{xianxia ? '追隨靈流' : '自動捲動'}</label><button type="button" className="uat-btn is-quiet" onClick={() => setLogs([])}>{xianxia ? '拂去殘痕' : '清除'}</button></div><pre onScroll={event => { const el = event.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40) }}>{logs.length ? logs.join('\n') : (xianxia ? '玉簡未啟，靈息未至。' : '等待執行...')}<span ref={logEnd} /></pre></section></section>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <article className={`uat-stat is-${tone}`}><span>{label}</span><strong>{value}</strong></article>
}
