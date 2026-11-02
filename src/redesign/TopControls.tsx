import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type ThemeMode = 'classic' | 'xianxia'

/**
 * 新版頂列右側：動畫開關（iOS 26 液態玻璃開關）＋版本切換（玻璃分段控制）。
 * 原型 v7 定稿（使用者 1102 確認）。原本放在側欄底部的「版面模式」移到這裡。
 *
 * 動效：
 * - 按住時滑塊變成透明玻璃透鏡（.is-lens），放開後滑過去、回彈、縮回實心（.is-squish 每次切換播一次）
 * - 動畫關掉或系統「減少動態」時，CSS 統一不播（見 redesign.css 的 .rd-no-motion）
 */
export function TopControls({ themeMode, onThemeChange, motionOn, onMotionChange }: {
  themeMode: ThemeMode
  onThemeChange: (m: ThemeMode) => void
  motionOn: boolean
  onMotionChange: (on: boolean) => void
}) {
  const segRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const btnRefs = useRef<Record<ThemeMode, HTMLButtonElement | null>>({ classic: null, xianxia: null })
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  const [squish, setSquish] = useState(0)

  // 滑塊位置跟著選中的那顆按鈕（字寬兩版不同，不能寫死）
  useLayoutEffect(() => {
    const place = () => {
      const b = btnRefs.current[themeMode]
      if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [themeMode])

  // 重播一次性的回彈與反光：拿掉 class、強制 reflow、再加回去。
  // 不用 key 重掛滑塊——重掛的元素直接出現在終點，滑過去的過場就沒了
  useEffect(() => {
    if (!squish) return
    for (const [el, cls] of [[thumbRef.current, 'is-squish'], [segRef.current, 'is-sweep']] as const) {
      if (!el) continue
      el.classList.remove(cls)
      void el.offsetWidth
      el.classList.add(cls)
    }
  }, [squish])

  // 透鏡狀態也直接改 classList，不走 state：className 一重算就會把正在播的 is-squish 洗掉
  const setLens = (on: boolean) => thumbRef.current?.classList.toggle('is-lens', on)

  function pick(m: ThemeMode) {
    if (m !== themeMode) setSquish(n => n + 1)
    onThemeChange(m)
  }

  return (
    <div className="rd-top-controls">
      <label className="rd-switch" title="關掉會停止所有裝飾動畫（也會跟著系統的「減少動態」設定）">
        <input type="checkbox" checked={motionOn} onChange={e => onMotionChange(e.target.checked)} />
        <span>動畫</span>
      </label>
      <div
        className="rd-seg"
        role="group"
        aria-label="版本切換"
        ref={segRef}
        onPointerDown={e => { if ((e.target as HTMLElement).closest('button')) setLens(true) }}
        onPointerUp={() => window.setTimeout(() => setLens(false), 160)}
        onPointerLeave={() => setLens(false)}
        onPointerCancel={() => setLens(false)}
      >
        {thumb && (
          <span
            ref={thumbRef}
            className="rd-seg-thumb"
            style={{ width: thumb.w, transform: `translateX(${thumb.x - 3}px)` }}
            aria-hidden="true"
          />
        )}
        <button type="button" ref={el => { btnRefs.current.classic = el }} aria-pressed={themeMode === 'classic'} onClick={() => pick('classic')}>普通版</button>
        <button type="button" ref={el => { btnRefs.current.xianxia = el }} aria-pressed={themeMode === 'xianxia'} onClick={() => pick('xianxia')}>仙俠版</button>
      </div>
    </div>
  )
}
