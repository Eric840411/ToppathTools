import { useCallback, useEffect, useRef, useState } from 'react'
import type { UatMainTab, UatThemeMode } from './types'
import { CAP_FOR_TAB, allowsServerFallback, deriveAgentBarView, derivePickedState } from './agent-bar-state'

/**
 * 共用的 Local Agent 狀態列（v4.187.0）。
 *
 * ## 為什麼有這個
 * 在這之前，**只有 Backend 分頁看得到 Agent**，H5／PC 完全沒有；而頁首右上那顆
 * 「Runner Ready／靈脈穩定」是**寫死的字串**——一台 Agent 都沒有也照樣顯示。
 * 所以問題不是缺資訊，是**在報一個假的綠燈**。這條列把它取代掉。
 *
 * ## 三件刻意的事
 * 1. **「不能用」要比「能用」顯眼。** 假綠燈是這次要解的病，所以沒有可用 Agent 時
 *    整條變成警示框並直接講下一步，而不是縮成一顆小灰點。
 * 2. **載入中、查不到身分、查詢失敗、沒有 Agent 是四種不同狀態。**
 *    尤其**查詢失敗不能沿用上一次的綠燈**（CodeX 指定）——那等於用舊資料宣稱現在沒事。
 * 3. **可用性是 server 算的**（跟派工同一支 `agentUsability()`）。前端自己判斷的話
 *    遲早出現「畫面說可以派、按下去被擋」。
 */

type CapState = { usable: boolean; reason: string | null }

interface AgentRow {
  agentId: string
  hostname: string
  busy: boolean
  online: boolean
  updateStatus?: string
  capability: Record<string, CapState>
}

interface Overview {
  ok?: boolean
  authed?: boolean
  localRecord?: boolean
  agents?: AgentRow[]
  connected?: number
}

type Phase = 'loading' | 'ready' | 'error'

/**
 * `value` 是**這個分頁**選定的執行位置：`''` 自動、agent id、或 `'server'`（只有 Backend 有）。
 *
 * ⚠️ **選擇是每個分頁各一份，不是全域共用。** 三個分頁要的能力不同，而且「沒有 Agent 時
 *    的退路」也不同（Backend 是伺服器端 fallback、H5/PC 是本機 Chrome）——共用一份的話
 *    同一個選擇在不同分頁**意思會不一樣**。
 */
interface Props {
  tab: UatMainTab
  themeMode: UatThemeMode
  value: string
  onChange: (value: string) => void
  /** 執行中不讓人改派工目標 */
  disabled?: boolean
}

