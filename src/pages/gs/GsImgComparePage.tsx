import { RedesignFrame } from './RedesignFrame'

export function GsImgComparePage({ themeMode }: { themeMode?: 'classic' | 'xianxia' }) {
  return <RedesignFrame src="/api/gs/img-compare" title="圖片比對工具" themeMode={themeMode} />
}
