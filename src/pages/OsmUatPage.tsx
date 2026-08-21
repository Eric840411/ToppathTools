import { useState } from 'react'
import { BackendUatPanel } from '../features/uat/BackendUatPanel'
import { FrontendAutomationStudio } from '../features/uat/FrontendAutomationStudio'
import type { UatMainTab, UatThemeMode } from '../features/uat/types'
import '../features/uat/UatStudio.css'

const TABS: Array<{ id: UatMainTab; label: string; description: string }> = [
  { id: 'backend', label: 'Backend', description: 'Lark TC Runner' },
  { id: 'h5', label: 'H5', description: 'Mobile Web' },
  { id: 'pc', label: 'PC', description: 'Desktop / Canvas' },
]

export function OsmUatPage({ themeMode }: { themeMode: UatThemeMode }) {
  const [activeTab, setActiveTab] = useState<UatMainTab>('backend')
  const xianxia = themeMode === 'xianxia'
  return (
    <div className="uat-studio">
      <header className="uat-page-header">
        <div>
          <span className="uat-kicker">{xianxia ? 'TAIXUAN TRIAL ARRAY' : 'QUALITY AUTOMATION STUDIO'}</span>
          <h1>{xianxia ? '總綱試煉陣盤' : 'UAT 整合測試工作台'}</h1>
          <p>{xianxia ? '統御後端、H5 與 PC 試煉玉簡；觀照錄術後可拆解術式、重排陣眼並反覆推演。' : '集中管理 Backend、H5 與 PC 測試流程；錄製後可直接拆成積木、拖曳調整並重複使用。'}</p>
        </div>
        <div className="uat-health"><i /><span><strong>{xianxia ? '靈脈穩定' : 'Runner Ready'}</strong><small>{xianxia ? '本命傀儡／外派傀儡自動調度' : 'Local / Agent 自動路由'}</small></span></div>
      </header>
      <nav className="uat-main-tabs" aria-label="UAT 測試類型">
        {TABS.map(tab => <button type="button" className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)} key={tab.id}><strong>{tab.label}</strong><small>{xianxia ? (tab.id === 'backend' ? '後端試煉' : tab.id === 'h5' ? '掌中幻境' : '桌面幻境') : tab.description}</small></button>)}
      </nav>
      {activeTab === 'backend' ? <BackendUatPanel themeMode={themeMode} /> : <FrontendAutomationStudio key={activeTab} platform={activeTab} themeMode={themeMode} />}
    </div>
  )
}
