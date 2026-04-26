import { useState } from 'react'
import { useGameProfileCtx } from '../context/GameProfileContext'

export type GameTabId =
  | 'jira' | 'lark'
  | 'osm' | 'machinetest' | 'imagecheck' | 'osm-config' | 'autospin' | 'url-pool' | 'jackpot' | 'osm-uat'
  | 'gs-pdf' | 'gs-imgcompare' | 'gs-stats' | 'gs-logchecker'
  | 'history'

interface NavItem {
  id: GameTabId
  label: string
  icon: string
  iconSlot?: string
  children?: NavItem[]
}

const NAV: NavItem[] = [
  { id: 'jira',    label: 'JIRA QUEST',    icon: '📋', iconSlot: 'jira' },
  { id: 'lark',    label: 'TESTCASE LAB',  icon: '🔬', iconSlot: 'lark' },
  {
    id: 'osm',
    label: 'OSM TERRITORY',
    icon: '🗺',
    iconSlot: 'osm',
    children: [
      { id: 'osm',         label: 'VERSION SYNC',  icon: '📡', iconSlot: 'osm' },
      { id: 'machinetest', label: 'MACHINE RAID',  icon: '⚔',  iconSlot: 'machinetest' },
      { id: 'imagecheck',  label: 'IMAGE VERIFY',  icon: '🖼',  iconSlot: 'imagecheck' },
      { id: 'osm-config',  label: 'CONFIG CHECK',  icon: '⚙',  iconSlot: 'osm-config' },
      { id: 'autospin',    label: 'AUTO SENTINEL', icon: '🤖', iconSlot: 'autospin' },
      { id: 'url-pool',    label: 'URL VAULT',     icon: '🔑', iconSlot: 'vault' },
      { id: 'jackpot',     label: 'JACKPOT RADAR', icon: '📻', iconSlot: 'jackpot' },
      { id: 'osm-uat',     label: 'UAT ASSAULT',   icon: '🎯', iconSlot: 'osm-uat' },
    ],
  },
  {
    id: 'gs-pdf',
    label: 'GAMESHOW OPS',
    icon: '🎲',
    iconSlot: 'gs-stats',
    children: [
      { id: 'gs-pdf',        label: 'PDF ANALYSIS', icon: '📄', iconSlot: 'gs-pdf' },
      { id: 'gs-imgcompare', label: 'IMG COMPARE',  icon: '🖼',  iconSlot: 'gs-imgcompare' },
      { id: 'gs-stats',      label: 'PROB STATS',   icon: '📊', iconSlot: 'gs-stats' },
      { id: 'gs-logchecker', label: 'LOG INTERCEPT',icon: '🪤', iconSlot: 'gs-logchecker' },
    ],
  },
  { id: 'history', label: 'OP RECORDS', icon: '📜', iconSlot: 'history' },
]

interface Props {
  activeTab: GameTabId
  onTabChange: (id: GameTabId) => void
}

function PixelIcon({ slot, emoji, size = 20 }: { slot?: string; emoji: string; size?: number }) {
  if (slot) {
    return (
      <img
        src={`/game-assets/icons/${slot}.png`}
        width={size} height={size}
        style={{ imageRendering: 'pixelated', flexShrink: 0 }}
        onError={e => {
          const el = e.target as HTMLImageElement
          el.style.display = 'none'
          const span = document.createElement('span')
          span.style.fontSize = '14px'
          span.style.lineHeight = '1'
          span.textContent = emoji
          el.parentNode?.insertBefore(span, el.nextSibling)
        }}
        alt=""
      />
    )
  }
  return <span style={{ fontSize: 14, lineHeight: 1 }}>{emoji}</span>
}

