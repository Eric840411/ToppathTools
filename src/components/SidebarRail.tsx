import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * 側欄收放（v5.3.0，使用者在 Lark 確認樣稿、CodeX 對過行為）。
 *
 * - 收起狀態存 localStorage；**沒存過才看當下寬度**（< 1100px＝嵌在 Lark 這種窄視窗 → 預設收起）。
 *   每次載入只決定一次，之後視窗變寬變窄都不自動切；只有使用者手動收放才寫入。
 * - 收起時：滑過／focus 主頁籤顯示名稱（SidebarTooltip）；有子頁籤的點了在旁邊彈出（SidebarFlyout）。
 * - 提示與彈出選單一律 createPortal 掛 body：側欄祖先有 overflow／backdrop-filter，掛在裡面會被裁掉（CLAUDE.md 踩坑 #7）。
 */
const STORAGE_KEY = 'toppath-sidebar-collapsed'
const NARROW_PX = 1100

export function initialSidebarCollapsed(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* 隱私模式／被封鎖：照寬度決定，頁面不能因此壞掉 */ }
  return typeof window !== 'undefined' && window.innerWidth < NARROW_PX
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(initialSidebarCollapsed)
  const toggle = useCallback(() => {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0') } catch { /* 存不了就只在這次有效 */ }
      return next
    })
  }, [])
  return [collapsed, toggle]
}

/**
 * 視窗 ≤ 680px（手機／很窄的 Lark 面板）時一律用圖示列，不管使用者選什麼。
 * 修仙版 CSS 在這個寬度本來就會把側欄壓成 68px、隱藏所有文字；交給狀態控制，提示與子選單才會跟著正確運作（CodeX review）。
 */
const TINY_QUERY = '(max-width: 680px)'
export function useTinyViewport(): boolean {
  const [tiny, setTiny] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(TINY_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(TINY_QUERY)
    if (!mq) return
    const on = () => setTiny(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return tiny
}

/** 從側欄按鈕本身讀名稱（主名稱＋修仙版的原功能名），不另外維護一份文字清單 */
function readLabel(el: HTMLElement): { main: string; sub: string } | null {
  const theme = el.querySelector('.sidebar-nav-label-theme')?.textContent?.trim()
  const sub = el.querySelector('.sidebar-nav-label-sub')?.textContent?.trim() ?? ''
  if (theme) return { main: theme, sub }
  const plain = el.querySelector('.sidebar-nav-label')?.textContent?.trim() || el.getAttribute('aria-label') || sub
  return plain ? { main: plain, sub: '' } : null
}

const TIP_TARGETS = '.sidebar-nav-item, .sidebar-ai-btn, .sidebar-collapse-btn'

/** 收起時滑過／focus 側欄按鈕顯示名稱。用事件委派掛在側欄上，不用每顆按鈕各自接。 */
export function SidebarTooltip({ sidebarRef, enabled, suppressed }: { sidebarRef: RefObject<HTMLElement | null>; enabled: boolean; suppressed: boolean }) {
  const [tip, setTip] = useState<{ main: string; sub: string; extra: string; top: number; left: number } | null>(null)
  useEffect(() => {
    const root = sidebarRef.current
    if (!root || !enabled) { setTip(null); return }
    const show = (e: Event) => {
      const el = (e.target as HTMLElement).closest(TIP_TARGETS) as HTMLElement | null
      if (!el || !root.contains(el)) return
      const label = readLabel(el)
      if (!label) return
      const r = el.getBoundingClientRect()
      setTip({ ...label, extra: el.getAttribute('aria-haspopup') ? '點開子頁籤' : '', top: r.top + r.height / 2, left: r.right + 8 })
    }
    const hide = (e: Event) => {
      const to = (e as MouseEvent | FocusEvent).relatedTarget as Node | null
      const from = (e.target as HTMLElement).closest(TIP_TARGETS)
      if (from && to && from.contains(to)) return
      setTip(null)
    }
    const clear = () => setTip(null)
    root.addEventListener('mouseover', show)
    root.addEventListener('focusin', show)
    root.addEventListener('mouseout', hide)
    root.addEventListener('focusout', hide)
    root.addEventListener('scroll', clear, true)
    return () => {
      root.removeEventListener('mouseover', show)
      root.removeEventListener('focusin', show)
      root.removeEventListener('mouseout', hide)
      root.removeEventListener('focusout', hide)
      root.removeEventListener('scroll', clear, true)
    }
  }, [sidebarRef, enabled])
  if (!tip || !enabled || suppressed) return null
  return createPortal(
    <div className="sb-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
      <span className="sb-tip-main">{tip.main}</span>
      {tip.sub && <span className="sb-tip-sub">{tip.sub}</span>}
      {tip.extra && <span className="sb-tip-sub">・{tip.extra}</span>}
    </div>,
    document.body,
  )
}

/**
 * 收起時有子頁籤的主頁籤點了，在旁邊彈出子選單。
 * 關閉：選完、再點同一顆、點外面（不含觸發按鈕與選單本身）、Esc（焦點還給觸發按鈕）、側欄捲動、視窗 resize。
 * 選單本身捲動不關。開啟時焦點移到第一項，Tab 可在子項間移動。
 */
export function SidebarFlyout({ anchor, title, onClose, children }: { anchor: HTMLElement; title: ReactNode; onClose: (restoreFocus: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 0
    // 限制在可視範圍內（嵌在 Lark 的 iframe 裡高度有限）：太靠下就往上推
    const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - h - 8))
    setPos({ top, left: r.right + 8 })
  }, [anchor])

  // 焦點要等定好位置才移：量尺寸那一刻是 visibility:hidden，對隱藏元素 focus() 會被瀏覽器忽略。
  // ⚠️ 呼叫端要用 key={groupId}：選單沒關就換另一組時，元件沿用的話 placed 一直是 true、焦點不會移過去
  const placed = pos !== null
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('button')?.focus()
  }, [placed])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(true) } }
    const onResize = () => onClose(false)
    // 側欄捲動要關（位置會對不上），選單自己捲動不關
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div ref={ref} className="sb-flyout" role="menu" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
      <div className="sb-flyout-title">{title}</div>
      {children}
    </div>,
    document.body,
  )
}
