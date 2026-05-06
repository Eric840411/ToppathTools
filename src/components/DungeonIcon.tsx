type DungeonIconName =
  | 'ai'
  | 'vs'
  | 'wiki'
  | 'file'
  | 'gdocs'
  | 'account'
  | 'settings'
  | 'jira'
  | 'add'
  | 'remove'
  | 'guide'
  | 'result'
  | 'search'
  | 'prompt'
  | 'model'
  | 'compare'
  | 'link'
  | 'status-ok'
  | 'status-warn'
  | 'status-error'
  | 'close'
  | 'gem'

const GLYPHS: Record<DungeonIconName, string> = {
  ai: 'AI',
  vs: 'VS',
  wiki: 'WK',
  file: 'DOC',
  gdocs: 'GD',
  account: 'ID',
  settings: 'CFG',
  jira: 'JR',
  add: '+',
  remove: '-',
  guide: 'LOG',
  result: 'OUT',
  search: 'SCN',
  prompt: 'PRM',
  model: 'MOD',
  compare: 'CMP',
  link: 'LNK',
  'status-ok': 'OK',
  'status-warn': 'WRN',
  'status-error': 'ERR',
  close: 'X',
  gem: 'GM',
}

const FILES: Partial<Record<DungeonIconName, string>> = {
  ai: 'ai.png',
  wiki: 'wiki.png',
  file: 'file.png',
  gdocs: 'gdocs.png',
  account: 'account.png',
  settings: 'settings.png',
  jira: 'jira.png',
  add: 'add.png',
  guide: 'guide.png',
  result: 'result.png',
  search: 'search.png',
  compare: 'compare.png',
  link: 'link.png',
  'status-ok': 'status-ok.png',
  'status-warn': 'status-warn.png',
  'status-error': 'status-error.png',
  close: 'close.png',
  gem: 'gem.png',
}

type Tone = 'cyan' | 'green' | 'gold' | 'red' | 'violet' | 'slate'
type Size = 'xs' | 'sm' | 'md'

const SIZE_PX: Record<Size, number> = { xs: 14, sm: 18, md: 22 }

interface Props {
  name: DungeonIconName
  tone?: Tone
  size?: Size
  className?: string
  title?: string
  /** plain=true: renders just the PNG image, no border/background box */
  plain?: boolean
}

export function DungeonIcon({
  name,
  tone = 'cyan',
  size = 'sm',
  className = '',
  title,
  plain = false,
}: Props) {
  const file = FILES[name]
  const px = SIZE_PX[size]

  if (plain) {
    return file ? (
      <img
        src={`/game-assets/ui-icons/dungeon/${file}`}
        width={px}
        height={px}
        style={{ imageRendering: 'pixelated', verticalAlign: 'middle', display: 'inline', flexShrink: 0 }}
        alt=""
        title={title}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    ) : (
      <span style={{ fontSize: px * 0.6, verticalAlign: 'middle' }} title={title}>{GLYPHS[name]}</span>
    )
  }

  const classes = ['dng-icon', `dng-icon--${tone}`, `dng-icon--${size}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes} aria-hidden="true" title={title}>
      {file ? (
        <img
          className="dng-icon__img"
          src={`/game-assets/ui-icons/dungeon/${file}`}
          alt=""
          onError={e => {
            const el = e.currentTarget
            el.style.display = 'none'
          }}
        />
      ) : (
        <span className="dng-icon__glyph">
          {GLYPHS[name]}
        </span>
      )}
    </span>
  )
}
