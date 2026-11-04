// Performance Meter／Egm DayCount 的環境切換（QAT／UAT）。後端規則在 server/meter-config-core.ts。
export type MeterEnv = 'qat' | 'uat'

export const METER_ENV_LABEL: Record<MeterEnv, string> = { qat: 'QAT', uat: 'UAT' }

/** 只是輸入框的提示字，不是預設值：沒填就是沒設定，後端不會退回這些值。 */
export const METER_PLACEHOLDER: Record<MeterEnv, Record<'osm' | 'gcp', { base_url: string; origin: string; channelId: string }>> = {
  qat: {
    osm: { base_url: 'https://backendservertest.osmslot.org', origin: 'https://qat-cp.osmslot.org', channelId: '873' },
    gcp: { base_url: 'https://backendservertest.osmslot.org', origin: 'https://qat-nc.osmslot.org', channelId: '892' },
  },
  uat: {
    osm: { base_url: 'https://uat-backendservertest.osmslot.org', origin: 'https://uat-cp.osmslot.org', channelId: '4186' },
    gcp: { base_url: 'https://uat-backendservertest.osmslot.org', origin: 'https://uat-nc.osmslot.org', channelId: '' },
  },
}

const key = (page: string) => `meter-env:${page}`

/** 各頁各自記住上次選的環境（只是個人方便，讀不到就用 QAT）。 */
export function readMeterEnv(page: string): MeterEnv {
  try { return localStorage.getItem(key(page)) === 'uat' ? 'uat' : 'qat' } catch { return 'qat' }
}
export function writeMeterEnv(page: string, env: MeterEnv) {
  try { localStorage.setItem(key(page), env) } catch { /* 無痕模式寫不進去就算了 */ }
}
