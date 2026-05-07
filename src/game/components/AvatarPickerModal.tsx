import { useEffect, useRef } from 'react'
import { AVATAR_OPTIONS, useAvatar } from '../hooks/useAvatar'
import type { AvatarId } from '../hooks/useAvatar'
import { DungeonIcon } from '../../components/DungeonIcon'
import Portal from '../../components/Portal'

interface Props {
  onClose: () => void
}

export function AvatarPickerModal({ onClose }: Props) {
  const { avatarId, setAvatarId } = useAvatar()
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSelect = (id: AvatarId) => {
    setAvatarId(id)
    onClose()
  }

  return (
    <Portal>
      <div
        ref={overlayRef}
        className="modal-overlay"
        onClick={e => { if (e.target === overlayRef.current) onClose() }}
        style={{ zIndex: 300 }}
      >
        <div className="modal-box avatar-picker-modal" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="modal-header">
            <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, letterSpacing: 1 }}>
              SELECT AVATAR
            </h2>
            <button type="button" className="modal-close dng-modal-close" onClick={onClose}>
              <DungeonIcon name="close" tone="slate" />
            </button>
          </div>

          {/* Grid */}
          <div className="modal-body">
            <div className="avatar-picker-modal-grid">
              {AVATAR_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`avatar-picker-modal-cell${avatarId === opt.id ? ' selected' : ''}`}
                  onClick={() => handleSelect(opt.id)}
                  title={`${opt.label} (${opt.gender})`}
                >
                  <img
                    src={opt.src}
                    style={{ width: '100%', height: '100%', imageRendering: 'pixelated', objectFit: 'cover', display: 'block' }}
                    onError={e => { (e.target as HTMLImageElement).style.opacity = '0.2' }}
                    alt={opt.label}
                  />
                  <div className="avatar-picker-modal-label">{opt.label}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}
