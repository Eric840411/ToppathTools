/**
 * 帳號池的「版本」維度：同一個帳號／同一個 token，要進 H5 還是 PC（Cocos）版。
 *
 * 跟「模擬正式」(`prodSimUrl.ts`) **不是同一件事**：
 *   - 模擬正式 = 換網域、參數原封不動（正式 token → prod-sim 環境）
 *   - 這裡     = 網域不變（還是 `osm-redirect`），**只換必要參數**
 *
 * 來源（使用者 2026-09-19 給的 QAT PC URL，與池子裡的 H5 URL 逐參數對照）：
 *   H5 : ...&platform=pc&mode=live&...&device=mobile&isPwaClaimed=1
 *   PC : ...&platform=50&mode=live&...&device=pc&gameid=...&mode=web&isPwaClaimed=1
 *
 * `gameid` / `username` / `token` 在範例裡也不一樣，但那是「範例用了另一隻帳號、另一款遊戲」，
 * 不是版本差異——**不要跟著動**，動了就不是同一個帳號在測了。
 *
 * ⚠️ **`mode=web` 刻意不加**（2026-09-19 與 CodeX 討論定案）。使用者給的範例 URL 有帶，
 *    但那會讓同一條 URL 出現**兩個 `mode`**（`mode=live` + `mode=web`），實際生效哪個取決於
 *    解析方式。而 `osm-qa-agent/test-rr-spin-investigate.js` 用**同一個 token**、
 *    只有 `platform=50&device=pc`（沒有 `mode=web`）就成功載入 PC Cocos 版——
 *    既然沒有證據說必須加，就不加；之後真的出現需要它的案例再回來釐清規格。
 *
 * ⚠️ **一律在原始 query 字串上做字串取代，不要 `URLSearchParams` 重新序列化。**
 *    重新序列化會改動編碼、也很容易安靜地吃掉重複的 key；產出的連結看起來完全正常、
 *    進去卻是另一種模式。（同樣的坑在 `prodSimUrl.ts` 開頭也寫過一次。）
 *
 * ⚠️ 轉換**永遠從資料庫裡那條原始 H5 URL 出發**，不要拿轉好的 PC URL 再轉一次。
 *    UI 端要保證這點：per-row 的版本只是顯示狀態，存進 DB 的一律是 H5 原始值。
 */

export type PoolDevice = 'h5' | 'pc'

export const POOL_DEVICES: PoolDevice[] = ['h5', 'pc']
export const POOL_DEVICE_LABEL: Record<PoolDevice, string> = { h5: 'H5', pc: 'PC' }

/** PC 版的 platform 值。H5 是 `pc`（是的，反過來的，不是筆誤——這是站台的既有命名）。 */
const PC_PLATFORM = '50'

/**
 * 取代 query 裡某個 key 的值（保留位置與其他重複 key）。key 不存在時補在最後面。
 */
function setParam(query: string, key: string, value: string): string {
  const has = new RegExp(`(^|&)${key}=`).test(query)
  if (!has) return query ? `${query}&${key}=${value}` : `${key}=${value}`
  return query.replace(new RegExp(`(^|&)${key}=[^&]*`, 'g'), `$1${key}=${value}`)
}

/**
 * 把帳號池的（H5）Token URL 轉成指定版本。
 *
 * `device === 'h5'` 時原樣回傳——H5 就是資料本身的樣子，不做任何加工。
 */
export function toDeviceUrl(url: string, device: PoolDevice): string {
  if (device === 'h5' || !url) return url

  const qIdx = url.indexOf('?')
  // 沒有 query 就沒有東西可以換。硬湊一條出來只會得到「看起來對、進去卻不對」的連結。
  if (qIdx < 0) return url

  const head = url.slice(0, qIdx)
  let query = url.slice(qIdx + 1)

  // 只動這兩個。`mode`（`mode=live`）與其餘參數原樣保留——理由見檔案開頭。
  query = setParam(query, 'platform', PC_PLATFORM)
  query = setParam(query, 'device', 'pc')

  return `${head}?${query}`
}
