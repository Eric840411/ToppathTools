import { RedesignFrame } from './RedesignFrame'

export function GsBonusV2Page({ themeMode }: { themeMode?: 'classic' | 'xianxia' }) {
  return <RedesignFrame src="/api/gs/bonus-v2" title="Bonus V2 機率統計" themeMode={themeMode} />
}
