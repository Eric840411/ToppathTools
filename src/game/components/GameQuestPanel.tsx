import { useState } from 'react'
import { useGameProfileCtx } from '../context/GameProfileContext'
import { ACHIEVEMENTS } from '../hooks/useGameProfile'
import { DungeonIcon } from '../../components/DungeonIcon'

export function GameQuestPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'quests' | 'achievements'>('quests')
  const { todayQuests, questProgress, questsClaimed, achievements, level, xp, xpPct, xpCurrent, xpNeeded } = useGameProfileCtx()

  return (
    <>
      {/* Floating trigger button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="任務 & 成就"
        style={{
          position: 'fixed',
          bottom: 72,
          right: 20,
          zIndex: 99997,
          width: 44,
          height: 44,
          background: open ? '#ffd70022' : 'rgba(2,6,16,0.9)',
          border: `2px solid ${open ? 'var(--neon-gold)' : 'var(--border-bright)'}`,
          boxShadow: open ? 'var(--glow-gold)' : 'none',
          cursor: 'pointer',
          fontSize: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 2,
          transition: 'all 0.15s',
        }}
      ><DungeonIcon name="result" tone="gold" plain /></button>

      {/* Panel */}
      {open && (
        <div style={{
          position: 'fixed',
          bottom: 124,
          right: 20,
          zIndex: 99997,
          width: 300,
          background: 'rgba(3,8,20,0.97)',
          border: '2px solid var(--border-bright)',
          boxShadow: '0 0 24px #00d4ff33',
          fontFamily: 'var(--font-pixel)',
          animation: 'px-slide-in 120ms steps(3) forwards',
        }}>
          {/* Header */}
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border-mid)',
            background: 'rgba(0,212,255,0.06)',
          }}>
            <div style={{ fontSize: 8, color: 'var(--neon-cyan)', letterSpacing: 1, marginBottom: 6 }}>
              COMMANDER PROFILE
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: 'var(--neon-gold)' }}>Lv.{level}</span>
              <span style={{ fontSize: 7, color: 'var(--text-primary)' }}>{xpCurrent} / {xpNeeded} XP</span>
            </div>
            <div style={{ height: 6, background: 'var(--bg-void)', border: '1px solid var(--border-mid)' }}>
              <div style={{ height: '100%', width: `${xpPct}%`, background: 'var(--neon-gold)', boxShadow: 'var(--glow-gold)', transition: 'width 400ms steps(8)' }} />
            </div>
            <div style={{ fontSize: 7, color: 'var(--text-dim)', marginTop: 4 }}>Total XP: {xp}</div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-mid)' }}>
            {(['quests', 'achievements'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{
                  flex: 1, padding: '7px 0',
                  background: tab === t ? 'rgba(0,212,255,0.1)' : 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${tab === t ? 'var(--neon-cyan)' : 'transparent'}`,
                  color: tab === t ? 'var(--neon-cyan)' : 'var(--text-dim)',
                  fontFamily: 'var(--font-pixel)', fontSize: 7,
                  cursor: 'pointer', letterSpacing: 0.5,
                }}
              >
                {t === 'quests' ? <><DungeonIcon name="result" tone="cyan" size="xs" plain /> QUESTS</> : '🏅 BADGES'}
              </button>
            ))}
          </div>

          {/* Quest list */}
          {tab === 'quests' && (
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: 7, color: 'var(--text-dim)', marginBottom: 8 }}>今日任務 — 午夜重置</div>
              {todayQuests.map(q => {
                const prog  = questProgress[q.id] ?? 0
                const done  = questsClaimed.includes(q.id)
                const pct   = Math.min(100, Math.round((prog / q.target) * 100))
                return (
                  <div key={q.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 7, color: done ? 'var(--neon-green)' : 'var(--text-primary)', letterSpacing: 0.5 }}>
                        {done ? <><DungeonIcon name="status-ok" tone="green" size="xs" plain />{' '}</> : ''}{q.name}
                      </span>
                      <span style={{ fontSize: 7, color: 'var(--neon-gold)' }}>+{q.xp}XP</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, height: 5, background: 'var(--bg-void)', border: '1px solid var(--border-dim)' }}>
                        <div style={{
                          height: '100%', width: `${pct}%`,
                          background: done ? 'var(--neon-green)' : 'var(--neon-cyan)',
                          transition: 'width 300ms steps(6)',
                        }} />
                      </div>
                      <span style={{ fontSize: 6, color: 'var(--text-dim)', minWidth: 28, textAlign: 'right' }}>
                        {prog}/{q.target}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Achievements list */}
          {tab === 'achievements' && (
            <div style={{ padding: '10px 12px', maxHeight: 280, overflowY: 'auto' }}>
              <div style={{ fontSize: 7, color: 'var(--text-dim)', marginBottom: 8 }}>
                {achievements.length}/{ACHIEVEMENTS.length} 已解鎖
              </div>
              {ACHIEVEMENTS.map(a => {
                const unlocked = achievements.includes(a.id)
                return (
                  <div key={a.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                    opacity: unlocked ? 1 : 0.35,
                    padding: '6px 8px',
                    background: unlocked ? 'rgba(153,69,255,0.08)' : 'transparent',
                    border: unlocked ? '1px solid rgba(153,69,255,0.3)' : '1px solid transparent',
                  }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{a.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 7, color: unlocked ? 'var(--neon-purple)' : 'var(--text-dim)', letterSpacing: 0.5 }}>
                        {a.name}
                      </div>
                      <div style={{ fontSize: 6, color: 'var(--text-dim)', marginTop: 2 }}>{a.desc}</div>
                    </div>
                    <div style={{ fontSize: 6, color: 'var(--neon-gold)', flexShrink: 0 }}>+{a.bonusXp}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </>
  )
}
