import { useState, useEffect, useRef } from 'react'
import { useGameProfileCtx } from '../context/GameProfileContext'
import { useAvatar } from '../hooks/useAvatar'
import { CharacterSprite, type CharacterState } from './CharacterSprite'
import { SkillBar } from './SkillBar'
import { ClassSelectModal } from './ClassSelectModal'

export type GameTabId =
  | 'jira' | 'lark'
  | 'osm' | 'machinetest' | 'imagecheck' | 'osm-config' | 'autospin' | 'url-pool' | 'jackpot' | 'osm-uat'
  | 'gs-imgcompare' | 'gs-stats' | 'gs-logchecker'
  | 'history'

interface NavItem {
  id: GameTabId
  label: string
  icon: string
  labelIcon?: string
  children?: NavItem[]
}

const NAV: NavItem[] = [
  { id: 'jira',    label: 'JIRA QUEST',    icon: '📋', labelIcon: 'banner'  },
  { id: 'lark',    label: 'TESTCASE LAB',  icon: '🔬', labelIcon: 'crystal' },
  {
    id: 'osm',
    label: 'OSM TERRITORY',
    icon: '🗺',
    labelIcon: 'castle',
    children: [
      { id: 'osm',         label: 'VERSION SYNC',  icon: '📡', labelIcon: 'portals' },
      { id: 'machinetest', label: 'MACHINE RAID',  icon: '⚔',  labelIcon: 'mech'    },
      { id: 'imagecheck',  label: 'IMAGE VERIFY',  icon: '🖼',  labelIcon: 'crystal' },
      { id: 'osm-config',  label: 'CONFIG CHECK',  icon: '⚙',  labelIcon: 'gear'    },
      { id: 'autospin',    label: 'AUTO SENTINEL', icon: '🤖', labelIcon: 'mech'    },
      { id: 'url-pool',    label: 'URL VAULT',     icon: '🔑', labelIcon: 'chest'   },
      { id: 'jackpot',     label: 'JACKPOT RADAR', icon: '📻', labelIcon: 'slot'    },
      { id: 'osm-uat',     label: 'UAT ASSAULT',   icon: '🎯', labelIcon: 'swords'  },
    ],
  },
  {
    id: 'gs-imgcompare',
    label: 'GAMESHOW OPS',
    icon: '🎲',
    labelIcon: 'crown',
    children: [
      { id: 'gs-imgcompare', label: 'IMG COMPARE',  icon: '🖼',  labelIcon: 'crystal' },
      { id: 'gs-stats',      label: 'PROB STATS',   icon: '📊', labelIcon: 'potion'  },
      { id: 'gs-logchecker', label: 'LOG INTERCEPT',icon: '🪤', labelIcon: 'swords'  },
    ],
  },
  { id: 'history', label: 'OP RECORDS', icon: '📜', labelIcon: 'scroll' },
]

interface Props {
  activeTab: GameTabId
  onTabChange: (id: GameTabId) => void
}

function NavIcon({ labelIcon, emoji, size = 20 }: {
  labelIcon?: string
  emoji: string
  size?: number
}) {
  if (labelIcon) {
    return (
      <img
        src={`/game-assets/label-icons-18/label-${labelIcon}-18.png`}
        width={size} height={size}
        style={{ imageRendering: 'pixelated', flexShrink: 0, marginLeft: 3, marginTop: 0 }}
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
  const { level, xpPct, xpCurrent, xpNeeded, questsClaimed, classId, classDef } = useGameProfileCtx()
  const { avatarSrc } = useAvatar()

  const [charState, setCharState] = useState<CharacterState>('idle')
  const [showClassSelect, setShowClassSelect] = useState(false)
  const charTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevLevel = useRef(level)
  const prevClaimed = useRef(questsClaimed.length)

  const triggerCharState = (s: CharacterState, ms = 2500) => {
    setCharState(s)
    if (charTimer.current) clearTimeout(charTimer.current)
    charTimer.current = setTimeout(() => setCharState('idle'), ms)
  }

  // React to level up
  useEffect(() => {
    if (level > prevLevel.current) triggerCharState('levelup', 3000)
    prevLevel.current = level
  }, [level])

  // React to quest completion
  useEffect(() => {
    if (questsClaimed.length > prevClaimed.current) triggerCharState('celebrate', 2500)
    prevClaimed.current = questsClaimed.length
  }, [questsClaimed.length])

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
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <div style={{
            width: 74,
            height: 74,
            padding: 3,
            border: '2px solid var(--border-bright)',
            background: 'linear-gradient(180deg, rgba(8,18,36,0.95), rgba(3,8,18,0.98))',
            boxShadow: '0 0 10px rgba(0,212,255,0.2)',
          }}>
            <img
              src={avatarSrc}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                objectFit: 'cover',
                imageRendering: 'pixelated',
                background: '#040b16',
              }}
              onError={e => { (e.target as HTMLImageElement).src = '/game-assets/icons/commander-v2.png' }}
              alt=""
            />
          </div>
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

        {/* Character display */}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          {classId ? (
            <>
              <CharacterSprite characterClass={classId} state={charState} size={128} />
              <SkillBar />
            </>
          ) : (
            <>
              {/* Silhouette placeholder when no class chosen */}
              <div style={{
                width: 85, height: 128,
                background: 'rgba(0,212,255,0.04)',
                border: '1px dashed var(--border-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 32, opacity: 0.4,
              }}>?</div>
              <button
                type="button"
                onClick={() => setShowClassSelect(true)}
                style={{
                  fontFamily: 'var(--font-pixel)', fontSize: 8,
                  color: 'var(--neon-gold)',
                  background: 'rgba(255,215,0,0.08)',
                  border: '1px solid var(--neon-gold)',
                  padding: '4px 10px',
                  cursor: 'pointer', letterSpacing: 0.5,
                  boxShadow: '0 0 8px rgba(255,215,0,0.2)',
                  animation: 'px-pulse 2s steps(2) infinite',
                }}
              >
                ⭐ SELECT CLASS
              </button>
            </>
          )}

          {/* Class label or change hint */}
          {classId && classDef && (
            <button
              type="button"
              onClick={() => setShowClassSelect(false)}
              style={{
                fontFamily: 'var(--font-pixel)', fontSize: 7,
                color: classDef.color,
                background: 'transparent', border: 'none',
                cursor: 'default', letterSpacing: 0.5,
                textShadow: `0 0 4px ${classDef.color}`,
              }}
              title="職業已鎖定"
            >
              {classDef.nameZh}
            </button>
          )}
        </div>

        {/* Class select modal */}
        {showClassSelect && <ClassSelectModal onClose={() => setShowClassSelect(false)} />}
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
                <NavIcon labelIcon={item.labelIcon} emoji={item.icon} size={20} />
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
                          borderLeft: childActive
                            ? '3px solid var(--neon-green)'
                            : '2px solid var(--border-dim)',
                          boxShadow: childActive ? 'inset 0 0 12px rgba(0,255,136,0.06)' : 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'all 80ms steps(2)',
                        }}
                      >
                        <NavIcon labelIcon={child.labelIcon} emoji={child.icon} size={18} />
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
