import { useEffect, useState } from 'react'
import { OsmPage } from './pages/OsmPage'
import { OsmConfigComparePage } from './pages/OsmConfigComparePage'
import { AutoSpinPage } from './pages/AutoSpinPage'
import { JiraPage } from './pages/JiraPage'
import { LarkPage } from './pages/LarkPage'
import { MachineTestPage } from './pages/MachineTestPage'
import { ScriptedBetPage } from './pages/ScriptedBetPage'
import { LocalAgentPage } from './pages/LocalAgentPage'
import { HistoryPage } from './pages/HistoryPage'
import { ImageCheckPage } from './pages/ImageCheckPage'
import { UrlPoolPage } from './pages/UrlPoolPage'
import { JackpotPage } from './pages/JackpotPage'
import { OsmUatPage } from './pages/OsmUatPage'
import { GsImgComparePage } from './pages/gs/GsImgComparePage'
import { GsLogCheckerPage } from './pages/gs/GsLogCheckerPage'
import { GsBonusV2Page } from './pages/gs/GsBonusV2Page'
import { SystemAdminPage } from './pages/SystemAdminPage'
import ChangelogModal from './components/ChangelogModal'
import GeminiSettingsModal from './components/GeminiSettingsModal'
import AiAgentMonitorWidget from './components/AiAgentMonitorWidget'
import { type AccountInfo } from './components/JiraAccountModal'
import { AuthLoginModal } from './components/AuthLoginModal'
import { APP_VERSION } from './version'
import { fetchAuthAccount, loadGlobalAccount, logoutAuthAccount, saveGlobalAccount } from './authSession'
import './App.css'

type TabId = 'jira' | 'lark' | 'osm' | 'machinetest' | 'imagecheck' | 'history'
  | 'gs-imgcompare' | 'gs-logchecker' | 'gs-bonusv2' | 'osm-config' | 'autospin' | 'url-pool' | 'osm-uat' | 'jackpot'
  | 'scripted-bet' | 'local-agent' | 'sysadmin' | 'changelog'
type GroupId = 'jira' | 'lark' | 'osm-tools' | 'color-game' | 'settings' | 'history' | 'sysadmin' | 'changelog'

type SubTab = {
  id: TabId
  label: string
  icon: string
  iconClass: string
  description: string
}

type Group = {
  id: GroupId
  label: string
  icon: string
  iconClass: string
  tab?: TabId
  description?: string
  subtabs?: SubTab[]
}

