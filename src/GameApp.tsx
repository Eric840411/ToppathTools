import { useState } from 'react'
import { useClickSound } from './game/hooks/useClickSound'
import { GameModeProvider } from './components/GameModeContext'
import { GameSidebar, type GameTabId } from './game/components/GameSidebar'
import { GameHeader } from './game/components/GameHeader'

import { JiraPage } from './pages/JiraPage'
import { LarkPage } from './pages/LarkPage'
import { OsmPage } from './pages/OsmPage'
import { MachineTestPage } from './pages/MachineTestPage'
import { ImageCheckPage } from './pages/ImageCheckPage'
import { OsmConfigComparePage } from './pages/OsmConfigComparePage'
import { AutoSpinPage } from './pages/AutoSpinPage'
import { UrlPoolPage } from './pages/UrlPoolPage'
import { JackpotPage } from './pages/JackpotPage'
import { OsmUatPage } from './pages/OsmUatPage'
import { HistoryPage } from './pages/HistoryPage'
import { GsImgComparePage } from './pages/gs/GsImgComparePage'
import { GsStatsPage } from './pages/gs/GsStatsPage'
import { GsLogCheckerPage } from './pages/gs/GsLogCheckerPage'
import ChangelogModal from './components/ChangelogModal'
import GeminiSettingsModal from './components/GeminiSettingsModal'
import { JiraAccountModal, type AccountInfo } from './components/JiraAccountModal'
import { APP_VERSION } from './version'
import { GameProfileProvider } from './game/context/GameProfileContext'
import { GameNotifications } from './game/components/GameNotifications'
import { GameQuestPanel } from './game/components/GameQuestPanel'
import { PixelStudioWidget } from './game/components/PixelStudioWidget'

// pixel.css is loaded dynamically from main.tsx — do NOT import here

const GLOBAL_ACCOUNT_KEY = 'global_jira_account'
const loadGlobalAccount = (): AccountInfo | null => {
  try { return JSON.parse(sessionStorage.getItem(GLOBAL_ACCOUNT_KEY) ?? 'null') } catch { return null }
}

export function GameApp() {
  useClickSound()
  const [activeTab, setActiveTab] = useState<GameTabId>('jira')
  const [showChangelog, setShowChangelog] = useState(false)
  const [showGemini, setShowGemini] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [globalAccount, setGlobalAccount] = useState<AccountInfo | null>(loadGlobalAccount)

  const handleAccountSelect = (acc: AccountInfo) => {
    setGlobalAccount(acc)
    sessionStorage.setItem(GLOBAL_ACCOUNT_KEY, JSON.stringify(acc))
    setShowAccount(false)
  }

  const handleAccountClear = () => {
    setGlobalAccount(null)
    sessionStorage.removeItem(GLOBAL_ACCOUNT_KEY)
  }

  return (
    <GameModeProvider value={true}>
    <GameProfileProvider>
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--bg-dark)',
      backgroundImage: 'url(/game-assets/dashboard-bg.png)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed',
    }}>
      <GameHeader
        account={globalAccount}
        onAccountClick={() => setShowAccount(true)}
        onSettingsClick={() => setShowGemini(true)}
        onChangelogClick={() => setShowChangelog(true)}
        version={APP_VERSION}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <GameSidebar activeTab={activeTab} onTabChange={setActiveTab} />

        <main style={{
          flex: 1,
          minWidth: 0,
          overflow: 'auto',
          padding: 20,
          background: 'var(--bg-dark)',
        }}>
          <div key={activeTab} className="px-tab-enter" style={{ minHeight: '100%' }}>
          {activeTab === 'jira'          && <JiraPage />}
          {activeTab === 'lark'          && <LarkPage />}
          {activeTab === 'osm'           && <OsmPage />}
          {activeTab === 'machinetest'   && <MachineTestPage account={globalAccount} />}
          {activeTab === 'imagecheck'    && <ImageCheckPage />}
          {activeTab === 'osm-config'    && <OsmConfigComparePage />}
          {activeTab === 'autospin'      && <AutoSpinPage />}
          {activeTab === 'url-pool'      && <UrlPoolPage currentAccount={globalAccount} />}
          {activeTab === 'jackpot'       && <JackpotPage />}
          {activeTab === 'osm-uat'       && <OsmUatPage />}
          {activeTab === 'history'       && <HistoryPage />}
          {activeTab === 'gs-imgcompare' && <GsImgComparePage />}
          {activeTab === 'gs-stats'      && <GsStatsPage />}
          {activeTab === 'gs-logchecker' && <GsLogCheckerPage />}
          </div>
        </main>
      </div>

      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {showGemini    && <GeminiSettingsModal onClose={() => setShowGemini(false)} />}
      {showAccount   && (
        <JiraAccountModal
          currentEmail={globalAccount?.email ?? ''}
          onClose={() => setShowAccount(false)}
          onSelect={handleAccountSelect}
          onClearCurrent={() => { handleAccountClear(); setShowAccount(false) }}
        />
      )}

      {/* Game systems */}
      <GameNotifications />
      <GameQuestPanel />
      <PixelStudioWidget />
    </div>
    </GameProfileProvider>
    </GameModeProvider>
  )
}
