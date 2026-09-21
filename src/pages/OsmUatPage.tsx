import { useState } from 'react'
import { OnboardingGuide, hasSeenUatGuide } from '../features/uat/OnboardingGuide'
import { BackendUatPanel } from '../features/uat/BackendUatPanel'
import { FrontendAutomationStudio } from '../features/uat/FrontendAutomationStudio'
import { UatAgentBar } from '../features/uat/UatAgentBar'
import type { UatMainTab, UatThemeMode } from '../features/uat/types'
import '../features/uat/UatStudio.css'

const TABS: Array<{ id: UatMainTab; label: string; description: string }> = [
  { id: 'backend', label: 'Backend', description: 'Lark TC Runner' },
  { id: 'h5', label: 'H5', description: 'Mobile Web' },
  { id: 'pc', label: 'PC', description: 'Desktop / Canvas' },
]

export function OsmUatPage({ themeMode }: { themeMode: UatThemeMode }) {
  const [activeTab, setActiveTab] = useState<UatMainTab>('backend')
  /**
   * 每個分頁**各自**選定的執行位置（`''` 自動／agent id／`'server'` 只有 Backend 有）。
   *
   * ⚠️ **不做成全域共用一份。** 三個分頁要的能力不同，沒有 Agent 時的退路也不同
   *    （Backend 是伺服器端 fallback、H5/PC 是本機 Chrome）——共用一份的話，
   *    同一個選擇在不同分頁意思會不一樣，那比原本各自一個下拉更難懂。
   */
  const [agentByTab, setAgentByTab] = useState<Record<UatMainTab, string>>({ backend: '', h5: '', pc: '' })
  const xianxia = themeMode === 'xianxia'
  /**
   * 新手指引。**第一次進來自動開一次**，之後靠頁首那顆按鈕自己叫。
   * ⚠️ 用 lazy initializer 讀 localStorage——寫在 render 裡每次重繪都會讀一次，
   *    而且會在切分頁時把已經關掉的指引又打開。
   */
  const [guideOpen, setGuideOpen] = useState(() => !hasSeenUatGuide())
  return (
    <div className="uat-studio">
      <header className="uat-page-header">
        <div>
          <span className="uat-kicker">{xianxia ? 'TAIXUAN TRIAL ARRAY' : 'QUALITY AUTOMATION STUDIO'}</span>
          <h1>{xianxia ? '總綱試煉陣盤' : 'UAT 整合測試工作台'}</h1>
          <p>{xianxia ? '統御後端、H5 與 PC 試煉玉簡；觀照錄術後可拆解術式，歸屬試煉後自會分判並回填玉牒。' : '集中管理 Backend、H5 與 PC 測試流程；錄製後可直接拆成積木，綁上 Lark TC 就會依 TC 判定並回寫。'}</p>
        </div>
        {/* 指引要隨時叫得出來：第一次自動播完之後，忘記某一步的人只能靠這顆 */}
        <button type="button" className="uat-guide-open" onClick={() => setGuideOpen(true)}>
          {xianxia ? '入門引路' : '新手指引'}
        </button>
      </header>
      {/* ⚠️ 這裡原本是一顆**寫死**的「Runner Ready／靈脈穩定」——一台 Agent 都沒有
          也照樣顯示。問題不是缺資訊，是在報一個假的綠燈，所以直接換掉而不是並存。
          擺在分頁列**上方**：切 tab 不會消失，而且可用性跟著當前分頁算。 */}
      {/* ①②③ 導引的「選在哪台機器跑」會捲到這裡（見 focusPanel.ts） */}
      <div id="uat-focus-agent">
      <UatAgentBar tab={activeTab} themeMode={themeMode}
        value={agentByTab[activeTab]}
        onChange={next => setAgentByTab(current => ({ ...current, [activeTab]: next }))} />
      </div>
      <nav className="uat-main-tabs" aria-label="UAT 測試類型" id="uat-focus-tabs">
        {TABS.map(tab => <button type="button" className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)} key={tab.id}><strong>{tab.label}</strong><small>{xianxia ? (tab.id === 'backend' ? '後端試煉' : tab.id === 'h5' ? '掌中幻境' : '桌面幻境') : tab.description}</small></button>)}
      </nav>
      {activeTab === 'backend'
        ? <BackendUatPanel themeMode={themeMode} agentId={agentByTab.backend} />
        : <FrontendAutomationStudio key={activeTab} platform={activeTab} themeMode={themeMode} agentId={agentByTab[activeTab]} />}
      {guideOpen && <OnboardingGuide xianxia={xianxia} onClose={() => setGuideOpen(false)} />}
    </div>
  )
}
