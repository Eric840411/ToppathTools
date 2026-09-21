/**
 * 「①②③ 導引」點下去要真的帶人去那個地方。
 *
 * 🚨 為什麼需要：導引原本只是文字，而提示寫的是「在右邊『執行設定』」——
 *    等於叫使用者自己在一個資訊很密的畫面裡找。第一次用的人多半找不到，
 *    而且**畫面上沒有任何東西告訴他找對了沒**。
 *
 * ⚠️ 捲過去之後一定要**高亮一下**：長頁面捲動結束時，使用者不會知道剛剛跳到哪、
 *    該看哪一塊。只捲不標等於把人丟在頁面中間。
 */
const FOCUS_CLASS = 'is-uat-focus'
/** 高亮多久。太短看不到，太長會被當成「這塊壞了」 */
const FOCUS_MS = 1800

export function focusPanel(id: string) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove(FOCUS_CLASS)
  // 強制重繪，否則同一個目標連點兩次不會再播一次動畫
  void el.offsetWidth
  el.classList.add(FOCUS_CLASS)
  window.setTimeout(() => el.classList.remove(FOCUS_CLASS), FOCUS_MS)
  // 輸入框就順手聚焦——導引指的多半就是「這格還沒填」
  const field = el.matches('input, textarea, select')
    ? el as HTMLElement
    : el.querySelector<HTMLElement>('input, textarea, select')
  if (field) field.focus({ preventScroll: true })
}
