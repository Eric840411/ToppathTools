import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** PageHead 右側放頁面操作按鈕的位置（原型 v7：重新讀取、新增、開始測試…都在標題那一列右邊） */
export const PAGE_ACTIONS_ID = 'rd-page-actions'

/**
 * 把頁面的主要操作按鈕搬到頁首右側。按鈕還是這一頁的元件、狀態與事件都不變，只是畫在別的位置（portal）。
 * 找不到頁首（GameApp 等沒有 PageHead 的外框）就原地畫，行為跟原本一樣。
 * 一頁只放一組：同時有兩個 PageActions 會兩組並排。
 */
export function PageActions({ children, className }: { children: ReactNode; className?: string }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // layout effect：在第一次畫面出現前就換到頁首，不會先閃一下原地
  useLayoutEffect(() => { setSlot(document.getElementById(PAGE_ACTIONS_ID)) }, [])
  if (!slot) return <div className={className}>{children}</div>
  return createPortal(children, slot)
}
