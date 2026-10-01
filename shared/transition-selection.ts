/**
 * 批量更新狀態：選項重讀之後「目標該留還是清」、以及「現在能不能送出」的判斷（純函式，測試直接打這裡）。
 *
 * CodeX review a9d923c 抓到：重讀失敗時只清了選項、沒清目標——先選了目標、再換首張，重讀一直失敗的話，
 * 畫面寫「讀取失敗，可跳過」，執行卻仍送出舊目標；新單剛好有合法路徑就真的會切。
 * 原則：**畫面上看不到的目標，一律不能送。**
 */

export type ReloadOutcome = { ok: true; transitions: { toId?: string }[] } | { ok: false }

/** 重讀完成後目標要變成什麼：成功且新選項裡有 → 保留；其餘（失敗、不在新選項裡）→ 不切換 */
export function targetAfterReload(prevTarget: string, outcome: ReloadOutcome): string {
  if (!prevTarget) return ''
  if (!outcome.ok) return ''
  return outcome.transitions.some(t => t.toId === prevTarget) ? prevTarget : ''
}

export type TransitionOpt = { id: string; name: string; toId?: string; toName?: string }

/**
 * 「依目前勾選的第一張重讀選項」的 effect 本體，抽出來是為了能測生命週期（CodeX review 8ec8730）。
 * 回傳 cleanup——呼叫端（React useEffect）在依賴變動時先呼叫它、再跑下一次。
 *
 * ⚠️ 每一條提前 return 都要重設 loading：A 讀好 → 切到 B（開始讀、loading=true）→ B 回來前又切回 A：
 *    B 的 cleanup 讓它的回應作廢，A 因為「來源相同」直接 return——原本沒人把 loading 改回 false，之後永遠被擋。
 */
export function startTransitionReload(
  input: { firstKey: string; email: string | undefined; sourceKey: string },
  fetchTransitions: (key: string, email: string) => Promise<{ ok: boolean; transitions?: TransitionOpt[] }>,
  set: {
    transitions: (list: TransitionOpt[]) => void
    sourceKey: (key: string) => void
    target: (update: (prev: string) => string) => void
    loading: (on: boolean) => void
  },
): () => void {
  const { firstKey, email, sourceKey } = input
  if (!firstKey || !email) {
    set.transitions([]); set.sourceKey(''); set.target(() => ''); set.loading(false)
    return () => {}
  }
  if (firstKey === sourceKey) {
    set.loading(false)   // 選項本來就是這張讀的，不用重讀——但上一輪可能留下 loading=true
    return () => {}
  }
  let alive = true
  set.loading(true)
  fetchTransitions(firstKey, email)
    .then(d => {
      if (!alive) return
      const list = d.ok ? (d.transitions ?? []) : []
      set.transitions(list)
      set.sourceKey(d.ok ? firstKey : '')
      set.target(prev => targetAfterReload(prev, d.ok ? { ok: true, transitions: list } : { ok: false }))
    })
    .catch(() => {
      if (!alive) return
      set.transitions([]); set.sourceKey('')
      set.target(prev => targetAfterReload(prev, { ok: false }))
    })
    .finally(() => { if (alive) set.loading(false) })
  return () => { alive = false; set.loading(false) }
}

/**
 * 能不能送出目前選的目標。不切換（空字串）永遠可以；選了目標的話，選項必須是**依目前勾選的第一張讀完的**——
 * 還在重讀、或選項是從別張單讀的，都代表這個目標還沒被確認過。
 */
export function submitBlockReason(s: { target: string; firstSelectedKey: string; sourceKey: string; loading: boolean }): string | null {
  if (!s.target) return null
  if (s.loading) return '狀態選項還在讀取中，請稍候再執行'
  if (s.sourceKey !== s.firstSelectedKey) return '勾選的單已經變了，狀態選項還沒重新讀取完成，請確認選項後再執行'
  return null
}
