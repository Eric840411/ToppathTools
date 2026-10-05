import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MEEGLE_SPACES, meegleSpaceLabel, type MeegleSpace } from '../../shared/meegle-space'
import './MeegleSpace.css'

/**
 * Meegle 雙空間的前端零件（v5.10.0，規則 CodeX 拍板 2026-10-05）：
 * - MeegleSpaceBar：每個分頁上方的「測試／正式」切換。送出中不能切
 * - useProdConfirm：送到正式之前跳一次確認（列出空間、操作、Sheet、筆數）；測試不跳、單純切換也不跳
 * - OtherSpaceNotice：這份 Sheet 已經在另一個空間送過 → 讀 Sheet 時就提示（送出時伺服器也會擋）
 */

export function MeegleSpaceBar({ space, onChange, disabled }: { space: MeegleSpace; onChange: (s: MeegleSpace) => void; disabled?: boolean }) {
  return (
    <div className="msp-bar" role="radiogroup" aria-label="Meegle 空間">
      <span className="msp-bar-label">Meegle 空間</span>
      <div className="msp-seg">
        {MEEGLE_SPACES.map(s => (
          <button key={s.key} type="button" role="radio" aria-checked={space === s.key} disabled={disabled}
            className={`msp-seg-btn${space === s.key ? ' is-on' : ''} msp-seg-btn--${s.key}`}
            onClick={() => { if (s.key !== space) onChange(s.key) }}>{s.label}</button>
        ))}
      </div>
      <span className="msp-bar-hint">
        {disabled ? '送出中，不能切換空間' : space === 'prod' ? '目前會開到正式空間，送出前會再確認一次' : '切換空間會清掉這一頁讀到的內容，要重新讀取 Sheet'}
      </span>
    </div>
  )
}

export function OtherSpaceNotice({ other, space }: { other: MeegleSpace | null | undefined; space: MeegleSpace }) {
  if (!other) return null
  return (
    <div className="mb-alert mb-alert--bad" role="alert">
      這份 Sheet 已經在「{meegleSpaceLabel(other)}」空間送過，不能再送到「{meegleSpaceLabel(space)}」。同一份 Sheet 只能用一個空間，請確認是不是切錯了。
    </div>
  )
}

type Ask = { op: string; sheet: string; count: number }

/** 正式空間送出前確認。回傳 [確認函式, 要放進畫面的彈窗]。測試空間直接回 true */
export function useProdConfirm(space: MeegleSpace): [(a: Ask) => Promise<boolean>, React.ReactNode] {
  const [ask, setAsk] = useState<Ask | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const confirm = (a: Ask) => {
    if (space !== 'prod') return Promise.resolve(true)
    return new Promise<boolean>(resolve => { resolver.current = resolve; setAsk(a) })
  }
  const done = (ok: boolean) => { resolver.current?.(ok); resolver.current = null; setAsk(null) }
  // 彈窗掛在 body：祖先有 backdrop-filter，position: fixed 會被困在容器裡（CLAUDE.md 跨功能踩坑 #7）
  const modal = ask && createPortal(
    <div className="msp-modal-back" onClick={() => done(false)}>
      <div className="msp-modal" role="dialog" aria-modal="true" aria-labelledby="msp-modal-title" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') done(false) }}>
        <h3 id="msp-modal-title" className="msp-modal-title">確認送到正式空間</h3>
        <dl className="msp-modal-list">
          <dt>空間</dt><dd><span className="msp-tag msp-tag--prod">正式</span></dd>
          <dt>操作</dt><dd>{ask.op}</dd>
          <dt>Sheet</dt><dd className="msp-modal-sheet">{ask.sheet || '—'}</dd>
          <dt>筆數</dt><dd>{ask.count} 筆</dd>
        </dl>
        <p className="msp-modal-note">送出後會直接改到正式空間的單，不能復原。</p>
        <div className="msp-modal-actions">
          <button type="button" className="mb-btn" onClick={() => done(false)}>取消</button>
          <button type="button" className="mb-btn mb-btn--primary msp-btn-prod" autoFocus onClick={() => done(true)}>確認送出 {ask.count} 筆</button>
        </div>
      </div>
    </div>,
    document.body,
  )
  return [confirm, modal]
}

export function SpaceTag({ space }: { space: MeegleSpace }) {
  return <span className={`msp-tag msp-tag--${space}`}>{meegleSpaceLabel(space)}</span>
}
