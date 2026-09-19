/**
 * 正式 token URL → 模擬正式（prod-sim）連結。
 *
 * 需求：使用者手上只有正式環境的 token URL（`osm-redirect.osmplay.com/?token=...`），
 * 要拿同一個 token 進模擬正式環境測。兩邊**只有網域不同**，參數原封不動。
 *
 *   H5 → https://osm-h5-prod.osmslot.org/
 *   PC → https://osm-pc-prod.osmslot.org/
 *
 * ⚠️ **PC 版不改任何參數**（使用者 2026-09-18 確認：「PC 不用改，只要帶域名就會自動轉換」）。
 *    曾考慮把 `device=mobile` 換成 `desktop`，已放棄——沒有證據說必須改，
 *    而且只改 `device` 不動 `mode=mobile` 也不保證真的切成桌面版，改了反而分不清
 *    出問題是環境的還是我們動的。
 *
 * ⚠️ **query string 一律用原字串接上，不要重新序列化。**
 *    實際的 URL 帶了**兩個 `mode`**（`mode=live` 與 `mode=mobile`）。
 *    `URLSearchParams` 本身保得住重複 key，但只要有人之後「順手整理」成
 *    物件或走 `.set()`，就會安靜地吃掉一個；重新序列化也會改動編碼。
 *    產出的連結那時候看起來完全正常，進去卻是另一種模式。
 */

export type ProdSimTarget = 'h5' | 'pc'

export const PROD_SIM_BASE: Record<ProdSimTarget, string> = {
  h5: 'https://osm-h5-prod.osmslot.org/',
  pc: 'https://osm-pc-prod.osmslot.org/',
}

export const PROD_SIM_TARGETS: ProdSimTarget[] = ['h5', 'pc']
export const PROD_SIM_TARGET_LABEL: Record<ProdSimTarget, string> = { h5: 'H5', pc: 'PC' }

/** 正式環境的網域。貼進來的如果不是這個，多半是拿錯環境的 token。 */
const PROD_HOST_HINT = 'osmplay.com'
/** 測試環境的網域（QAT/UAT）。模擬正式**不吃**這邊的 token。 */
const TEST_HOST_HINT = 'osmslot.org'

export interface ProdSimResult {
  ok: boolean
  /** 轉換失敗的原因（ok=false 時才有；輸入為空時是空字串，畫面不必報錯）。 */
  error?: string
  /** 可以照做、但要提醒使用者的事（ok=true 也可能有）。 */
  warnings: string[]
  urls: Record<ProdSimTarget, string>
  /** 解析出來給畫面顯示用，貼錯東西時一眼看得出來。 */
  fields: { token: string; username: string; gameid: string; studioid: string; platform: string }
  /** 來源網域，顯示用。 */
  sourceHost: string
}

const EMPTY_FIELDS = { token: '', username: '', gameid: '', studioid: '', platform: '' }

function fail(error: string, warnings: string[] = []): ProdSimResult {
  return { ok: false, error, warnings, urls: { h5: '', pc: '' }, fields: { ...EMPTY_FIELDS }, sourceHost: '' }
}

export function toProdSimUrls(input: string): ProdSimResult {
  const raw = input.trim().replace(/^['"`<]+|['"`>]+$/g, '').trim()
  // 空輸入不是錯誤，是還沒貼。畫面靠 ok=false 清掉舊結果、停用複製／開啟。
  if (!raw) return fail('')

  const qIdx = raw.indexOf('?')
  if (qIdx < 0) {
    // 只貼 token 是組不出連結的——gameid／studioid／platform 這些沒有預設值可以猜，
    // 硬生一條出來只會得到一個「看起來對、進去卻是錯的」連結。
    return fail(/^[0-9a-f]{20,}-\d+$/i.test(raw)
      ? '只有 token 沒辦法組出連結——還需要 gameid / studioid / platform 等參數，請貼完整的正式 URL。'
      : '看不到 query string（?token=...）。請貼完整的正式 token URL。')
  }

  const head = raw.slice(0, qIdx)
  // 原字串直接轉貼：query 後面若還跟著 #hash 也一併保留。
  const query = raw.slice(qIdx + 1)
  if (!query) return fail('? 後面是空的，沒有任何參數。')

  const warnings: string[] = []

  let sourceHost = ''
  let sourcePath = ''
  try {
    const u = new URL(/^https?:\/\//i.test(head) ? head : `https://${head}`)
    sourceHost = u.host
    sourcePath = u.pathname
  } catch {
    warnings.push('前面那段不像網址，已忽略，只取 ? 後面的參數。')
  }

  if (sourceHost) {
    if (sourceHost.includes(TEST_HOST_HINT)) {
      warnings.push(`來源是 ${sourceHost}——這是「測試環境」（QAT／UAT）的 token，模擬正式環境不吃，開起來會停在登入失敗，不會有明顯報錯。`)
    } else if (!sourceHost.includes(PROD_HOST_HINT)) {
      warnings.push(`來源網域是 ${sourceHost}，不是預期的 ${PROD_HOST_HINT}。確認一下這是不是正式環境的 token。`)
    }
    // 正式入口是 redirect 首頁（path 為 / 或空）。有別的路徑代表這不是我們認得的入口，
    // 只換網域不見得等價——說出來，不要默默照做。
    if (sourcePath && sourcePath !== '/') {
      warnings.push(`來源路徑是 ${sourcePath}（不是首頁）。模擬正式只換網域、不帶路徑，開起來可能不是同一個入口。`)
    }
  }

  // 顯示用的解析。⚠️ 只拿來顯示，**不參與組連結**（組連結用原字串）。
  const sp = new URLSearchParams(query)
  const fields = {
    token: sp.get('token') ?? '',
    username: sp.get('username') ?? '',
    gameid: sp.get('gameid') ?? '',
    studioid: sp.get('studioid') ?? '',
    platform: sp.get('platform') ?? '',
  }
  if (!fields.token) warnings.push('參數裡沒有 token，這條連結八成不能用。')
  if (!fields.gameid) warnings.push('參數裡沒有 gameid，不確定會開到哪一款遊戲。')

  return {
    ok: true,
    warnings,
    urls: {
      h5: `${PROD_SIM_BASE.h5}?${query}`,
      pc: `${PROD_SIM_BASE.pc}?${query}`,
    },
    fields,
    sourceHost,
  }
}