export function UatAgentBar({ tab, themeMode, value, onChange, disabled }: Props) {
  const xianxia = themeMode === 'xianxia'
  const copy = xianxia
    ? { title: '外派傀儡', unit: '尊', usable: '可差遣', busy: '閉關中', loading: '感應中…', reload: '重新感應',
        none: '尚無外派傀儡聽令', anon: '查不到你的身分，請重新登入', fail: '感應失敗',
        where: '差遣何處', auto: '自動調度', server: '本陣自理（伺服器端）',
        serverNote: '需本陣有可操持之界面' }
    : { title: 'Local Agent', unit: '台', usable: '可派工', busy: '忙碌中', loading: '查詢中…', reload: '重新整理',
        none: '沒有連線中的 Local Agent', anon: '查不到你的登入身分，請重新登入', fail: '查詢失敗',
        where: '執行位置', auto: '自動挑一台', server: '伺服器端',
        serverNote: '需要伺服器有可互動桌面' }

  const [phase, setPhase] = useState<Phase>('loading')
  const [data, setData] = useState<Overview | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/frontend-auto/agents/overview')
      if (!response.ok) throw new Error(String(response.status))
      const json = await response.json() as Overview
      setData(json)
      setPhase('ready')
    } catch {
      // ⚠️ **查詢失敗要清掉舊資料。** 留著的話畫面會繼續顯示上一次的綠燈，
      //    等於拿過期資料宣稱「現在沒問題」——那正是這條列要解的病。
      setData(null)
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    void load()
    timer.current = setInterval(() => { void load() }, 15_000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  const cap = CAP_FOR_TAB[tab]
  const agents = data?.agents ?? []
  // ⚠️ 判斷邏輯在 `agent-bar-state.ts`，跟它的測試 import 同一支——
  //    「查詢失敗不能顯示成沒事」這種事只有純函式驗得到。
  const { state, usableCount, localFallback } = deriveAgentBarView({ phase, data, tab })

  const headline =
    state === 'loading' ? copy.loading
      : state === 'error' ? copy.fail
        : state === 'anon' ? copy.anon
          : state === 'ok' ? `${copy.title} · ${usableCount} ${copy.unit}${copy.usable}`
            : state === 'warn' ? `${copy.title} · 0 ${copy.unit}${copy.usable}`
              : `${copy.title} · 0 ${copy.unit}`

  const sub =
    state === 'ok' ? `共 ${agents.length} ${copy.unit}連線 · 依目前分頁（${tab.toUpperCase()}）判定`
      : state === 'warn' ? `${agents.length} ${copy.unit}連線，但這個分頁都用不了`
        : state === 'none' ? (localFallback ? '可改用本機 Chrome 錄製' : '這個分頁需要 Local Agent')
          : state === 'error' ? '狀態未知——不代表沒問題'
            : ''

  /**
   * 選定那台的提醒。兩種都**不擋**，只講清楚：
   *   - 版本落後：不一定影響這次要跑的東西，寫「可能吃不到」不是「會失敗」
   *   - 選完之後才變忙／斷線：⚠️ **不自動換一台**——安靜地把工作送去別的地方比擋下來糟。
   *     送出時 server 會擋並講原因。
   */
  const picked = value && value !== 'server' ? agents.find(a => a.agentId === value) : undefined
  const pickedState = derivePickedState(value, { phase, data, tab })
  const pickedWarning = (() => {
    if (pickedState === 'gone') {
      // 選了一個已經不在清單上的（離線了）——這種**一定要講**，否則畫面看起來像沒選
      return `你選的 Agent 已經不在線上了。送出時會被擋下來——請改選一台，或按「${copy.reload}」。`
    }
    if (!picked) return ''
    if (pickedState === 'unusable') {
      return `你選的「${picked.hostname}」現在${picked.capability?.[cap]?.reason ?? '不可用'}。不會自動換一台，送出時會被擋下來。`
    }
    if (picked.updateStatus === 'needs_restart') {
      return '這台 agent 的檔案已是最新，但跑著的程式是更新前載入的——重開 agent 才會生效。可以照樣派工，只是可能吃不到新功能。'
    }
    if (picked.updateStatus === 'unknown') {
      return '這台 agent 沒有回報版本（多半是舊版）。建議到 Local Agent 頁更新一次並重開。可以照樣派工。'
    }
    if (picked.updateStatus === 'needs_update') {
      return '這台 agent 的程式碼落後於伺服器，可能吃不到新功能。到 Local Agent 頁按「更新程式碼」即可。可以照樣派工。'
    }
    return ''
  })()

  return (
    <div className={`uat-agent-bar is-${state}`} role="region" aria-label={copy.title}>
      <div className="uat-agent-lead">
        <i aria-hidden="true" />
        <span><strong>{headline}</strong>{sub ? <small>{sub}</small> : null}</span>
      </div>

      {state === 'ok' || state === 'warn' ? (
        <div className="uat-agent-chips">
          {agents.map(agent => {
            const capState = agent.capability?.[cap]
            return (
              <span key={agent.agentId}
                className={[
                  'uat-agent-chip',
                  capState?.usable ? 'is-usable' : '',
                  value === agent.agentId ? 'is-picked' : '',
                ].filter(Boolean).join(' ')}>
                <b>{agent.hostname}</b>
                <i className={capState?.usable ? 'is-ok' : agent.busy ? 'is-busy' : 'is-no'}>
                  {capState?.usable ? copy.usable : capState?.reason ?? copy.busy}
                </i>
              </span>
            )
          })}
        </div>
      ) : (
        <div className="uat-agent-empty">
          {state === 'loading' ? <span>{copy.loading}</span>
            : state === 'error' ? <span><b>{copy.fail}</b>：拿不到 Agent 狀態，畫面上的資訊已清空——<b>不要當成沒問題</b>。</span>
              : state === 'anon' ? <span><b>{copy.anon}</b></span>
                : <span>
                    <b>{copy.none}。</b>
                    {localFallback
                      ? '不過你是從本機開啟的，H5／PC 可以改用本機 Chrome 錄製。'
                      : '請先到 Local Agent 頁面啟動它（必須是你自己的 Agent）。'}
                  </span>}
        </div>
      )}

      <div className="uat-agent-pick">
        <label>
          <span>{copy.where}</span>
          <select className="uat-field" value={value} disabled={disabled}
            onChange={event => onChange(event.target.value)}>
            {/* ⚠️ 這裡刻意**不寫「目前 N 台可用」**——那個數字左邊那格已經在講了，
                兩個地方各講一次就會有一天對不起來。 */}
            <option value="">{copy.auto}</option>
            {agents.map(agent => (
              <option value={agent.agentId} key={agent.agentId}>
                {agent.hostname}{agent.capability?.[cap]?.usable ? '' : `（${agent.capability?.[cap]?.reason ?? '不可用'}）`}
              </option>
            ))}
            {/* ⚠️ 「伺服器端」**只有 Backend 有**。H5/PC 的非 Agent 路徑是本機 Chrome，
                而且只有從 localhost 開才有——三個分頁都放，等於做一個按了不會怎樣的選項。 */}
            {/* ⚠️ 三個分頁都有。H5/PC 的伺服器端能力本來就存在，只是原本藏在
                「你從哪個網址開的」後面。前提（伺服器要有可互動桌面）寫在下面。 */}
            {allowsServerFallback(tab) ? <option value="server">{copy.server}</option> : null}
          </select>
        </label>
        {value === 'server' ? <p className="uat-agent-note">{copy.serverNote}</p> : null}
        {pickedWarning ? <p className="uat-agent-warn">{pickedWarning}</p> : null}
      </div>

      <div className="uat-agent-actions">
        <button type="button" className="uat-btn is-quiet" onClick={() => { setPhase('loading'); void load() }}>{copy.reload}</button>
      </div>
    </div>
  )
}
