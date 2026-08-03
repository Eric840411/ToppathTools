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
import { DashboardPage } from './pages/DashboardPage'
import { GsImgComparePage } from './pages/gs/GsImgComparePage'
import { GsLogCheckerPage } from './pages/gs/GsLogCheckerPage'
import { GsBonusV2Page } from './pages/gs/GsBonusV2Page'
import { SystemAdminPage } from './pages/SystemAdminPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { UiScreenshotPage } from './pages/UiScreenshotPage'
import { DiscordNotifySettingsPage } from './pages/DiscordNotifySettingsPage'
import { CultivationLeaderboardPage } from './pages/CultivationLeaderboardPage'
import { MeterReconcilePage } from './pages/MeterReconcilePage'
import { EgmDayCountPage } from './pages/EgmDayCountPage'
import ChangelogModal from './components/ChangelogModal'
import GeminiSettingsModal from './components/GeminiSettingsModal'
import AiAgentMonitorWidget from './components/AiAgentMonitorWidget'
import { XianxiaIcon, type XianxiaIconName } from './components/XianxiaIcon'
import { type AccountInfo } from './components/JiraAccountModal'
import { AuthLoginModal } from './components/AuthLoginModal'
import { APP_VERSION } from './version'
import { fetchAuthAccount, loadGlobalAccount, logoutAuthAccount, saveGlobalAccount } from './authSession'
import './App.css'
import './xianxia-complete.css'

type TabId = 'jira' | 'lark' | 'osm' | 'machinetest' | 'imagecheck' | 'history'
  | 'gs-imgcompare' | 'gs-logchecker' | 'gs-bonusv2' | 'osm-config' | 'autospin' | 'url-pool' | 'osm-uat' | 'jackpot'
  | 'scripted-bet' | 'local-agent' | 'sysadmin' | 'changelog' | 'knowledge' | 'dashboard' | 'ui-screenshot' | 'discord-notify' | 'meter-reconcile' | 'egm-daycount' | 'cultivation-board'
type GroupId = 'dashboard' | 'jira' | 'lark' | 'osm-tools' | 'color-game' | 'settings' | 'history' | 'sysadmin' | 'changelog' | 'knowledge' | 'discord-notify' | 'cultivation-board'

type SubTab = {
  id: TabId
  label: string
  /** 太玄道樞主題名稱（design/xianxia 分支）——顯示為主要標籤，原本 label 降為副標，保留辨識度 */
  themeLabel?: string
  icon: string
  iconClass: string
  description: string
}

