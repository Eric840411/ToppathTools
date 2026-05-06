import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useGameProfileCtx } from '../context/GameProfileContext'
import { CHARACTER_CLASSES, STAT_LABELS, STAT_ICONS, type CharacterClass } from '../hooks/useGameProfile'
import { CharacterSprite } from './CharacterSprite'

interface Props {
  onClose: () => void
}

const CLASS_ORDER: CharacterClass[] = ['commander', 'hacker', 'guardian', 'ranger', 'sage']

function ClassSelectContent({ onClose }: Props) {
  const { selectClass, classId } = useGameProfileCtx()
  const [hovered, setHovered] = useState<CharacterClass | null>(null)
  const [selected, setSelected] = useState<CharacterClass | null>(null)

  if (classId) { onClose(); return null }

  const preview = hovered ?? selected ?? 'commander'
  const previewDef = CHARACTER_CLASSES[preview]

  const handleConfirm = () => {
    if (!selected) return
    selectClass(selected)
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(2,6,16,0.95)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '16px',
    }}>
      <div style={{
        width: 'min(900px, 96vw)',
        maxHeight: '92vh',
        background: 'linear-gradient(180deg, rgba(6,14,32,0.99), rgba(3,8,20,0.99))',
        border: '2px solid var(--border-bright)',
        boxShadow: '0 0 60px rgba(0,212,255,0.15)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Title */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-dim)',
          background: 'rgba(0,0,0,0.45)',
          textAlign: 'center',
          flexShrink: 0,
        }}>
          <div style={{
            fontFamily: 'var(--font-pixel)', fontSize: 18,
            color: 'var(--neon-gold)', textShadow: 'var(--glow-gold)', letterSpacing: 3,
          }}>
            ⭐ CHOOSE YOUR CLASS ⭐
          </div>
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 9, color: 'var(--text-dim)', marginTop: 5, letterSpacing: 1 }}>
            此選擇永久生效 — 影響技能、XP 加成與職業成長
          </div>
        </div>

        {/* Cards row */}
        <div style={{
          display: 'flex',
          gap: 10,
          padding: '16px 16px 10px',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          {CLASS_ORDER.map(cls => {
            const def = CHARACTER_CLASSES[cls]
            const isSelected = selected === cls
            const isHover = hovered === cls
            const isActive = isSelected || isHover

            return (
              <div
                key={cls}
                onMouseEnter={() => setHovered(cls)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => setSelected(cls)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: isSelected
                    ? `${def.color}18`
                    : isHover
                    ? `${def.color}0c`
                    : 'rgba(4,10,24,0.85)',
                  border: `2px solid ${isActive ? def.color : 'var(--border-mid)'}`,
                  boxShadow: isSelected
                    ? `0 0 24px ${def.color}55`
                    : isHover
                    ? `0 0 12px ${def.color}33`
                    : 'none',
                  padding: '12px 8px 10px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 100ms steps(3)',
                  userSelect: 'none',
                  position: 'relative',
                }}
              >
                {/* Selected checkmark */}
                {isSelected && (
                  <div style={{
                    position: 'absolute', top: 4, right: 6,
                    fontFamily: 'var(--font-pixel)', fontSize: 10,
                    color: def.color,
                  }}>✓</div>
                )}

                {/* Sprite */}
                <CharacterSprite
                  characterClass={cls}
                  state={isActive ? 'celebrate' : 'idle'}
                  size={72}
                  showLabel={false}
                />

                {/* Class name */}
                <div style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 11,
                  color: def.color,
                  textShadow: isActive ? `0 0 10px ${def.color}` : 'none',
                  letterSpacing: 1,
                  textAlign: 'center',
                }}>
                  {def.name}
                </div>
                <div style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 9,
                  color: 'var(--text-primary)',
                  textAlign: 'center',
                }}>
                  {def.nameZh}
                </div>

                {/* Stat bars */}
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(Object.entries(def.baseStats) as [keyof typeof def.baseStats, number][]).map(([stat, val]) => (
                    <div key={stat} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 10, width: 14, textAlign: 'center', lineHeight: 1, flexShrink: 0 }}>
                        {STAT_ICONS[stat]}
                      </span>
                      <span style={{
                        fontFamily: 'var(--font-pixel)', fontSize: 7,
                        color: 'var(--text-dim)', width: 20, flexShrink: 0,
                      }}>
                        {STAT_LABELS[stat]}
                      </span>
                      <div style={{
                        flex: 1, height: 5,
                        background: 'rgba(0,0,0,0.5)',
                        border: '1px solid var(--border-dim)',
                      }}>
                        <div style={{
                          width: `${(val / 4) * 100}%`,
                          height: '100%',
                          background: def.color,
                          boxShadow: val > 0 ? `0 0 3px ${def.color}` : 'none',
                        }} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* XP badge */}
                <div style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 9,
                  color: 'var(--neon-gold)',
                  background: 'rgba(255,215,0,0.08)',
                  border: '1px solid rgba(255,215,0,0.3)',
                  padding: '3px 10px',
                }}>
                  XP ×{def.xpBonus}
                </div>
              </div>
            )
          })}
        </div>

        {/* Description panel */}
        <div style={{
          margin: '0 16px',
          padding: '12px 16px',
          background: `${previewDef.color}0a`,
          border: `1px solid ${previewDef.color}44`,
          display: 'flex',
          gap: 24,
          flexShrink: 0,
        }}>
          {/* Left: desc */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: 'var(--font-pixel)', fontSize: 13,
              color: previewDef.color,
              textShadow: `0 0 8px ${previewDef.color}`,
              marginBottom: 6,
            }}>
              {previewDef.name} — {previewDef.nameZh}
            </div>
            <div style={{
              fontFamily: 'var(--font-pixel)', fontSize: 10,
              color: 'var(--text-primary)',
              lineHeight: 1.6,
            }}>
              {previewDef.desc}
            </div>
          </div>

          {/* Right: skills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignContent: 'flex-start' }}>
            {previewDef.skills.map(skill => (
              <div key={skill.id} style={{
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid var(--border-mid)',
                padding: '6px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                minWidth: 140,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14 }}>{skill.icon}</span>
                  <span style={{
                    fontFamily: 'var(--font-pixel)', fontSize: 10,
                    color: previewDef.color,
                  }}>
                    {skill.nameZh}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-pixel)', fontSize: 8,
                    color: 'var(--text-dim)',
                    marginLeft: 'auto',
                  }}>
                    Lv.{skill.unlockLevel}
                  </span>
                </div>
                <div style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 8,
                  color: 'var(--text-dim)',
                  lineHeight: 1.5,
                }}>
                  {skill.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer: confirm */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border-dim)',
          background: 'rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          flexShrink: 0,
        }}>
          {selected ? (
            <>
              <button
                type="button"
                onClick={handleConfirm}
                style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 12,
                  color: '#000',
                  background: CHARACTER_CLASSES[selected].color,
                  border: 'none',
                  padding: '10px 32px',
                  cursor: 'pointer',
                  letterSpacing: 1,
                  boxShadow: `0 0 16px ${CHARACTER_CLASSES[selected].color}`,
                }}
              >
                ✓ CONFIRM {CHARACTER_CLASSES[selected].name}
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 10,
                  color: 'var(--text-dim)',
                  background: 'transparent',
                  border: '1px solid var(--border-dim)',
                  padding: '9px 20px',
                  cursor: 'pointer',
                }}
              >
                BACK
              </button>
            </>
          ) : (
            <div style={{
              fontFamily: 'var(--font-pixel)', fontSize: 10,
              color: 'var(--text-dim)',
            }}>
              ← 點擊上方職業卡片選擇，懸停可預覽技能
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ClassSelectModal({ onClose }: Props) {
  return createPortal(<ClassSelectContent onClose={onClose} />, document.body)
}
