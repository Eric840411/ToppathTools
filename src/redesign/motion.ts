import { useEffect, useState } from 'react'

/**
 * 「要不要減少動態」的單一來源：頂列動畫開關（html.rd-no-motion）或系統的 prefers-reduced-motion。
 * CSS 停得掉 CSS 動畫，停不掉動態 WebP 與 JS 逐幀更新——那些元件要讀這裡自己換靜態圖、停止更新
 * （CodeX 審 ea86844 [P2]：排行榜境界圖與突破特效原本只看系統設定，關掉開關仍在動）。
 */
export function motionReduced(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('rd-no-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useMotionReduced(): boolean {
  const [reduced, setReduced] = useState(motionReduced)
  useEffect(() => {
    const update = () => setReduced(motionReduced())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    mq.addEventListener('change', update)
    return () => { mo.disconnect(); mq.removeEventListener('change', update) }
  }, [])
  return reduced
}
