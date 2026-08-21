import type { BackendModuleId, BackendModuleTone, BackendPlanModule } from './types'

export interface BackendModuleDefinition {
  id: BackendModuleId
  name: string
  xianxiaName: string
  description: string
  category: '核心資料' | '營運驗證' | '系統治理'
  tone: BackendModuleTone
  filters: string[]
}

export const BACKEND_MODULES: BackendModuleDefinition[] = [
  { id: 'dashboard', name: 'Dashboard 與篩選', xianxiaName: '總覽觀測陣', description: '日期、Game Type、Client Version 與 Daily Dashboard 交叉驗證', category: '核心資料', tone: 'blue', filters: ['Dashboard'] },
  { id: 'egm-core', name: 'EGM 核心資料', xianxiaName: '靈機核心簿', description: 'EGM List、狀態、在線玩家與機台監控', category: '核心資料', tone: 'cyan', filters: ['EGM List', 'EGM Status', 'Gaming User', 'Machine Monitoring', 'Player Watch'] },
  { id: 'reports', name: '報表與匯出比對', xianxiaName: '報表玉簡庫', description: 'EGM Detail、Transfer、DayCount、Game Record 與 Excel 比對', category: '核心資料', tone: 'green', filters: ['EGM Detail', 'User Detail', 'EGM Transfer', 'Game Record', 'EGM DayCount', 'Player Credit Log', 'Fault List'] },
  { id: 'game-config', name: '遊戲與後台設定', xianxiaName: '後台佈陣術', description: 'White List、News、Advert、How To Play 與特殊入口設定', category: '營運驗證', tone: 'orange', filters: ['Loading Tips', 'White List', 'Game Jump Set', 'News Set', 'Advert Set', 'How To Play', 'Special Entrance Set', 'Test Setting', 'Deposit Setting'] },
  { id: 'meters', name: 'Meter 驗證', xianxiaName: '靈流計量陣', description: 'Hourly、Performance、Instant、Recovery 與 Daily Meter', category: '營運驗證', tone: 'violet', filters: ['Meter'] },
  { id: 'ranking', name: 'Ranking 與 Bonus', xianxiaName: '榜冊與靈賞', description: 'Daily／Channel Ranking、Bonus Settings 與延遲回查', category: '營運驗證', tone: 'amber', filters: ['Daily Ranking', 'Channel Ranking', 'Bonus'] },
  { id: 'jackpot', name: 'Jackpot 流程', xianxiaName: '天財異動錄', description: 'JP Percent、Moment、Ranking、Record 與 Abnormality', category: '營運驗證', tone: 'rose', filters: ['Jackpot', 'JP Percent'] },
  { id: 'reservation', name: '機台預約', xianxiaName: '靈機預約簿', description: 'Machine Reservation、Limit、匯入與操作紀錄', category: '系統治理', tone: 'cyan', filters: ['Reservation', '預約'] },
  { id: 'logs', name: 'Log 與異常監控', xianxiaName: '異象行跡錄', description: 'Operation／Login／Third-party Log 與異常頁面', category: '系統治理', tone: 'rose', filters: ['Log', 'Abnormality', 'Error Record', 'Out Log'] },
  { id: 'vip-version', name: 'VIP、Points 與版本', xianxiaName: '宗階與版本簿', description: 'VIP、Points、Membership 與 Version Confirm', category: '系統治理', tone: 'violet', filters: ['VIP', 'Points', 'Membership', 'Version', '版本'] },
  { id: 'other', name: '其他已映射 TC', xianxiaName: '其餘收錄術式', description: '保留 runner 已支援但未歸類的新舊 TC', category: '系統治理', tone: 'slate', filters: ['*'] },
]

export function createBackendModule(definition: BackendModuleDefinition, instanceId = `backend-${definition.id}`): BackendPlanModule {
  return { instanceId, sourceId: definition.id, name: definition.name, xianxiaName: definition.xianxiaName, description: definition.description, tone: definition.tone, filters: [...definition.filters] }
}

export function createDefaultBackendPlan(): BackendPlanModule[] {
  return BACKEND_MODULES.map(module => createBackendModule(module))
}

export const DEFAULT_BACKEND_PLAN = createDefaultBackendPlan()

export function createCustomBackendModule(instanceId: string): BackendPlanModule {
  return { instanceId, sourceId: 'custom', name: '自訂測試模組', xianxiaName: '自訂術式', description: '編輯名稱、說明與 TC 匹配規則後即可加入 runner 流程。', tone: 'blue', filters: ['請輸入 TC 關鍵字'] }
}

export function matchesBackendModule(module: BackendPlanModule, name: string): boolean {
  const normalized = name.toLocaleLowerCase()
  return module.filters.some(filter => filter === '*' || normalized.includes(filter.toLocaleLowerCase()))
}