export function GameSidebar({ activeTab, onTabChange }: Props) {
  const [expanded, setExpanded] = useState<string | null>('osm')
  const { level, xpPct, xpCurrent, xpNeeded } = useGameProfileCtx()

  const handleTopClick = (item: NavItem) => {
    if (item.children) {
      setExpanded(prev => prev === item.id ? null : item.id)
      onTabChange(item.children[0].id)
    } else {
      setExpanded(null)
      onTabChange(item.id)
    }
  }

  const isGroupActive = (item: NavItem) =>
    item.id === activeTab || item.children?.some(c => c.id === activeTab)

  return (
    <nav style={{
      width: 'var(--sidebar-w)',
      minWidth: 'var(--sidebar-w)',
      background: 'var(--bg-panel)',
      backdropFilter: 'blur(8px)',
      borderRight: '2px solid var(--border-mid)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
    }}>
      {/* Player stats block */}
      <div style={{ padding: '14px 12px 10px', borderBottom: '1px solid var(--border-dim)' }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <img
            src="/game-assets/icons/commander.png"
            style={{ width: 56, height: 56, imageRendering: 'pixelated', border: '2px solid var(--border-bright)', display: 'block', margin: '0 auto' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            alt=""
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36,
            border: '2px solid var(--border-bright)',
            background: 'var(--bg-void)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, flexShrink: 0,
          }}>🎖</div>
          <div>
            <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--neon-gold)', letterSpacing: 0.5, textShadow: 'var(--glow-gold)' }}>QA MASTER</div>
            <div style={{ fontFamily: 'var(--font-pixel)', fontSize: 10, color: 'var(--text-bright)', marginTop: 3 }}>LV.{level}</div>
          </div>
        </div>
        <div style={{ marginBottom: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span className="px-label">XP</span>
            <span className="px-label" style={{ color: 'var(--neon-gold)' }}>{xpCurrent}/{xpNeeded}</span>
          </div>
          <div className="px-bar px-bar--gold">
            <div className="px-bar__fill" style={{ width: `${xpPct}%` }} />
          </div>
        </div>
      </div>

      {/* Nav items */}
      <div style={{ flex: 1, padding: '8px 0' }}>
        {NAV.map(item => {
          const active = isGroupActive(item)
          const isExpanded = expanded === item.id && !!item.children

          return (
            <div key={item.id}>
              <button
                type="button"
                onClick={() => handleTopClick(item)}
                style={{
                  width: '100%',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 20px 10px 14px',
                  backgroundImage: `url('/game-assets/frames/${active ? 'nav-active' : 'nav-inactive'}.png')`,
                  backgroundSize: '100% 100%',
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'filter var(--trans-fast)',
                  textAlign: 'left',
                  imageRendering: 'pixelated',
                }}
              >
                <PixelIcon slot={item.iconSlot} emoji={item.icon} size={20} />
                <span style={{
                  fontFamily: 'var(--font-pixel)',
                  fontSize: 10,
                  color: active ? 'var(--neon-cyan)' : 'var(--text-primary)',
                  textShadow: active ? 'var(--glow-cyan)' : 'none',
                  letterSpacing: 0.5,
                  flex: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {item.label}
                </span>
                {item.children && (
                  <span style={{ fontSize: 8, color: 'var(--text-dim)', flexShrink: 0 }}>
                    {isExpanded ? '▼' : '▶'}
                  </span>
                )}
              </button>

              {isExpanded && item.children && (
                <div style={{ borderLeft: '1px solid var(--border-dim)', marginLeft: 22, animation: 'px-slide-in 120ms steps(3) forwards' }}>
                  {item.children.map(child => {
                    const childActive = child.id === activeTab
                    return (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => onTabChange(child.id)}
                        style={{
                          width: '100%',
                          display: 'flex', alignItems: 'center', gap: 7,
                          padding: '7px 10px 7px 10px',
                          background: childActive ? '#00d4ff14' : 'transparent',
                          border: 'none',
                          borderLeft: `2px solid ${childActive ? 'var(--neon-cyan)' : 'var(--border-dim)'}`,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <PixelIcon slot={child.iconSlot} emoji={child.icon} size={18} />
                        <span style={{
                          fontFamily: 'var(--font-pixel)',
                          fontSize: 10,
                          color: childActive ? 'var(--neon-cyan)' : 'var(--text-primary)',
                          letterSpacing: 0.5,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {child.label}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom system status */}
      <div style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--border-dim)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ color: 'var(--text-primary)' }}>SYSTEM</span>
          <span style={{ color: 'var(--neon-green)', textShadow: 'var(--glow-green)' }}>ONLINE</span>
        </div>
        <div className="px-bar">
          <div className="px-bar__fill" style={{ width: '82%', background: 'var(--neon-green)', boxShadow: 'var(--glow-green)' }} />
        </div>
      </div>
    </nav>
  )
}
