import { useState, useEffect } from 'react'
import { useGameProfileCtx } from '../context/GameProfileContext'
import { CHARACTER_CLASSES } from '../hooks/useGameProfile'

function formatCooldown(ms: number): string {
  if (ms <= 0) return ''
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.ceil(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.ceil(m / 60)}h`
}

export function SkillBar() {
  const { classId, level, skillCooldowns, activateSkill } = useGameProfileCtx()
  const [, setTick] = useState(0)

  // Tick every second to update cooldown timers
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!classId) return null
  const classDef = CHARACTER_CLASSES[classId]

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 6 }}>
      {classDef.skills.map(skill => {
        const now = Date.now()
        const readyAt = skillCooldowns[skill.id] ?? 0
        const onCooldown = readyAt > now
        const remainingMs = onCooldown ? readyAt - now : 0
        const locked = level < skill.unlockLevel

        return (
          <button
            key={skill.id}
            type="button"
            title={locked
              ? `${skill.nameZh} — Lv.${skill.unlockLevel} 解鎖`
              : onCooldown
              ? `${skill.nameZh} — ${formatCooldown(remainingMs)}`
              : `${skill.nameZh}: ${skill.desc}`
            }
            onClick={() => {
              if (!locked && !onCooldown) activateSkill(skill.id)
            }}
            style={{
              position: 'relative',
              width: 36, height: 36,
              background: locked
                ? 'rgba(8,18,36,0.9)'
                : onCooldown
                ? 'rgba(20,30,60,0.9)'
                : 'rgba(0,20,40,0.95)',
              border: `1px solid ${locked ? 'var(--border-dim)' : onCooldown ? 'var(--border-mid)' : classDef.color}`,
              boxShadow: !locked && !onCooldown ? `0 0 6px ${classDef.color}44` : 'none',
              cursor: locked || onCooldown ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 1,
              transition: 'all 80ms steps(2)',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {/* Icon */}
            <span style={{
              fontSize: 14,
              opacity: locked || onCooldown ? 0.35 : 1,
              lineHeight: 1,
              filter: !locked && !onCooldown ? `drop-shadow(0 0 4px ${classDef.color})` : 'none',
            }}>
              {locked ? '🔒' : skill.icon}
            </span>

            {/* Cooldown or level label */}
            <span style={{
              fontFamily: 'var(--font-pixel)',
              fontSize: 6,
              color: locked ? 'var(--text-dim)' : onCooldown ? 'var(--neon-cyan)' : classDef.color,
              lineHeight: 1,
              textAlign: 'center',
            }}>
              {locked ? `Lv.${skill.unlockLevel}` : onCooldown ? formatCooldown(remainingMs) : skill.nameZh}
            </span>

            {/* Cooldown overlay bar */}
            {onCooldown && !locked && (
              <div style={{
                position: 'absolute',
                bottom: 0, left: 0, right: 0,
                height: 3,
                background: 'var(--border-dim)',
              }}>
                <div style={{
                  height: '100%',
                  width: `${(remainingMs / (classDef.skills.find(s => s.id === skill.id)?.cooldownMs ?? 1)) * 100}%`,
                  background: 'var(--neon-cyan)',
                  boxShadow: 'var(--glow-cyan)',
                  transition: 'width 1s linear',
                }} />
              </div>
            )}

            {/* Ready pulse for available skills */}
            {!locked && !onCooldown && (
              <div style={{
                position: 'absolute',
                inset: 0,
                border: `1px solid ${classDef.color}`,
                opacity: 0,
                animation: 'px-pulse 2s steps(2) infinite',
                pointerEvents: 'none',
              }} />
            )}
          </button>
        )
      })}
    </div>
  )
}