const groups: Group[] = [
  {
    id: 'jira',
    label: 'Jira 批量開單',
    icon: 'J',
    iconClass: 'tab-icon--jira',
    tab: 'jira',
    description: '從試算表資料建立 Issue、新增評論、切換狀態（支援 QA / PM 模式切換）',
  },
  {
    id: 'lark',
    label: 'TestCase 生成',
    icon: 'L',
    iconClass: 'tab-icon--lark',
    tab: 'lark',
    description: '輸入規格書 URL，AI 自動生成測試案例並比對',
  },
  {
    id: 'osm-tools',
    label: 'OSM Tools',
    icon: 'O',
    iconClass: 'tab-icon--osm',
    subtabs: [
      {
        id: 'osm',
        label: 'OSM 版號同步',
        icon: 'O',
        iconClass: 'tab-icon--osm',
        description: '即時同步各渠道機台版本，並解析 ImageRecon 週報',
      },
      {
        id: 'machinetest',
        label: '機台自動化測試',
        icon: 'M',
        iconClass: 'tab-icon--machinetest',
        description: '批量測試機台進入、推流、Spin、音頻、退出',
      },
      {
        id: 'imagecheck',
        label: '圖片刪除驗證',
        icon: 'I',
        iconClass: 'tab-icon--imagecheck',
        description: '貼上已刪除圖片清單 + 前端 URL，在 Toppath 內嵌虛擬瀏覽器操作遊戲，自動驗證圖片是否仍被載入',
      },
      {
        id: 'osm-config',
        label: 'Config 比對',
        icon: 'C',
        iconClass: 'tab-icon--osm',
        description: '貼上線上 URL（含 token），自動擷取 serverCfg.js 並與模板深層比對，快速確認更版後設定是否正確',
      },
      {
        id: 'autospin',
        label: 'AutoSpin',
        icon: 'A',
        iconClass: 'tab-icon--machinetest',
        description: '多機台自動化持續 Spin：設定遊戲 URL、RTMP 串流、OpenCV 模板偵測，即時監控 Log 與截圖',
      },
      {
        id: 'url-pool',
        label: 'URL 帳號池',
        icon: 'U',
        iconClass: 'tab-icon--jira',
        description: '管理共用 Token URL 帳號池，即時查看使用狀態，一鍵使用 / 釋放',
      },
      {
        id: 'scripted-bet',
        label: '腳本化投注紀錄',
        icon: 'S',
        iconClass: 'tab-icon--colorgame',
        description: '依序領取 URL 帳號，進入指定機台隨機 Spin，退出成功後關閉視窗並換下一個帳號。',
      },
      {
        id: 'jackpot',
        label: 'Jackpot 監控',
        icon: 'J',
        iconClass: 'tab-icon--colorgame',
        description: '每 15 秒自動拉取 Jackpot 獎池數據，位數異常或數值暴增自動推送 Lark 告警',
      },
      {
        id: 'osm-uat',
        label: 'UAT 整合測試',
        icon: 'T',
        iconClass: 'tab-icon--machinetest',
        description: '從 Lark 拉取 TC，自動執行後台 UAT 測試（排序/Bonus/Export/Config），即時串流進度與截圖',
      },
    ],
  },
  {
    id: 'color-game',
    label: 'Game Show',
    icon: 'G',
    iconClass: 'tab-icon--colorgame',
    subtabs: [
      {
        id: 'gs-imgcompare',
        label: '圖片比對',
        icon: 'C',
        iconClass: 'tab-icon--imagecheck',
        description: '輸入兩個遊戲 URL，自動攔截所有載入圖片，進行視覺 Diff 與資源大小比對',
      },
      {
        id: 'gs-logchecker',
        label: 'Log 攔截工具',
        icon: 'L',
        iconClass: 'tab-icon--history',
        description: '注入腳本攔截前端 /api/log 請求，驗證欄位完整性並匯出 CSV',
      },
      {
        id: 'gs-bonusv2',
        label: 'Bonus V2 統計',
        icon: 'B',
        iconClass: 'tab-icon--colorgame',
        description: '攔截 Bonus V2 遊戲 WebSocket，統計各骰型機率並與理論值比對',
      },
    ],
  },
]

const historyGroup: Group = {
  id: 'history',
  label: '操作歷史紀錄',
  icon: 'H',
  iconClass: 'tab-icon--history',
  tab: 'history',
  description: '查看所有功能的操作紀錄，支援今日 / 3 天 / 7 天篩選',
}

const settingsGroup: Group = {
  id: 'settings',
  label: 'Local Agent',
  icon: 'A',
  iconClass: 'tab-icon--machinetest',
  tab: 'local-agent',
  description: '下載與管理 Toppath Local Agent，讓 MachineTest 與 Scripted Bet 在使用者本機執行。',
}

const sysadminGroup: Group = {
  id: 'sysadmin',
  label: '系統管理',
  icon: 'S',
  iconClass: 'tab-icon--history',
  tab: 'sysadmin',
  description: '管理帳號與各角色的功能頁面權限',
}



