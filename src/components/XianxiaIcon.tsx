export type XianxiaIconName =
  | 'guide'
  | 'account'
  | 'settings'
  | 'document'
  | 'ai'
  | 'warning'
  | 'overview'
  | 'monitor'
  | 'history'
  | 'knowledge'
  | 'notification'
  | 'compare'

export function XianxiaIcon({
  name,
  size = 20,
  className = '',
}: {
  name: XianxiaIconName
  size?: number
  className?: string
}) {
  return (
    <img
      className={`xianxia-icon${className ? ` ${className}` : ''}`}
      src={`/themes/xianxia/icons-v3/${name}.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
