import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
// 26 個功能頁面原本全部靜態 import，打包成單一 1.35MB 的 entry chunk，不管使用者
// 開哪個分頁都要整包抓完+parse+執行完才能顯示任何東西。改成 React.lazy 依路由拆
// chunk，只有 DashboardPage（首頁常駐）維持靜態 import；跟 CodeX 討論後定案先只做
// route-level 這一層，不動 manualChunks（2026-08-18）。
import { DashboardPage } from './pages/DashboardPage'
const OsmPage = lazy(() => import('./pages/OsmPage').then(m => ({ default: m.OsmPage })))
const OsmConfigComparePage = lazy(() => import('./pages/OsmConfigComparePage').then(m => ({ default: m.OsmConfigComparePage })))
const AutoSpinPage = lazy(() => import('./pages/AutoSpinPage').then(m => ({ default: m.AutoSpinPage })))
const JiraPage = lazy(() => import('./pages/JiraPage').then(m => ({ default: m.JiraPage })))
const LarkPage = lazy(() => import('./pages/LarkPage').then(m => ({ default: m.LarkPage })))
const MachineTestPage = lazy(() => import('./pages/MachineTestPage').then(m => ({ default: m.MachineTestPage })))
const ScriptedBetPage = lazy(() => import('./pages/ScriptedBetPage').then(m => ({ default: m.ScriptedBetPage })))
const LocalAgentPage = lazy(() => import('./pages/LocalAgentPage').then(m => ({ default: m.LocalAgentPage })))
const HistoryPage = lazy(() => import('./pages/HistoryPage').then(m => ({ default: m.HistoryPage })))
const ImageCheckPage = lazy(() => import('./pages/ImageCheckPage').then(m => ({ default: m.ImageCheckPage })))
const UrlPoolPage = lazy(() => import('./pages/UrlPoolPage').then(m => ({ default: m.UrlPoolPage })))
const JackpotPage = lazy(() => import('./pages/JackpotPage').then(m => ({ default: m.JackpotPage })))
const OsmUatPage = lazy(() => import('./pages/OsmUatPage').then(m => ({ default: m.OsmUatPage })))
const GsImgComparePage = lazy(() => import('./pages/gs/GsImgComparePage').then(m => ({ default: m.GsImgComparePage })))
const GsLogCheckerPage = lazy(() => import('./pages/gs/GsLogCheckerPage').then(m => ({ default: m.GsLogCheckerPage })))
const GsBonusV2Page = lazy(() => import('./pages/gs/GsBonusV2Page').then(m => ({ default: m.GsBonusV2Page })))
const SystemAdminPage = lazy(() => import('./pages/SystemAdminPage').then(m => ({ default: m.SystemAdminPage })))
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then(m => ({ default: m.KnowledgePage })))
const UiScreenshotPage = lazy(() => import('./pages/UiScreenshotPage').then(m => ({ default: m.UiScreenshotPage })))
const DiscordNotifySettingsPage = lazy(() => import('./pages/DiscordNotifySettingsPage').then(m => ({ default: m.DiscordNotifySettingsPage })))
const CultivationLeaderboardPage = lazy(() => import('./pages/CultivationLeaderboardPage').then(m => ({ default: m.CultivationLeaderboardPage })))
const XianxiaQuotesPage = lazy(() => import('./pages/XianxiaQuotesPage').then(m => ({ default: m.XianxiaQuotesPage })))
import { BREAKTHROUGH_REALMS, CultivationBreakthroughOverlay } from './components/CultivationBreakthroughOverlay'
const MeterReconcilePage = lazy(() => import('./pages/MeterReconcilePage').then(m => ({ default: m.MeterReconcilePage })))
const EgmDayCountPage = lazy(() => import('./pages/EgmDayCountPage').then(m => ({ default: m.EgmDayCountPage })))
const WeeklyReportPage = lazy(() => import('./pages/WeeklyReportPage').then(m => ({ default: m.WeeklyReportPage })))
import ChangelogModal from './components/ChangelogModal'
import GeminiSettingsModal from './components/GeminiSettingsModal'
import AiAgentMonitorWidget from './components/AiAgentMonitorWidget'
import { XianxiaIcon, type XianxiaIconName } from './components/XianxiaIcon'
import { type AccountInfo } from './components/JiraAccountModal'
import { AuthLoginModal } from './components/AuthLoginModal'
import { APP_VERSION } from './version'
import { fetchAuthAccount, loadGlobalAccount, logoutAuthAccount, saveGlobalAccount } from './authSession'
import './App.css'
// xianxia-complete.css 不在這裡靜態 import——它現在放在 public/，由下面的
// applyThemeMode() 在執行期動態插入/移除 <link>，才能真正做到「普通版/修仙版」
// 切換（靜態 import 會被打包進主 CSS，永遠都在，沒辦法整份關掉）