type Group = {
  id: GroupId
  label: string
  /** 太玄道樞主題名稱（design/xianxia 分支）——顯示為主要標籤，原本 label 降為副標，保留辨識度 */
  themeLabel?: string
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
    themeLabel: '卷宗管理',
    icon: 'J',
    iconClass: 'tab-icon--jira',
    tab: 'jira',
    description: '從試算表資料建立 Issue、新增評論、切換狀態（支援 QA / PM 模式切換）',
  },
  {
    id: 'lark',
    label: 'TestCase 生成',
    themeLabel: '試煉手札',
    icon: 'L',
    iconClass: 'tab-icon--lark',
    tab: 'lark',
    description: '輸入規格書 URL，AI 自動生成測試案例並比對',
  },
  {
    id: 'osm-tools',
    label: 'OSM Tools',
    themeLabel: '靈機巡檢',
    icon: 'O',
    iconClass: 'tab-icon--osm',
    subtabs: [
      {
        id: 'osm',
        label: 'OSM 版號同步',
        themeLabel: '靈脈校準',
        icon: 'O',
        iconClass: 'tab-icon--osm',
        description: '即時同步各渠道機台版本，並解析 ImageRecon 週報',
      },
      {
        id: 'machinetest',
        label: '機台自動化測試',
        themeLabel: '試煉玉簡',
        icon: 'M',
        iconClass: 'tab-icon--machinetest',
        description: '批量測試機台進入、推流、Spin、音頻、退出',
      },
      {
        id: 'imagecheck',
        label: '圖片刪除驗證',
        themeLabel: '幻影勘察',
        icon: 'I',
        iconClass: 'tab-icon--imagecheck',
        description: '貼上已刪除圖片清單 + 前端 URL，在 Toppath 內嵌虛擬瀏覽器操作遊戲，自動驗證圖片是否仍被載入',
      },
      {
        id: 'osm-config',
        label: 'Config 比對',
        themeLabel: '陣圖比對',
        icon: 'C',
        iconClass: 'tab-icon--osm',
        description: '貼上線上 URL（含 token），自動擷取 serverCfg.js 並與模板深層比對，快速確認更版後設定是否正確',
      },
      {
        id: 'autospin',
        label: 'AutoSpin',
        themeLabel: '傀儡監院',
        icon: 'A',
        iconClass: 'tab-icon--machinetest',
        description: '多機台自動化持續 Spin：設定遊戲 URL、RTMP 串流、OpenCV 模板偵測，即時監控 Log 與截圖',
      },
      {
        id: 'url-pool',
        label: 'URL 帳號池',
        themeLabel: '靈脈調度',
        icon: 'U',
        iconClass: 'tab-icon--jira',
        description: '管理共用 Token URL 帳號池，即時查看使用狀態，一鍵使用 / 釋放',
      },
      {
        id: 'scripted-bet',
        label: '腳本化投注紀錄',
        themeLabel: '傀儡演武',
        icon: 'S',
        iconClass: 'tab-icon--colorgame',
        description: '依序領取 URL 帳號，進入指定機台隨機 Spin，退出成功後關閉視窗並換下一個帳號。',
      },
      {
        id: 'jackpot',
        label: 'Jackpot 監控',
        themeLabel: '天財監守',
        icon: 'J',
        iconClass: 'tab-icon--colorgame',
        description: '每 15 秒自動拉取 Jackpot 獎池數據，位數異常或數值暴增自動推送 Lark 告警',
      },
      {
        id: 'osm-uat',
        label: 'UAT 整合測試',
        themeLabel: '總綱試煉',
        icon: 'T',
        iconClass: 'tab-icon--machinetest',
        description: '從 Lark 拉取 TC，自動執行後台 UAT 測試（排序/Bonus/Export/Config），即時串流進度與截圖',
      },
      {
        id: 'ui-screenshot',
        label: 'UI 解析度截圖',
        themeLabel: '萬象顯影',
        icon: 'U',
        iconClass: 'tab-icon--imagecheck',
        description: '批量對 H5 遊戲進行多解析度截圖，從 Lark Wiki 讀取 gmid，截圖結果回寫至 Wiki TABLE',
      },
      {
        id: 'meter-reconcile',
        label: 'Performance Meter 對帳',
        themeLabel: '天秤校帳',
        icon: 'P',
        iconClass: 'tab-icon--osm',
        description: 'OSM / GCP EGM Metering 對 Game Record + Jackpot Abnormality，驗證 Coin Out 是否一致',
      },
      {
        id: 'egm-daycount',
        label: 'Egm DayCount 對帳',
        themeLabel: '日冊校帳',
        icon: 'E',
        iconClass: 'tab-icon--osm',
        description: '比對 Egm DayCount 彙總報表與 User Detail 逐筆列回推加總是否一致',
      },
    ],
  },
  {
    id: 'color-game',
    label: 'Game Show',
    themeLabel: '幻境試煉',
    icon: 'G',
    iconClass: 'tab-icon--colorgame',
    subtabs: [
      {
        id: 'gs-imgcompare',
        label: '圖片比對',
        themeLabel: '幻境勘影',
        icon: 'C',
        iconClass: 'tab-icon--imagecheck',
        description: '輸入兩個遊戲 URL，自動攔截所有載入圖片，進行視覺 Diff 與資源大小比對',
      },
      {
        id: 'gs-logchecker',
        label: 'Log 攔截工具',
        themeLabel: '密探竊訊',
        icon: 'L',
        iconClass: 'tab-icon--history',
        description: '注入腳本攔截前端 /api/log 請求，驗證欄位完整性並匯出 CSV',
      },
      {
        id: 'gs-bonusv2',
        label: 'Bonus V2 統計',
        themeLabel: '骰數天算',
        icon: 'B',
        iconClass: 'tab-icon--colorgame',
        description: '攔截 Bonus V2 遊戲 WebSocket，統計各骰型機率並與理論值比對',
      },
    ],
  },
]

