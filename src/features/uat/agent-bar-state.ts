/**
 * src/features/uat/agent-bar-state.ts
 *
 * 共用 Agent 狀態列要顯示哪一種狀態。
 *
 * ## 為什麼抽出來
 * 這條列要解的病是**假綠燈**（原本頁首那顆「Runner Ready」是寫死的字串）。
 * 所以真正重要的不是「有 Agent 時長什麼樣」，而是**沒有／查不到／查失敗時不會顯示成沒事**。
 * 那幾種情況寫在元件裡只驗得到 JSX 長相；抽成純函式才驗得到判斷本身。
 *
 * ⚠️ 元件與測試 **import 同一支**——測試裡重寫一份規則就是在驗自己。
 */
import type { UatMainTab } from './types'

export type AgentBarState = 'loading' | 'error' | 'anon' | 'ok' | 'warn' | 'none'

export interface AgentBarInput {
  /** 這一輪查詢的結果：還在查／查到了／查失敗 */
  phase: 'loading' | 'ready' | 'error'
  /**
   * 後端回的資料。
   * ⚠️ **查詢失敗時必須是 null。** 留著上一次的資料等於拿過期狀態宣稱「現在沒問題」，
   *    那正是這條列要解的病（CodeX 2026-09-18 指定：失敗不能沿用綠燈）。
   */
  data: { authed?: boolean; localRecord?: boolean; agents?: Array<{ agentId?: string; capability?: Record<string, { usable: boolean }> }> } | null
  tab: UatMainTab
}

/** 每個分頁需要哪個能力。⚠️ 跟後端 `UatCapability` 是同一組字串 */
export const CAP_FOR_TAB: Record<UatMainTab, string> = {
  backend: 'backend-uat',
  h5: 'uat-record',
  pc: 'uat-record',
}

export interface AgentBarView {
  state: AgentBarState
  /** 對**目前這個分頁**可用的台數 */
  usableCount: number
  /** 自己的、有連線的總台數 */
  totalCount: number
  /**
   * 沒有 Agent 時，這個分頁還有沒有別條路可走。
   * ⚠️ 本機 Chrome 只救得了 H5/PC 的錄製，**救不了 Backend**——不能一概說「還可以用」。
   */
  localFallback: boolean
}

/**
 * 「伺服器端（fallback）」這個選項該不該出現。
 *
 * ⚠️ **只有 Backend 有。** H5/PC 的非 Agent 路徑是本機 Chrome，而且只有從 localhost
 *    開才有——三個分頁都放，等於做一個在兩個分頁按了不會怎樣的選項。
 */
export function allowsServerFallback(tab: UatMainTab): boolean {
  return tab === 'backend'
}

/**
 * 選定的那台現在怎麼樣。回傳給畫面顯示用。
 *
 * ⚠️ **不自動換一台。** 選完之後才變忙／斷線時，安靜地把工作送去別的地方，
 *    比擋下來糟得多——使用者會對著「成功」的畫面找不到自己指名那台在跑什麼。
 */
export type PickedState = 'none' | 'server' | 'ok' | 'unusable' | 'gone'

export function derivePickedState(
  value: string,
  input: AgentBarInput,
): PickedState {
  if (!value) return 'none'
  if (value === 'server') return 'server'
  // 還在查／查失敗時不下結論——那時 agents 是空的，說「不在線上」是把不知道講成知道
  if (input.phase !== 'ready') return 'none'
  const found = (input.data?.agents ?? []).find(a => (a as { agentId?: string }).agentId === value)
  if (!found) return 'gone'
  return found.capability?.[CAP_FOR_TAB[input.tab]]?.usable ? 'ok' : 'unusable'
}

export function deriveAgentBarView(input: AgentBarInput): AgentBarView {
  const cap = CAP_FOR_TAB[input.tab]
  const agents = input.data?.agents ?? []
  const usableCount = agents.filter(a => a.capability?.[cap]?.usable).length
  const localFallback = !!input.data?.localRecord && input.tab !== 'backend'

  // ⚠️ 順序就是優先權，而且**查詢失敗排在很前面**：
  //    先看有沒有 Agent 的話，失敗時 agents 是空的 → 會被顯示成「沒有 Agent」，
  //    那是把「我不知道」講成「我知道沒有」。
  const state: AgentBarState =
    input.phase === 'loading' ? 'loading'
      : input.phase === 'error' ? 'error'
        : input.data?.authed === false ? 'anon'
          : usableCount > 0 ? 'ok'
            : agents.length > 0 ? 'warn'
              : 'none'

  return { state, usableCount, totalCount: agents.length, localFallback }
}
