import { useEffect, useRef, useState } from 'react'

export type CharacterClass = 'commander' | 'hacker' | 'guardian' | 'ranger' | 'sage'
export type CharacterState = 'idle' | 'celebrate' | 'levelup'

const SPRITE_BASE = '/game-assets/generated/toppath-missing-sprites'

// Each frame in the source sheet is 64×96px
const FRAME_W = 64
const FRAME_H = 96

// action → { total sheet width, frame count, ms per frame }
const ACTION_SPEC = {
  idle:    { totalW: 256, frames: 4, msPerFrame: 200 },
  attack:  { totalW: 192, frames: 3, msPerFrame: 160 },
  hit:     { totalW: 128, frames: 2, msPerFrame: 160 },
  victory: { totalW: 192, frames: 3, msPerFrame: 200 },
} as const
type SpriteAction = keyof typeof ACTION_SPEC

const STATE_TO_ACTION: Record<CharacterState, SpriteAction> = {
  idle:      'idle',
  celebrate: 'victory',
  levelup:   'attack',
}

export const CLASS_COLOR: Record<CharacterClass, string> = {
  commander: '#FFD700',
  hacker:    '#00FF41',
  guardian:  '#4A90D9',
  ranger:    '#10B981',
  sage:      '#9F7AEA',
}

const CLASS_LABEL: Record<CharacterClass, string> = {
  commander: 'COMMANDER',
  hacker:    'HACKER',
  guardian:  'GUARDIAN',
  ranger:    'RANGER',
  sage:      'SAGE',
}

const IDLE_QUOTES: Record<CharacterClass, string[]> = {
  commander: ['準備好了，指揮官！', '今天的測試交給我！', '衝啊！', '機台再多也不怕。'],
  hacker:    ['魔法分析，開始！', '資料已讀取完畢。', '讓我看看有什麼異常...', '所有日誌盡在掌握。'],
  guardian:  ['監控中，萬無一失。', '任何異常逃不過我。', '鐵壁防禦，穩如磐石。'],
  ranger:    ['目標鎖定！', '快速突擊！', '圖片也逃不過我的眼。', '掃盪開始！'],
  sage:      ['數據不會說謊。', '機率已在掌控之中。', '宇宙的規律，盡在我心。'],
}

const CELEBRATE_QUOTES: Record<CharacterClass, string[]> = {
  commander: ['任務完成！', '勝利！', '再來一個！'],
  hacker:    ['完美執行！', '程式碼破譯完成！', '✨ 成功！'],
  guardian:  ['防線穩固！', '任務達成！', '🛡 完美守護！'],
  ranger:    ['搞定！', '精準命中！', '🏹 完美射擊！'],
  sage:      ['洞察完成！', '一切如預測！', '✨ 賢者之眼！'],
}

