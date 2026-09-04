import { URL_POOL_DATA, type UrlPoolEntry } from './urlPoolData'
import { URL_POOL_DATA_UAT } from './urlPoolDataUat'

/**
 * 帳號池的環境維度。**所有消費端都從這裡拿**，不要各自 import 兩個資料檔再自己組。
 *
 * ⚠️ 會有三個地方用到同一份定義（URL 帳號池頁、帳號池選取彈窗、腳本化投注），
 *    各寫一份的話遲早漂掉——症狀會是「某個工具還停在只有 QAT」，
 *    而那正是這次要修的問題（加了 UAT 之後，AutoSpin/機台測試的選取視窗
 *    仍然只看得到 191 筆 QAT）。
 */
export type PoolEnv = 'qat' | 'uat'

export const POOL_ENVS: PoolEnv[] = ['qat', 'uat']

export const POOL_SOURCE: Record<PoolEnv, UrlPoolEntry[]> = {
  qat: URL_POOL_DATA,
  uat: URL_POOL_DATA_UAT,
}

export const POOL_LABEL: Record<PoolEnv, string> = { qat: 'QAT', uat: 'UAT' }

/**
 * 帳號屬於哪個環境。
 *
 * ⚠️ 用 username 反查而不是帳號號段。號段目前是 9111（QAT）／9361（UAT），
 *    但那是資料剛好，不是規則——之後任一邊新增帳號都可能打破。
 */
const ENV_BY_USERNAME = new Map<string, PoolEnv>()
for (const env of POOL_ENVS) {
  for (const r of POOL_SOURCE[env]) ENV_BY_USERNAME.set(r.username, env)
}
export function poolEnvOfUsername(username: string): PoolEnv | null {
  return ENV_BY_USERNAME.get(username) ?? null
}