const dashboardGroup: Group = {
  id: 'dashboard',
  label: 'Dashboard',
  themeLabel: '天機總覽',
  icon: 'D',
  iconClass: 'tab-icon--machinetest',
  tab: 'dashboard',
  description: '登入後首頁，快速掌握使用人數、任務與服務壓力',
}

const historyGroup: Group = {
  id: 'history',
  label: '操作歷史紀錄',
  themeLabel: '行跡天錄',
  icon: 'H',
  iconClass: 'tab-icon--history',
  tab: 'history',
  description: '查看所有功能的操作紀錄，支援今日 / 3 天 / 7 天篩選',
}

const knowledgeGroup: Group = {
  id: 'knowledge',
  label: '知識庫',
  themeLabel: '藏經閣',
  icon: 'K',
  iconClass: 'tab-icon--lark',
  tab: 'knowledge',
  description: '預存規格書、已知問題清單等文件，供批次評論 / TestCase 生成 AI 調用',
}

const settingsGroup: Group = {
  id: 'settings',
  label: 'Local Agent',
  themeLabel: '傀儡召喚',
  icon: 'A',
  iconClass: 'tab-icon--machinetest',
  tab: 'local-agent',
  description: '下載與管理 Toppath Local Agent，讓 MachineTest 與 Scripted Bet 在使用者本機執行。',
}

const discordNotifyGroup: Group = {
  id: 'discord-notify',
  label: 'Discord 通知',
  themeLabel: '靈訊符籙',
  icon: 'D',
  iconClass: 'tab-icon--history',
  tab: 'discord-notify',
  description: '設定 AutoSpin 執行狀態即時彙報用的 Discord Webhook',
}

const cultivationBoardGroup: Group = {
  id: 'cultivation-board',
  label: '境界排行榜',
  themeLabel: '群英榜',
  icon: 'C',
  iconClass: 'tab-icon--history',
  tab: 'cultivation-board',
  description: '依累計登入天數排名，看看誰的境界最高',
}

const sysadminGroup: Group = {
  id: 'sysadmin',
  label: '系統管理',
  themeLabel: '太玄樞機',
  icon: 'S',
  iconClass: 'tab-icon--history',
  tab: 'sysadmin',
  description: '管理帳號與各角色的功能頁面權限',
}



function NavLabel({ group }: { group: Group }) {
  if (!group.themeLabel) return <span className="sidebar-nav-label">{group.label}</span>
  return (
    <span className="sidebar-nav-label sidebar-nav-label--dual">
      <span className="sidebar-nav-label-theme">{group.themeLabel}</span>
      <span className="sidebar-nav-label-sub">{group.label}</span>
    </span>
  )
}

function navIconName(id: string, iconClass: string): XianxiaIconName {
  if (id === 'dashboard') return 'overview'
  if (id === 'history') return 'history'
  if (id === 'knowledge') return 'knowledge'
  if (id === 'discord-notify') return 'notification'
  if (id === 'settings' || id === 'sysadmin' || id.includes('config')) return 'settings'
  if (id === 'jira') return 'document'
  if (id === 'lark') return 'ai'
  if (id === 'color-game' || iconClass.includes('colorgame')) return 'compare'
  if (iconClass.includes('imagecheck') || iconClass.includes('osm')) return 'monitor'
  if (iconClass.includes('machinetest')) return 'ai'
  return 'guide'
}

