import { XianxiaReveal } from '../components/XianxiaReveal'
import { PAGE_ACTIONS_ID } from './PageActions'

/**
 * 新版頁首（原型 v7 的 .page-head）：每一頁上方的大標題＋（仙俠版）副標＋說明，底下一條強調色漸層線。
 * 由 App 統一放在每頁最上面，不用逐頁加；原本各頁自己畫的 <h1> 在 redesign/page-head.css 收掉，避免兩個標題。
 * 使用者 1102：「排版沒有按照新設計處理嗎？只更換 ui？」——這是排版對齊的第一步。
 */
export function PageHead({ themeMode, label, themeLabel, description }: {
  themeMode: 'classic' | 'xianxia'
  label: string
  themeLabel: string
  description: string
}) {
  const xx = themeMode === 'xianxia'
  return (
    <header className="rd-page-head">
      <div className="rd-page-head-row">
        <div className="rd-page-head-main">
          <h1 className="rd-page-title">{label}</h1>
          {/* 仙俠名逐字浮現：key 一定要帶，否則 Dashboard 每 30 秒輪詢 re-render 都會重播 */}
          {xx && themeLabel !== label && (
            <span className="rd-page-sub"><XianxiaReveal key={themeLabel} text={themeLabel} /></span>
          )}
        </div>
        {/* 頁面操作按鈕的位置：各頁用 <PageActions> 把按鈕畫進來（redesign/PageActions.tsx）；這裡自己不放子元素 */}
        <div className="rd-page-head-actions" id={PAGE_ACTIONS_ID} />
      </div>
      {description && <p className="rd-page-desc">{description}</p>}
    </header>
  )
}

/** 頂列麵包屑：群組 / <b>頁面</b>（沒有子頁的只顯示頁面）。仙俠版用仙俠名 */
export function Crumb({ group, page }: { group?: string; page: string }) {
  return (
    <nav className="rd-crumb" aria-label="目前位置">
      {group && group !== page && <><span>{group}</span><span className="rd-crumb-sep" aria-hidden="true">/</span></>}
      <b>{page}</b>
    </nav>
  )
}
