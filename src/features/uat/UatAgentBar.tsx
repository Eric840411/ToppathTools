import { useCallback, useEffect, useRef, useState } from 'react'
import type { UatMainTab, UatThemeMode } from './types'
import { CAP_FOR_TAB, deriveAgentBarView } from './agent-bar-state'

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

export function UatAgentBar({ tab, themeMode }: { tab: UatMainTab; themeMode: UatThemeMode }) {
  const xianxia = themeMode === 'xianxia'
  const copy = xianxia
    ? { title: '外派傀儡', unit: '尊', usable: '可差遣', busy: '閉關中', loading: '感應中…', reload: '重新感應',
        none: '尚無外派傀儡聽令', anon: '查不到你的身分，請重新登入', fail: '感應失敗' }
    : { title: 'Local Agent', unit: '台', usable: '可派工', busy: '忙碌中', loading: '查詢中…', reload: '重新整理',
        none: '沒有連線中的 Local Agent', anon: '查不到你的登入身分，請重新登入', fail: '查詢失敗' }

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
              <span key={agent.agentId} className={capState?.usable ? 'uat-agent-chip is-usable' : 'uat-agent-chip'}>
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

      <div className="uat-agent-actions">
        <button type="button" className="uat-btn is-quiet" onClick={() => { setPhase('loading'); void load() }}>{copy.reload}</button>
      </div>
    </div>
  )
}