function App() {
  const [activeGroup, setActiveGroup] = useState<GroupId>('dashboard')
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const [showChangelog, setShowChangelog] = useState(false)
  const [showGemini, setShowGemini] = useState(false)
  const [navQuery, setNavQuery] = useState('')
  const [realm, setRealm] = useState<'moon' | 'ember'>(() => localStorage.getItem('xianxia-realm') === 'ember' ? 'ember' : 'moon')
  const [globalAccount, setGlobalAccount] = useState<AccountInfo | null>(loadGlobalAccount)
  const [authChecking, setAuthChecking] = useState(true)
  const [permissions, setPermissions] = useState<string[]>([])
  const [cultivation, setCultivation] = useState<{ level: string; activeDays: number; nextLevel: string | null; nextThreshold: number | null } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.realm = realm
    localStorage.setItem('xianxia-realm', realm)
  }, [realm])

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

  // 帳號境界稱號（自動依累計登入天數推進），登入後抓一次即可，不需要輪詢
  useEffect(() => {
    if (!globalAccount) { setCultivation(null); return }
    let cancelled = false
    fetch('/api/account/cultivation')
      .then(r => r.json())
      .then((d: { ok: boolean; level?: string; activeDays?: number; nextLevel?: string | null; nextThreshold?: number | null }) => {
        if (cancelled || !d.ok) return
        setCultivation({ activeDays: d.activeDays!, level: d.level!, nextLevel: d.nextLevel ?? null, nextThreshold: d.nextThreshold ?? null })
      })
      .catch(() => {})
    return () => { cancelled = true }
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
    if (tabId === 'dashboard') return true
    if (globalAccount.role === 'admin') return true
    // 'jira' tab is accessible if user has either jira-qa, jira-pm, or jira-update
    if (tabId === 'jira') return permissions.includes('jira-qa') || permissions.includes('jira-pm') || permissions.includes('jira-update')
    if (tabId === 'scripted-bet') return permissions.includes('machinetest') || permissions.includes('url-pool')
    return permissions.includes(tabId)
  }

  const allowedJiraModes = globalAccount?.role === 'admin'
    ? ['qa', 'pm', 'jira-update']
    : [
        ...(permissions.includes('jira-qa') ? ['qa'] : []),
        ...(permissions.includes('jira-pm') ? ['pm'] : []),
        ...(permissions.includes('jira-update') ? ['jira-update'] : []),
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
  const visibleKnowledge = filterGroup(knowledgeGroup)
  const visibleDiscordNotify = filterGroup(discordNotifyGroup)
  const visibleCultivationBoard = filterGroup(cultivationBoardGroup)
  const visibleSysadmin = canAccess('sysadmin') ? sysadminGroup : null
  const allVisible = [dashboardGroup, ...visibleGroups, ...(visibleSettings ? [visibleSettings] : []), ...(visibleHistory ? [visibleHistory] : []), ...(visibleKnowledge ? [visibleKnowledge] : []), ...(visibleDiscordNotify ? [visibleDiscordNotify] : []), ...(visibleCultivationBoard ? [visibleCultivationBoard] : []), ...(visibleSysadmin ? [visibleSysadmin] : [])]

  // Redirect activeGroup/activeTab if current selection is no longer accessible
  const currentGroup = allVisible.find(g => g.id === activeGroup) ?? allVisible[0]
  const currentTab = currentGroup?.subtabs?.find(s => s.id === activeTab)
  // If current tab is not in visible subtabs, reset to first subtab of current group
  const effectiveTab = currentTab ? activeTab : (currentGroup?.subtabs?.[0]?.id ?? currentGroup?.tab ?? activeTab)

  const currentSubtab = currentGroup?.subtabs?.find(s => s.id === effectiveTab)
  const currentDescription = currentSubtab?.description ?? currentGroup?.description ?? ''
  const currentPageLabel = currentSubtab?.label ?? currentGroup?.label ?? ''
  const currentThemeLabel = currentSubtab?.themeLabel ?? currentGroup?.themeLabel ?? currentPageLabel
  const searchResults = navQuery.trim()
    ? allVisible.flatMap(group => {
        const entries = group.subtabs?.length
          ? group.subtabs.map(sub => ({ group, sub, themeLabel: sub.themeLabel ?? sub.label, label: sub.label }))
          : [{ group, sub: null, themeLabel: group.themeLabel ?? group.label, label: group.label }]
        const needle = navQuery.trim().toLowerCase()
        return entries.filter(entry => `${entry.themeLabel} ${entry.label}`.toLowerCase().includes(needle))
      }).slice(0, 7)
    : []

  useEffect(() => {
    if (!globalAccount || !currentPageLabel) return
    let stopped = false
    const sendHeartbeat = async () => {
      try {
        await fetch('/api/dashboard/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: currentPageLabel }),
        })
      } catch {
        // Dashboard heartbeat is best-effort and should never interrupt user work.
      }
    }
    void sendHeartbeat()
    const timer = window.setInterval(() => {
      if (!stopped) void sendHeartbeat()
    }, 25000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [globalAccount, currentPageLabel])

  return (
    <div className="app">
      {/* ── Sidebar ── */}
      <nav className="app-sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-inner">
            <span className="brand-dot" />
            <div className="sidebar-logo-text">
              <span className="sidebar-brand-name">太玄道樞</span>
            </div>
          </div>
          <p className="sidebar-sub">TOPPATH TOOLS</p>
        </div>

        {/* Nav items */}
        <div className="sidebar-nav">
          <div className="sidebar-section-label">洞天總覽</div>
          <button
            type="button"
            className={`sidebar-nav-item${currentGroup?.id === dashboardGroup.id ? ' sidebar-nav-item--active' : ''}`}
            onClick={() => handleGroupClick(dashboardGroup)}
          >
            <span className={`tab-icon ${dashboardGroup.iconClass}`}><XianxiaIcon name="overview" size={18} /></span>
            <NavLabel group={dashboardGroup} />
          </button>
          {visibleGroups.map((group) => (
            <div key={group.id}>
              <button
                type="button"
                className={`sidebar-nav-item${currentGroup?.id === group.id ? ' sidebar-nav-item--active' : ''}`}
                onClick={() => handleGroupClick(group)}
              >
                <span className={`tab-icon ${group.iconClass}`}><XianxiaIcon name={navIconName(group.id, group.iconClass)} size={18} /></span>
                <NavLabel group={group} />
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
                      <span className={`tab-icon sub-tab-icon ${sub.iconClass}`}><XianxiaIcon name={navIconName(sub.id, sub.iconClass)} size={16} /></span>
                      {sub.themeLabel ? (
                        <span className="sidebar-nav-label sidebar-nav-label--dual">
                          <span className="sidebar-nav-label-theme">{sub.themeLabel}</span>
                          <span className="sidebar-nav-label-sub">{sub.label}</span>
                        </span>
                      ) : sub.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="sidebar-divider" />
          <div className="sidebar-section-label">宗門維運</div>

          {visibleSettings && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === settingsGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(settingsGroup)}
            >
              <span className={`tab-icon ${settingsGroup.iconClass}`}><XianxiaIcon name="settings" size={18} /></span>
              <NavLabel group={settingsGroup} />
            </button>
          )}

          {visibleHistory && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === historyGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(historyGroup)}
            >
              <span className={`tab-icon ${historyGroup.iconClass}`}><XianxiaIcon name="history" size={18} /></span>
              <NavLabel group={historyGroup} />
            </button>
          )}

          {visibleKnowledge && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === knowledgeGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(knowledgeGroup)}
            >
              <span className={`tab-icon ${knowledgeGroup.iconClass}`}><XianxiaIcon name="knowledge" size={18} /></span>
              <NavLabel group={knowledgeGroup} />
            </button>
          )}

          {visibleDiscordNotify && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === discordNotifyGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(discordNotifyGroup)}
            >
              <span className={`tab-icon ${discordNotifyGroup.iconClass}`}><XianxiaIcon name="notification" size={18} /></span>
              <NavLabel group={discordNotifyGroup} />
            </button>
          )}

          {visibleCultivationBoard && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === cultivationBoardGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(cultivationBoardGroup)}
            >
              <span className={`tab-icon ${cultivationBoardGroup.iconClass}`}><XianxiaIcon name="monitor" size={18} /></span>
              <NavLabel group={cultivationBoardGroup} />
            </button>
          )}

          <button
            type="button"
            className={`sidebar-nav-item${currentGroup?.id === sysadminGroup.id ? ' sidebar-nav-item--active' : ''}${!visibleSysadmin ? ' sidebar-nav-item--disabled' : ''}`}
            onClick={() => visibleSysadmin && handleGroupClick(sysadminGroup)}
            title={visibleSysadmin ? '系統管理' : '僅管理員可使用'}
          >
            <span className={`tab-icon ${sysadminGroup.iconClass}`}><XianxiaIcon name="settings" size={18} /></span>
            <NavLabel group={sysadminGroup} />
          </button>

        </div>

        {/* Bottom: user + AI settings */}
        <div className="sidebar-bottom">
          <div className="sidebar-realm-switch" aria-label="背景境界">
            <span>背景境界</span>
            <div>
              <button type="button" className={realm === 'moon' ? 'is-active' : ''} onClick={() => setRealm('moon')}>玄月</button>
              <button type="button" className={realm === 'ember' ? 'is-active' : ''} onClick={() => setRealm('ember')}>赤霄</button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowChangelog(true)}
            className="sidebar-version-link"
            title="查看更新日誌"
          >
            <span>更新日誌</span>
            <strong>v{APP_VERSION}</strong>
          </button>
          <button
            type="button"
            className="sidebar-ai-btn"
            onClick={() => setShowGemini(true)}
            title="AI 模型和 Prompt 模板設定"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span className="sidebar-ai-btn-label">
              <span className="sidebar-nav-label-theme">陣法設定</span>
              <span className="sidebar-nav-label-sub">AI 模型和 Prompt 設定</span>
            </span>
          </button>
          {globalAccount && (
            <div className="sidebar-user">
              <div className="sidebar-user-avatar">
                {globalAccount.label.charAt(0).toUpperCase()}
              </div>
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{globalAccount.label}</span>
                {cultivation && (
                  <span
                    className="sidebar-user-cultivation"
                    title={cultivation.nextLevel ? `已登入 ${cultivation.activeDays} 天，還差 ${cultivation.nextThreshold! - cultivation.activeDays} 天晉升「${cultivation.nextLevel}」` : `已登入 ${cultivation.activeDays} 天，已達最高境界`}
                  >
                    {cultivation.level}
                  </span>
                )}
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
          <div className="app-topbar-left" title={currentDescription}>
            <span className="app-topbar-kicker">TAIXUAN CONTROL CENTER</span>
            <span className="app-topbar-title">{currentThemeLabel}</span>
            <span className="app-topbar-group">{currentPageLabel}</span>
          </div>
          <div className="app-global-search">
            <span className="app-global-search-icon" aria-hidden="true" />
            <input
              type="search"
              aria-label="搜尋工具"
              placeholder="搜尋任務、卷宗或術式"
              value={navQuery}
              onChange={event => setNavQuery(event.target.value)}
            />
            {searchResults.length > 0 && (
              <div className="app-global-search-results">
                {searchResults.map(entry => (
                  <button
                    type="button"
                    key={`${entry.group.id}-${entry.sub?.id ?? 'root'}`}
                    onClick={() => {
                      setActiveGroup(entry.group.id)
                      setActiveTab(entry.sub?.id ?? entry.group.tab ?? activeTab)
                      setNavQuery('')
                    }}
                  >
                    <span>{entry.themeLabel}</span>
                    <small>{entry.label}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="app-topbar-status"><span />靈脈穩定</div>
          <div className="app-topbar-seal" aria-hidden="true"><XianxiaIcon name="overview" size={28} /></div>
        </div>

        {/* Page content — 整段等 globalAccount 確定登入後才掛載，避免 Dashboard 等頁面
            在登入完成前就先發出一次一定會失敗的 unauthenticated API 請求，導致登入完成後
            畫面短暫殘留這次失敗的錯誤訊息（要等下一次 30 秒輪詢才會自動清掉） */}
        {globalAccount && ((currentGroup?.id === 'color-game' && (effectiveTab === 'gs-bonusv2' || effectiveTab === 'gs-imgcompare')) ? (
          <>
            {effectiveTab === 'gs-bonusv2' && <GsBonusV2Page />}
            {effectiveTab === 'gs-imgcompare' && <GsImgComparePage />}
          </>
        ) : (
          <main className="main-content">
            {currentGroup?.id === 'dashboard' && <DashboardPage />}
            {currentGroup?.id === 'jira' && <JiraPage account={globalAccount} allowedModes={allowedJiraModes} isAdmin={globalAccount?.role === 'admin'} />}
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
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'ui-screenshot' && <UiScreenshotPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'meter-reconcile' && <MeterReconcilePage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'egm-daycount' && <EgmDayCountPage />}
            {currentGroup?.id === 'settings' && effectiveTab === 'local-agent' && <LocalAgentPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'discord-notify' && <DiscordNotifySettingsPage />}
            {currentGroup?.id === 'cultivation-board' && <CultivationLeaderboardPage currentEmail={globalAccount?.email ?? null} />}
            {currentGroup?.id === 'history' && <HistoryPage />}
            {currentGroup?.id === 'color-game' && effectiveTab === 'gs-logchecker' && <GsLogCheckerPage />}
            {currentGroup?.id === 'sysadmin' && <SystemAdminPage />}
            {currentGroup?.id === 'knowledge' && <KnowledgePage />}
          </main>
        ))}
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