function App() {
  const [activeGroup, setActiveGroup] = useState<GroupId>('jira')
  const [activeTab, setActiveTab] = useState<TabId>('jira')
  const [showChangelog, setShowChangelog] = useState(false)
  const [showGemini, setShowGemini] = useState(false)
  const [globalAccount, setGlobalAccount] = useState<AccountInfo | null>(loadGlobalAccount)
  const [authChecking, setAuthChecking] = useState(true)
  const [permissions, setPermissions] = useState<string[]>([])

  async function fetchPermissions() {
    try {
      const r = await fetch('/api/admin/my-permissions')
      const d = await r.json() as { ok: boolean; permissions?: string[] }
      setPermissions(d.ok ? (d.permissions ?? []) : [])
    } catch {
      setPermissions([])
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchAuthAccount()
      .then(account => {
        if (cancelled) return
        setGlobalAccount(account)
        saveGlobalAccount(account)
      })
      .catch(() => {
        if (cancelled) return
        setGlobalAccount(null)
        saveGlobalAccount(null)
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false)
      })
    return () => { cancelled = true }
  }, [])

  // Fetch permissions whenever globalAccount changes; redirect to first accessible group
  useEffect(() => {
    if (globalAccount) {
      fetchPermissions().then(() => {
        // handled below via separate effect after permissions state updates
      })
    } else {
      setPermissions([])
    }
  }, [globalAccount])

  function handleGlobalAccountSelect(acc: AccountInfo) {
    setGlobalAccount(acc)
    saveGlobalAccount(acc)
  }
  async function handleGlobalAccountClear() {
    setGlobalAccount(null)
    saveGlobalAccount(null)
    await logoutAuthAccount()
  }

  function handleGroupClick(group: Group) {
    setActiveGroup(group.id)
    if (group.tab) {
      setActiveTab(group.tab)
    } else if (group.subtabs) {
      setActiveTab(group.subtabs[0].id)
    }
  }

  function canAccess(tabId: TabId): boolean {
    if (!globalAccount) return false
    if (globalAccount.role === 'admin') return true
    if (tabId === 'local-agent') return true
    // 'jira' tab is accessible if user has either jira-qa or jira-pm
    if (tabId === 'jira') return permissions.includes('jira-qa') || permissions.includes('jira-pm')
    if (tabId === 'scripted-bet') return permissions.includes('machinetest') || permissions.includes('url-pool')
    return permissions.includes(tabId)
  }

  const allowedJiraModes = globalAccount?.role === 'admin'
    ? ['qa', 'pm']
    : [
        ...(permissions.includes('jira-qa') ? ['qa'] : []),
        ...(permissions.includes('jira-pm') ? ['pm'] : []),
      ]

  function filterGroup(g: Group): Group | null {
    if (g.tab) return canAccess(g.tab) ? g : null
    if (g.subtabs) {
      const visible = g.subtabs.filter(s => canAccess(s.id))
      return visible.length > 0 ? { ...g, subtabs: visible } : null
    }
    return null
  }

  const visibleGroups = groups.map(g => filterGroup(g)).filter((g): g is Group => g !== null)
  const visibleSettings = filterGroup(settingsGroup)
  const visibleHistory = filterGroup(historyGroup)
  const visibleSysadmin = canAccess('sysadmin') ? sysadminGroup : null
  const allVisible = [...visibleGroups, ...(visibleSettings ? [visibleSettings] : []), ...(visibleHistory ? [visibleHistory] : []), ...(visibleSysadmin ? [visibleSysadmin] : [])]

  // Redirect activeGroup/activeTab if current selection is no longer accessible
  const currentGroup = allVisible.find(g => g.id === activeGroup) ?? allVisible[0]
  const currentTab = currentGroup?.subtabs?.find(s => s.id === activeTab)
  // If current tab is not in visible subtabs, reset to first subtab of current group
  const effectiveTab = currentTab ? activeTab : (currentGroup?.subtabs?.[0]?.id ?? currentGroup?.tab ?? activeTab)

  const currentSubtab = currentGroup?.subtabs?.find(s => s.id === effectiveTab)
  const currentDescription = currentSubtab?.description ?? currentGroup?.description ?? ''
  const currentPageLabel = currentSubtab?.label ?? currentGroup?.label ?? ''

  return (
    <div className="app">
      {/* ── Sidebar ── */}
      <nav className="app-sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-inner">
            <span className="brand-dot" />
            <div className="sidebar-logo-text">
              <span className="sidebar-brand-name">Toppath Tools</span>
              <button
                type="button"
                onClick={() => setShowChangelog(true)}
                className="version-badge"
                title="查看更新日誌"
              >
                v{APP_VERSION}
              </button>
            </div>
          </div>
          <p className="sidebar-sub">Workflow Integrator</p>
        </div>

        {/* Nav items */}
        <div className="sidebar-nav">
          <div className="sidebar-section-label">工具</div>
          {visibleGroups.map((group) => (
            <div key={group.id}>
              <button
                type="button"
                className={`sidebar-nav-item${currentGroup?.id === group.id ? ' sidebar-nav-item--active' : ''}`}
                onClick={() => handleGroupClick(group)}
              >
                <span className={`tab-icon ${group.iconClass}`}>{group.icon}</span>
                <span className="sidebar-nav-label">{group.label}</span>
                {group.subtabs && (
                  <span className="sidebar-expand-arrow">
                    {currentGroup?.id === group.id ? '▾' : '▸'}
                  </span>
                )}
              </button>
              {/* Subtabs — shown when group is active */}
              {group.subtabs && currentGroup?.id === group.id && (
                <div className="sidebar-subtabs">
                  {group.subtabs.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      className={`sidebar-subtab-item${effectiveTab === sub.id ? ' sidebar-subtab-item--active' : ''}`}
                      onClick={() => setActiveTab(sub.id)}
                    >
                      <span className={`tab-icon sub-tab-icon ${sub.iconClass}`}>{sub.icon}</span>
                      {sub.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="sidebar-divider" />
          <div className="sidebar-section-label">系統</div>

          {visibleSettings && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === settingsGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(settingsGroup)}
            >
              <span className={`tab-icon ${settingsGroup.iconClass}`}>{settingsGroup.icon}</span>
              <span className="sidebar-nav-label">{settingsGroup.label}</span>
            </button>
          )}

          {visibleHistory && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === historyGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(historyGroup)}
            >
              <span className={`tab-icon ${historyGroup.iconClass}`}>{historyGroup.icon}</span>
              <span className="sidebar-nav-label">{historyGroup.label}</span>
            </button>
          )}

          <button
            type="button"
            className={`sidebar-nav-item${currentGroup?.id === sysadminGroup.id ? ' sidebar-nav-item--active' : ''}${!visibleSysadmin ? ' sidebar-nav-item--disabled' : ''}`}
            onClick={() => visibleSysadmin && handleGroupClick(sysadminGroup)}
            title={visibleSysadmin ? '系統管理' : '僅管理員可使用'}
          >
            <span className={`tab-icon ${sysadminGroup.iconClass}`}>{sysadminGroup.icon}</span>
            <span className="sidebar-nav-label">{sysadminGroup.label}</span>
          </button>

        </div>

        {/* Bottom: user + AI settings */}
        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-ai-btn"
            onClick={() => setShowGemini(true)}
            title="AI 模型和 Prompt 模板設定"
          >
            <span>⚙️</span>
            <span>AI 模型和 Prompt 設定</span>
          </button>
          {globalAccount && (
            <div className="sidebar-user">
              <div className="sidebar-user-avatar">
                {globalAccount.label.charAt(0).toUpperCase()}
              </div>
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{globalAccount.label}</span>
                <button
                  type="button"
                  className="sidebar-logout-btn"
                  onClick={handleGlobalAccountClear}
                >
                  登出
                </button>
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* ── Main area ── */}
      <div className="app-main">
        {/* Topbar */}
        <div className="app-topbar">
          <div className="app-topbar-left">
            <span className="app-topbar-title">{currentPageLabel}</span>
            {currentSubtab && (
              <span className="app-topbar-group">
                <span className="app-topbar-sep">›</span>
                {currentGroup?.label}
              </span>
            )}
          </div>
          <p className="app-topbar-desc">{currentDescription}</p>
        </div>

        {/* Page content */}
        {(currentGroup?.id === 'color-game' && (effectiveTab === 'gs-bonusv2' || effectiveTab === 'gs-imgcompare')) ? (
          <>
            {effectiveTab === 'gs-bonusv2' && <GsBonusV2Page />}
            {effectiveTab === 'gs-imgcompare' && <GsImgComparePage />}
          </>
        ) : (
          <main className="main-content">
            {currentGroup?.id === 'jira' && <JiraPage account={globalAccount} allowedModes={allowedJiraModes} />}
            {currentGroup?.id === 'lark' && <LarkPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm' && <OsmPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'machinetest' && <MachineTestPage account={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'imagecheck' && <ImageCheckPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm-config' && <OsmConfigComparePage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'autospin' && <AutoSpinPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'url-pool' && <UrlPoolPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'scripted-bet' && <ScriptedBetPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'jackpot' && <JackpotPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm-uat' && <OsmUatPage />}
            {currentGroup?.id === 'settings' && effectiveTab === 'local-agent' && <LocalAgentPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'history' && <HistoryPage />}
            {currentGroup?.id === 'color-game' && effectiveTab === 'gs-logchecker' && <GsLogCheckerPage />}
            {currentGroup?.id === 'sysadmin' && <SystemAdminPage />}
          </main>
        )}
      </div>

      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {showGemini && <GeminiSettingsModal onClose={() => setShowGemini(false)} />}
      {!authChecking && !globalAccount && (
        <AuthLoginModal onLogin={handleGlobalAccountSelect} />
      )}

      <AiAgentMonitorWidget />
    </div>
  )
}

export default App