type TabId = 'jira' | 'lark' | 'osm' | 'machinetest' | 'imagecheck' | 'history'
  | 'gs-imgcompare' | 'gs-logchecker' | 'gs-bonusv2' | 'osm-config' | 'autospin' | 'url-pool' | 'osm-uat' | 'jackpot'
  | 'scripted-bet' | 'local-agent' | 'sysadmin' | 'changelog' | 'knowledge' | 'dashboard' | 'ui-screenshot' | 'discord-notify' | 'meter-reconcile' | 'egm-daycount' | 'cultivation-board' | 'xianxia-quotes' | 'weekly-report'
type GroupId = 'dashboard' | 'jira' | 'lark' | 'osm-tools' | 'color-game' | 'settings' | 'history' | 'sysadmin' | 'changelog' | 'knowledge' | 'discord-notify' | 'cultivation-board' | 'xianxia-quotes' | 'weekly-report'

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
    id: 'weekly-report',
    label: '週報彙整',
    themeLabel: '行跡呈報',
    icon: 'W',
    iconClass: 'tab-icon--lark',
    tab: 'weekly-report',
    description: '貼上本週 Lark Base 網址，選擇成員與主要專案，混寫 Jira 摘要與手記後送出一列紀錄',
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

const xianxiaQuotesGroup: Group = {
  id: 'xianxia-quotes',
  label: '每日仙語管理',
  themeLabel: '每日仙語',
  icon: 'Q',
  iconClass: 'tab-icon--history',
  tab: 'xianxia-quotes',
  description: '管理 Dashboard 每日顯示的仙語語錄庫，可手動新增或用 AI 建議候選句子',
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



function NavLabel({ group, classic }: { group: Group; classic?: boolean }) {
  if (!group.themeLabel || classic) return <span className="sidebar-nav-label">{group.label}</span>
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
  const [themeMode, setThemeMode] = useState<'classic' | 'xianxia'>(() => localStorage.getItem('toppath-theme-mode') === 'xianxia' ? 'xianxia' : 'classic')
  const [systemHealthy, setSystemHealthy] = useState(true)
  const [globalAccount, setGlobalAccount] = useState<AccountInfo | null>(loadGlobalAccount)
  const [authChecking, setAuthChecking] = useState(true)
  const [permissions, setPermissions] = useState<string[]>([])
  const [cultivation, setCultivation] = useState<{
    level: string; levelIndex: number; activeDays: number; nextLevel: string | null; nextThreshold: number | null
    // 修為系列（v4.79.0）：境界仍只看 activeDays，這幾個只做呈現，不影響升級
    totalActions: number; todayActions: number; epithet: string
    questDone: string | null; nextQuest: { name: string; at: number } | null
  } | null>(null)
  const [breakthroughLevel, setBreakthroughLevel] = useState<string | null>(null)
  const [breakthroughPreviewHold] = useState(() => new URLSearchParams(window.location.search).get('breakthrough-hold') === '1')
  const closeBreakthrough = useCallback(() => setBreakthroughLevel(null), [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const preview = params.get('breakthrough-preview')
    if (!preview) return
    const previewRealm = BREAKTHROUGH_REALMS.find(realm => realm.slug === preview || realm.name === preview)
    if (previewRealm) setBreakthroughLevel(previewRealm.name)
    params.delete('breakthrough-preview')
    params.delete('breakthrough-hold')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.realm = realm
    localStorage.setItem('xianxia-realm', realm)
  }, [realm])

  // 普通版／修仙版切換——xianxia-complete.css 放在 public/，這裡動態插入/移除
  // <link> 才能真的整份關掉（原本用靜態 import 會被打包進主 CSS，永遠都在）
  useEffect(() => {
    document.documentElement.dataset.themeMode = themeMode
    localStorage.setItem('toppath-theme-mode', themeMode)
    const LINK_ID = 'xianxia-theme-link'
    const FONT_ID = 'xianxia-font-link'
    const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null
    const existingFont = document.getElementById(FONT_ID) as HTMLLinkElement | null
    if (themeMode === 'xianxia') {
      if (!existing) {
        const link = document.createElement('link')
        link.id = LINK_ID
        link.rel = 'stylesheet'
        link.href = '/xianxia-complete.css'
        document.head.appendChild(link)
      }
      // 修仙版整份 CSS 都在用 --xx-serif（"Noto Serif TC"），但先前從來沒有載入過這個
      // 字體——有裝的機器看起來是對的，沒裝的會一路 fallback 到新細明體，等於每個人
      // 看到的修仙版長得不一樣。跟著主題一起掛，普通版不用付這個成本。
      // 載不到（離線／被擋）時就是退回本機字體，跟先前行為相同，不會更糟。
      if (!existingFont) {
        const font = document.createElement('link')
        font.id = FONT_ID
        font.rel = 'stylesheet'
        font.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600;700;900&display=swap'
        document.head.appendChild(font)
      }
    } else {
      existing?.remove()
      existingFont?.remove()
    }
  }, [themeMode])

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
      .then((d: {
        ok: boolean; level?: string; levelIndex?: number; activeDays?: number
        nextLevel?: string | null; nextThreshold?: number | null
        totalActions?: number; todayActions?: number; epithet?: string
        questDone?: string | null; nextQuest?: { name: string; at: number } | null
      }) => {
        if (cancelled || !d.ok) return
        const levelIndex = d.levelIndex ?? BREAKTHROUGH_REALMS.findIndex(realm => realm.name === d.level)
        const info = {
          activeDays: d.activeDays!, level: d.level!, levelIndex: Math.max(0, levelIndex),
          nextLevel: d.nextLevel ?? null, nextThreshold: d.nextThreshold ?? null,
          // 舊版後端沒有這幾個欄位，給預設值讓畫面不會炸——這支在部署過程中
          // 可能短暫遇到前端新、後端舊的狀態
          totalActions: d.totalActions ?? 0, todayActions: d.todayActions ?? 0,
          epithet: d.epithet ?? '閉關中',
          questDone: d.questDone ?? null, nextQuest: d.nextQuest ?? null,
        }
        setCultivation(info)

        const storageKey = `toppath-cultivation-seen:${globalAccount.email}`
        const storedIndex = localStorage.getItem(storageKey)
        if (storedIndex === null || !Number.isFinite(Number(storedIndex))) {
          // Existing accounts establish a baseline silently; future promotions animate once.
          localStorage.setItem(storageKey, String(info.levelIndex))
        } else {
          const previousIndex = Number(storedIndex)
          if (info.levelIndex > previousIndex) setBreakthroughLevel(info.level)
          if (info.levelIndex !== previousIndex) localStorage.setItem(storageKey, String(info.levelIndex))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [globalAccount])

  function handleGlobalAccountSelect(acc: AccountInfo) {
    setGlobalAccount(acc)
    saveGlobalAccount(acc)
  }
  async function handleGlobalAccountClear() {
    setBreakthroughLevel(null)
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
  const visibleCultivationBoard = themeMode === 'xianxia' ? filterGroup(cultivationBoardGroup) : null
  const visibleXianxiaQuotes = themeMode === 'xianxia' ? filterGroup(xianxiaQuotesGroup) : null
  const visibleSysadmin = canAccess('sysadmin') ? sysadminGroup : null
  const allVisible = [dashboardGroup, ...visibleGroups, ...(visibleSettings ? [visibleSettings] : []), ...(visibleHistory ? [visibleHistory] : []), ...(visibleKnowledge ? [visibleKnowledge] : []), ...(visibleDiscordNotify ? [visibleDiscordNotify] : []), ...(visibleCultivationBoard ? [visibleCultivationBoard] : []), ...(visibleXianxiaQuotes ? [visibleXianxiaQuotes] : []), ...(visibleSysadmin ? [visibleSysadmin] : [])]

  // Redirect activeGroup/activeTab if current selection is no longer accessible
  const currentGroup = allVisible.find(g => g.id === activeGroup) ?? allVisible[0]
  const currentTab = currentGroup?.subtabs?.find(s => s.id === activeTab)
  // If current tab is not in visible subtabs, reset to first subtab of current group
  const effectiveTab = currentTab ? activeTab : (currentGroup?.subtabs?.[0]?.id ?? currentGroup?.tab ?? activeTab)

  const currentSubtab = currentGroup?.subtabs?.find(s => s.id === effectiveTab)
  const currentDescription = currentSubtab?.description ?? currentGroup?.description ?? ''
  const currentPageLabel = currentSubtab?.label ?? currentGroup?.label ?? ''
  const currentThemeLabel = themeMode === 'xianxia' ? (currentSubtab?.themeLabel ?? currentGroup?.themeLabel ?? currentPageLabel) : currentPageLabel
  const searchResults = navQuery.trim()
    ? allVisible.flatMap(group => {
        const entries = group.subtabs?.length
          ? group.subtabs.map(sub => ({ group, sub, themeLabel: themeMode === 'xianxia' ? (sub.themeLabel ?? sub.label) : sub.label, label: sub.label }))
          : [{ group, sub: null, themeLabel: themeMode === 'xianxia' ? (group.themeLabel ?? group.label) : group.label, label: group.label }]
        const needle = navQuery.trim().toLowerCase()
        return entries.filter(entry => `${entry.themeLabel} ${entry.label}`.toLowerCase().includes(needle))
      }).slice(0, 7)
    : []

  useEffect(() => {
    let stopped = false
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health')
        if (!stopped) setSystemHealthy(res.ok)
      } catch {
        if (!stopped) setSystemHealthy(false)
      }
    }
    void checkHealth()
    const timer = window.setInterval(() => { if (!stopped) void checkHealth() }, 30000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])

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
              <span className="sidebar-brand-name">{themeMode === 'classic' ? 'Toppath Tools' : '太玄道樞'}</span>
            </div>
          </div>
          <p className="sidebar-sub">{themeMode === 'classic' ? 'WORKFLOW INTEGRATOR' : 'TOPPATH TOOLS'}</p>
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
            <NavLabel group={dashboardGroup} classic={themeMode === 'classic'} />
          </button>
          {visibleGroups.map((group) => (
            <div key={group.id}>
              <button
                type="button"
                className={`sidebar-nav-item${currentGroup?.id === group.id ? ' sidebar-nav-item--active' : ''}`}
                onClick={() => handleGroupClick(group)}
              >
                <span className={`tab-icon ${group.iconClass}`}><XianxiaIcon name={navIconName(group.id, group.iconClass)} size={18} /></span>
                <NavLabel group={group} classic={themeMode === 'classic'} />
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
                      {sub.themeLabel && themeMode === 'xianxia' ? (
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
              <NavLabel group={settingsGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          {visibleHistory && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === historyGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(historyGroup)}
            >
              <span className={`tab-icon ${historyGroup.iconClass}`}><XianxiaIcon name="history" size={18} /></span>
              <NavLabel group={historyGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          {visibleKnowledge && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === knowledgeGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(knowledgeGroup)}
            >
              <span className={`tab-icon ${knowledgeGroup.iconClass}`}><XianxiaIcon name="knowledge" size={18} /></span>
              <NavLabel group={knowledgeGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          {visibleDiscordNotify && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === discordNotifyGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(discordNotifyGroup)}
            >
              <span className={`tab-icon ${discordNotifyGroup.iconClass}`}><XianxiaIcon name="notification" size={18} /></span>
              <NavLabel group={discordNotifyGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          {visibleCultivationBoard && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === cultivationBoardGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(cultivationBoardGroup)}
            >
              <span className={`tab-icon ${cultivationBoardGroup.iconClass}`}><XianxiaIcon name="monitor" size={18} /></span>
              <NavLabel group={cultivationBoardGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          {visibleXianxiaQuotes && (
            <button
              type="button"
              className={`sidebar-nav-item${currentGroup?.id === xianxiaQuotesGroup.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => handleGroupClick(xianxiaQuotesGroup)}
            >
              <span className={`tab-icon ${xianxiaQuotesGroup.iconClass}`}><XianxiaIcon name="document" size={18} /></span>
              <NavLabel group={xianxiaQuotesGroup} classic={themeMode === 'classic'} />
            </button>
          )}

          <button
            type="button"
            className={`sidebar-nav-item${currentGroup?.id === sysadminGroup.id ? ' sidebar-nav-item--active' : ''}${!visibleSysadmin ? ' sidebar-nav-item--disabled' : ''}`}
            onClick={() => visibleSysadmin && handleGroupClick(sysadminGroup)}
            title={visibleSysadmin ? '系統管理' : '僅管理員可使用'}
          >
            <span className={`tab-icon ${sysadminGroup.iconClass}`}><XianxiaIcon name="settings" size={18} /></span>
            <NavLabel group={sysadminGroup} classic={themeMode === 'classic'} />
          </button>

        </div>

        {/* Bottom: user + AI settings */}
        <div className="sidebar-bottom">
          <div className="sidebar-realm-switch" aria-label="版面模式">
            <span>版面模式</span>
            <div>
              <button type="button" className={themeMode === 'classic' ? 'is-active' : ''} onClick={() => setThemeMode('classic')}>普通版</button>
              <button type="button" className={themeMode === 'xianxia' ? 'is-active' : ''} onClick={() => setThemeMode('xianxia')}>修仙版</button>
            </div>
          </div>
          {themeMode === 'xianxia' && (
            <div className="sidebar-realm-switch" aria-label="背景境界">
              <span>背景境界</span>
              <div>
                <button type="button" className={realm === 'moon' ? 'is-active' : ''} onClick={() => setRealm('moon')}>玄月</button>
                <button type="button" className={realm === 'ember' ? 'is-active' : ''} onClick={() => setRealm('ember')}>赤霄</button>
              </div>
            </div>
          )}
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
            {themeMode === 'classic' ? (
              <span className="sidebar-ai-btn-label"><span className="sidebar-nav-label-sub">AI 模型和 Prompt 設定</span></span>
            ) : (
              <span className="sidebar-ai-btn-label">
                <span className="sidebar-nav-label-theme">陣法設定</span>
                <span className="sidebar-nav-label-sub">AI 模型和 Prompt 設定</span>
              </span>
            )}
          </button>
          {globalAccount && (
            <div className="sidebar-user">
              <div className="sidebar-user-avatar">
                {globalAccount.label.charAt(0).toUpperCase()}
              </div>
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{globalAccount.label}</span>
                {cultivation && themeMode === 'xianxia' && (
                  <div className="sidebar-cultivation">
                    <div className="sidebar-cultivation-row">
                      <span
                        className="sidebar-user-cultivation"
                        title={cultivation.nextLevel ? `已登入 ${cultivation.activeDays} 天，還差 ${cultivation.nextThreshold! - cultivation.activeDays} 天晉升「${cultivation.nextLevel}」` : `已登入 ${cultivation.activeDays} 天，已達最高境界`}
                      >
                        {cultivation.level}
                      </span>
                      {/* 副稱號依「修為」顯示，跟境界是兩套：境界＝資歷，副稱號＝最近有沒有在做事 */}
                      <span className="sidebar-cultivation-epithet" title={`累計修為 ${cultivation.totalActions}`}>
                        {cultivation.epithet}
                      </span>
                    </div>
                    {/* 今日功課。刻意只顯示今天——這是「今天有在修行」的鼓勵，不是 KPI */}
                    <div
                      className="sidebar-cultivation-quest"
                      title={cultivation.nextQuest
                        ? `今日已行 ${cultivation.todayActions} 事，再 ${cultivation.nextQuest.at - cultivation.todayActions} 事可成「${cultivation.nextQuest.name}」`
                        : `今日已行 ${cultivation.todayActions} 事，功課圓滿`}
                    >
                      <span className="sidebar-cultivation-quest-label">
                        {cultivation.questDone ? `今日${cultivation.questDone}` : '今日功課'}
                      </span>
                      <span className="sidebar-cultivation-bar">
                        <i style={{ width: `${cultivation.nextQuest
                          ? Math.min(100, Math.round((cultivation.todayActions / cultivation.nextQuest.at) * 100))
                          : 100}%` }} />
                      </span>
                    </div>
                  </div>
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
            {themeMode === 'xianxia' && <span className="app-topbar-kicker">TAIXUAN CONTROL CENTER</span>}
            <span className="app-topbar-title">{currentThemeLabel}</span>
            {themeMode === 'xianxia' && currentThemeLabel !== currentPageLabel && <span className="app-topbar-group">{currentPageLabel}</span>}
          </div>
          <div className="app-global-search">
            <span className="app-global-search-icon" aria-hidden="true" />
            <input
              type="search"
              aria-label="搜尋工具"
              placeholder={themeMode === 'xianxia' ? '搜尋任務、卷宗或術式' : '搜尋功能頁面'}
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
                    {themeMode === 'xianxia' && entry.themeLabel !== entry.label && <small>{entry.label}</small>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="app-topbar-status" title={systemHealthy ? 'API 健康檢查正常' : 'API 健康檢查失敗，可能連不上伺服器'}>
            <span style={{ background: systemHealthy ? undefined : '#dc2626' }} />
            {systemHealthy
              ? (themeMode === 'xianxia' ? '靈脈穩定' : '系統正常')
              : (themeMode === 'xianxia' ? '靈脈紊亂' : '連線異常')}
          </div>
          {themeMode === 'xianxia' && <div className="app-topbar-seal" aria-hidden="true"><XianxiaIcon name="overview" size={28} /></div>}
        </div>

        {/* Page content — 整段等 globalAccount 確定登入後才掛載，避免 Dashboard 等頁面
            在登入完成前就先發出一次一定會失敗的 unauthenticated API 請求，導致登入完成後
            畫面短暫殘留這次失敗的錯誤訊息（要等下一次 30 秒輪詢才會自動清掉） */}
        {globalAccount && (
        <Suspense fallback={
          <div className="loading-state" style={{ padding: '64px 0' }}>
            <div className="loading-spinner" />
            <p className="loading-sub">頁面載入中...</p>
          </div>
        }>
        {(currentGroup?.id === 'color-game' && (effectiveTab === 'gs-bonusv2' || effectiveTab === 'gs-imgcompare')) ? (
          <>
            {effectiveTab === 'gs-bonusv2' && <GsBonusV2Page />}
            {effectiveTab === 'gs-imgcompare' && <GsImgComparePage />}
          </>
        ) : (
          <main className={`main-content${currentGroup?.id === 'weekly-report' || (currentGroup?.id === 'osm-tools' && effectiveTab === 'osm-uat') ? ' main-content--full' : ''}`}>
            {currentGroup?.id === 'dashboard' && <DashboardPage themeMode={themeMode} />}
            {currentGroup?.id === 'jira' && <JiraPage account={globalAccount} isAdmin={globalAccount?.role === 'admin'} permissions={permissions} />}
            {currentGroup?.id === 'lark' && <LarkPage themeMode={themeMode} />}
            {currentGroup?.id === 'weekly-report' && <WeeklyReportPage themeMode={themeMode} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm' && <OsmPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'machinetest' && <MachineTestPage account={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'imagecheck' && <ImageCheckPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm-config' && <OsmConfigComparePage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'autospin' && <AutoSpinPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'url-pool' && <UrlPoolPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'scripted-bet' && <ScriptedBetPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'jackpot' && <JackpotPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'osm-uat' && <OsmUatPage themeMode={themeMode} />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'ui-screenshot' && <UiScreenshotPage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'meter-reconcile' && <MeterReconcilePage />}
            {currentGroup?.id === 'osm-tools' && effectiveTab === 'egm-daycount' && <EgmDayCountPage />}
            {currentGroup?.id === 'settings' && effectiveTab === 'local-agent' && <LocalAgentPage currentAccount={globalAccount} />}
            {currentGroup?.id === 'discord-notify' && <DiscordNotifySettingsPage />}
            {currentGroup?.id === 'cultivation-board' && <CultivationLeaderboardPage currentEmail={globalAccount?.email ?? null} onPreviewRealm={setBreakthroughLevel} />}
            {currentGroup?.id === 'xianxia-quotes' && <XianxiaQuotesPage />}
            {currentGroup?.id === 'history' && <HistoryPage />}
            {currentGroup?.id === 'color-game' && effectiveTab === 'gs-logchecker' && <GsLogCheckerPage />}
            {currentGroup?.id === 'sysadmin' && <SystemAdminPage />}
            {currentGroup?.id === 'knowledge' && <KnowledgePage />}
          </main>
        )}
        </Suspense>
        )}
      </div>

      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {showGemini && <GeminiSettingsModal onClose={() => setShowGemini(false)} />}
      {!authChecking && !globalAccount && (
        <AuthLoginModal onLogin={handleGlobalAccountSelect} themeMode={themeMode} />
      )}

      <AiAgentMonitorWidget />
      {breakthroughLevel && <CultivationBreakthroughOverlay level={breakthroughLevel} onComplete={closeBreakthrough} hold={breakthroughPreviewHold} />}
    </div>
  )
}

export default App
