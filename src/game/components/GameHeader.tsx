import { useState, useEffect } from 'react'
import type { AccountInfo } from '../../components/JiraAccountModal'

interface Props {
  account: AccountInfo | null
  onAccountClick: () => void
  onSettingsClick: () => void
  onChangelogClick: () => void
  version: string
}

export function GameHeader({ account, onAccountClick, onSettingsClick, onChangelogClick, version }: Props) {
  const [time, setTime] = useState(new Date())
  const [agentCount, setAgentCount] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const check = () => {
      fetch('/api/machine-test/status')
        .then(r => r.json())
        .then((d: { agents?: unknown[] }) => setAgentCount(d.agents?.length ?? 0))
        .catch(() => {})
    }
    check()
    const t = setInterval(check, 10000)
    return () => clearInterval(t)
  }, [])

  const timeStr = time.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const dateStr = time.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')

  return (
    <header style={{
      height: 'var(--header-h)',
      background: 'var(--bg-panel)',
      borderBottom: '2px solid var(--border-mid)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 16,
      flexShrink: 0,
      position: 'relative',
      zIndex: 100,
    }}>
      {/* Top glow line */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent 0%, var(--neon-cyan) 30%, var(--neon-purple) 70%, transparent 100%)',
        opacity: 0.6,
      }} />

      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div style={{
          width: 28, height: 28,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridTemplateRows: 'repeat(4, 1fr)',
          gap: 2,
        }}>
          {[1,1,1,1, 1,0,0,1, 1,0,0,1, 1,1,1,1].map((on, i) => (
            <div key={i} style={{
              background: on ? 'var(--neon-cyan)' : 'transparent',
              boxShadow: on ? 'var(--glow-cyan)' : 'none',
            }} />
          ))}
        </div>
        <div>
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, color: 'var(--neon-cyan)', textShadow: 'var(--glow-cyan)', letterSpacing: 1 }}>
            QA COMMAND
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            TOPPATH TOOLS
          </div>
        </div>
      </div>

      {/* Version badge */}
      <button
        type="button"
        onClick={onChangelogClick}
        style={{
          fontFamily: 'var(--font-pixel)', fontSize: 7,
          color: 'var(--neon-purple)', border: '1px solid var(--neon-purple)',
          background: '#9945ff18', padding: '3px 8px', cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        v{version}
      </button>

      <div style={{ flex: 1 }} />

      {/* Agent status */}
      {agentCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div className="px-dot px-dot--cyan" style={{ animation: 'px-pulse-glow 1.5s ease infinite' }} />
          <span style={{ fontFamily: 'var(--font-pixel)', fontSize: 7, color: 'var(--neon-cyan)' }}>
            {agentCount} AGENT{agentCount > 1 ? 'S' : ''} ONLINE
          </span>
        </div>
      )}

      {/* Clock */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--font-retro)', fontSize: 20, color: 'var(--neon-cyan)', lineHeight: 1, letterSpacing: 2 }}>
          {timeStr}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          {dateStr}
        </div>
      </div>

      {/* Settings */}
      <button
        type="button"
        onClick={onSettingsClick}
        className="px-btn"
        style={{ fontSize: 7, padding: '5px 10px', flexShrink: 0 }}
        title="AI 模型和 Prompt 設定"
      >
        ⚙ CONFIG
      </button>

      {/* Commander (account) */}
      <button
        type="button"
        onClick={onAccountClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: account ? '#00d4ff12' : 'var(--bg-card)',
          border: `2px solid ${account ? 'var(--neon-cyan)' : 'var(--border-mid)'}`,
          padding: '5px 10px',
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: account ? 'var(--glow-cyan)' : 'none',
          transition: 'all var(--trans-fast)',
        }}
      >
        <div style={{
          width: 28, height: 28,
          border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', flexShrink: 0,
          background: 'var(--bg-void)',
        }}>
          {account ? (
            <img
              src="/game-assets/icons/commander.png"
              width={28} height={28}
              style={{ imageRendering: 'pixelated', objectFit: 'cover' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              alt=""
            />
          ) : (
            <span style={{ fontSize: 14 }}>👤</span>
          )}
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 7, color: account ? 'var(--neon-cyan)' : 'var(--text-dim)', letterSpacing: 0.5 }}>
            {account ? 'COMMANDER' : 'NO LOGIN'}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-bright)', marginTop: 1 }}>
            {account ? account.label : '[ SELECT ]'}
          </div>
        </div>
      </button>
    </header>
  )
}