const LEVELUP_QUOTES: Record<CharacterClass, string[]> = {
  commander: ['我變強了！', '升級！力量暴增！'],
  hacker:    ['智力提升！', '升級！系統已入侵！'],
  guardian:  ['防禦強化！', '升級！護甲更堅！'],
  ranger:    ['速度提升！', '升級！移動更快！'],
  sage:      ['智慧增長！', '升級！預言更準！'],
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

interface Props {
  characterClass: CharacterClass
  state?: CharacterState
  /** Display height in px (width scales proportionally from 64:96) */
  size?: number
  showLabel?: boolean
}

export function CharacterSprite({ characterClass, state = 'idle', size = 96, showLabel = true }: Props) {
  const [bubble, setBubble] = useState<string | null>(null)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [animKey, setAnimKey] = useState(0)

  const action = STATE_TO_ACTION[state]
  const spec = ACTION_SPEC[action]
  const color = CLASS_COLOR[characterClass]

  // Scale dimensions proportionally from native 64×96
  const displayH = size
  const displayW = Math.round(size * FRAME_W / FRAME_H)
  const sheetDisplayW = Math.round(size * spec.totalW / FRAME_H)
  const animDuration = spec.msPerFrame * spec.frames
  const iterCount = state === 'idle' ? 'infinite' : '2'

  // Unique keyframe name per size to avoid conflicts across instances
  const sizeKey = size
  const animName = `spr-${action}-h${sizeKey}`

  const spritePath = `${SPRITE_BASE}/class-${characterClass}-${action}/class-${characterClass}-${action}.png`

  // Force animation restart when action changes
  useEffect(() => { setAnimKey(k => k + 1) }, [action, characterClass])

  // Bubble on state change
  useEffect(() => {
    if (state === 'celebrate') setBubble(pickRandom(CELEBRATE_QUOTES[characterClass]))
    else if (state === 'levelup') setBubble(pickRandom(LEVELUP_QUOTES[characterClass]))
    if (state !== 'idle') {
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => setBubble(null), 2500)
    }
    return () => { if (bubbleTimer.current) clearTimeout(bubbleTimer.current) }
  }, [state, characterClass])

  const handleClick = () => {
    setBubble(pickRandom(IDLE_QUOTES[characterClass]))
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 2500)
  }

  return (
    <div
      onClick={handleClick}
      title="點擊查看角色台詞"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none', position: 'relative' }}
    >
      {/* Speech bubble */}
      {bubble && (
        <div style={{
          position: 'absolute', top: -40, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.88)', border: `1px solid ${color}`,
          color, fontFamily: 'var(--font-pixel)', fontSize: 8, padding: '4px 8px',
          whiteSpace: 'nowrap', zIndex: 10, boxShadow: `0 0 8px ${color}44`,
          animation: 'px-slide-in 80ms steps(2) forwards',
          pointerEvents: 'none',
        }}>
          {bubble}
          <div style={{
            position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)',
            width: 6, height: 6, background: 'rgba(0,0,0,0.88)',
            borderRight: `1px solid ${color}`, borderBottom: `1px solid ${color}`, rotate: '45deg',
          }} />
        </div>
      )}

      {/* Sprite container */}
      <div style={{ position: 'relative', width: displayW, height: displayH }}>
        {/* Glow platform */}
        <div style={{
          position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
          width: displayW * 0.8, height: 5,
          background: `radial-gradient(ellipse, ${color}55 0%, transparent 70%)`,
          filter: 'blur(2px)',
          pointerEvents: 'none',
        }} />

        {/* CSS steps() sprite animation */}
        <div
          key={`${characterClass}-${action}-${animKey}`}
          style={{
            width: displayW,
            height: displayH,
            backgroundImage: `url(${spritePath})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${sheetDisplayW}px ${displayH}px`,
            backgroundPosition: '0px 0px',
            imageRendering: 'pixelated',
            animation: `${animName} ${animDuration}ms steps(${spec.frames}) ${iterCount}`,
            filter: state === 'levelup'
              ? `drop-shadow(0 0 6px ${color})`
              : state === 'celebrate'
              ? 'drop-shadow(0 0 4px var(--neon-green))'
              : 'none',
          }}
        />

        {/* Inject keyframes for this size (idempotent — same name = same definition) */}
        <style>{`
          @keyframes spr-idle-h${sizeKey}    { to { background-position-x: -${Math.round(size * 256 / FRAME_H)}px; } }
          @keyframes spr-attack-h${sizeKey}  { to { background-position-x: -${Math.round(size * 192 / FRAME_H)}px; } }
          @keyframes spr-hit-h${sizeKey}     { to { background-position-x: -${Math.round(size * 128 / FRAME_H)}px; } }
          @keyframes spr-victory-h${sizeKey} { to { background-position-x: -${Math.round(size * 192 / FRAME_H)}px; } }
        `}</style>
      </div>

      {/* Class label */}
      {showLabel && (
        <div style={{
          fontFamily: 'var(--font-pixel)', fontSize: 8, color,
          textShadow: `0 0 6px ${color}`, letterSpacing: 1,
        }}>
          {CLASS_LABEL[characterClass]}
        </div>
      )}
    </div>
  )
}
