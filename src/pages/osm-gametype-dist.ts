/**
 * 機台版本 Dashboard「機種渠道分布」的純判斷。
 *
 * 為什麼獨立一支檔案：這幾個判斷都有實際會出錯的邊界（機種代碼取法、只有離線機台的渠道、
 * 版本基準要不要算離線機台），留在 OsmPage.tsx 的元件裡就只能靠肉眼看。抽出來才驗得到。
 * 對應測試：npx tsx scripts/ui-checks/osm-gametype-dist.test.ts
 */

/** 只取判斷用得到的欄位（結構型別，OsmMachine 直接傳得進來）。 */
export interface GtMachine {
  id: string
  machineName: string
  /** 機型／型號，egmList 的 machineType，例如「dfdcgrand1」「wlzbhelix25」 */
  machineType: string
  version: string
  onlineState: string
}

export interface GtChannel {
  name: string
  machines: GtMachine[]
}

export interface GtChannelGroup {
  name: string
  machines: GtMachine[]
  online: number
  offline: number
  unknown: number
}

/**
 * 機種代碼的單一取法。機器名稱長成「873-RISINGROCKETS-0011」，中段就是機種。
 *
 * ⚠️ 「切不出中段就退回 machineType」那層不能省：先前這個取法在 OsmPage 裡有兩套，機種卡的
 * 數字有那層、「缺少機台」那段沒有，於是名稱裡沒有 '-' 的機台會被算進卡片數字、卻永遠不會
 * 出現在清單裡。渠道分布彈窗一定要跟卡片同一套，不然彈窗台數會跟卡片數字對不上。
 */
export function gameTypeOf(m: GtMachine): string {
  const parts = m.machineName.split('-')
  return (parts.length >= 2 ? parts[1] : m.machineType || parts[0]).toLowerCase()
}

export function isMachineOnline(m: GtMachine): boolean {
  return (m.onlineState ?? '').toString().trim().toLowerCase() === 'online'
}

function connState(m: GtMachine): 'online' | 'offline' | 'unknown' {
  const s = (m.onlineState ?? '').toString().trim().toLowerCase()
  if (s === 'online') return 'online'
  if (s === 'offline') return 'offline'
  return 'unknown'
}

/**
 * 把某個機種的機台按渠道分組。
 *
 * ⚠️ 只要這個渠道有一台（不管在不在線上）就會被列出來。使用者要回答的問題是「這個機種在哪些
 * 渠道」——把「只有離線機台」的渠道整個濾掉，等於告訴他那個渠道沒有這個機種，而那正好可能
 * 就是他在找的那台。要不要顯示離線機台的「列」是另一件事，由畫面上的開關決定。
 *
 * 渠道順序沿用傳進來的順序（跟畫面左邊那排渠道卡一致），不自己重排。
 */
export function groupByChannelForType(channels: GtChannel[], type: string): GtChannelGroup[] {
  const out: GtChannelGroup[] = []
  for (const c of channels) {
    const machines = c.machines.filter(m => gameTypeOf(m) === type)
    if (machines.length === 0) continue
    let online = 0, offline = 0, unknown = 0
    for (const m of machines) {
      const st = connState(m)
      if (st === 'online') online++
      else if (st === 'offline') offline++
      else unknown++
    }
    out.push({ name: c.name, machines, online, offline, unknown })
  }
  return out
}

/**
 * 版本標色的參考點：這個機種「線上機台裡最多台在用」的版本。
 *
 * ⚠️ 只看線上機台——離線機台的版本可能是很久以前的，拿它當基準會把還在線上的正常機台標成
 * 異常。只有一種版本時回 null（沒有比較對象，標色只是雜訊）。
 */
export function referenceVersion(groups: GtChannelGroup[]): string | null {
  const counts = new Map<string, number>()
  for (const g of groups) {
    for (const m of g.machines) {
      if (!isMachineOnline(m) || !m.version) continue
      counts.set(m.version, (counts.get(m.version) ?? 0) + 1)
    }
  }
  if (counts.size <= 1) return null
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

export interface GtTypeGroup {
  /** 畫面上顯示的型號：這一組裡最多台在用的那個原始寫法 */
  label: string
  /** 正規化後的 key（trim + 小寫），分組用 */
  key: string
  machines: GtMachine[]
  online: number
}

/**
 * 型號（`machineType`，例如 `dfdcgrand1`／`wlzbhelix25`）的正規化 key：trim + 小寫。
 *
 * 已用全渠道真實資料（1460 筆 egmList）確認這個欄位很乾淨：**0 筆空值、0 組大小寫或空白不一致**
 * （65 種全部本來就是小寫）。所以這裡只做最低限度的 trim + 小寫防呆，不需要像機殼名稱那種
 * 麻煩的合併判斷。
 *
 * ⚠️ 刻意不用 `machineTypeId` 當 key：跟 modelId 同一個問題，id 在不同渠道會不一樣。
 */
export function machineTypeKeyOf(m: GtMachine): string {
  return (m.machineType ?? '').trim().toLowerCase()
}

/**
 * 把一個渠道裡的機台再按型號拆開。
 *
 * 排序用**自然排序（數字部分按數值比）**，不是台數多寡：真實資料裡 wlzbhelix 這個機種底下有
 * 16 種型號（wlzbhelix6、8、9、10…25），它本質上是一份版本清單，按名稱順序掃比較好讀；
 * 而純字串排序會把 wlzbhelix10 排在 wlzbhelix9 前面。
 *
 * 型號沒有值的歸成一組排最後（真實資料裡目前沒有，但不能因此就丟掉——丟掉的話台數會跟
 * 上面的渠道統計對不起來，而且畫面上看不出少了東西）。
 */
export function groupByMachineType(machines: GtMachine[]): GtTypeGroup[] {
  const map = new Map<string, { machines: GtMachine[]; labels: Map<string, number> }>()
  for (const m of machines) {
    const key = machineTypeKeyOf(m)
    let e = map.get(key)
    if (!e) { e = { machines: [], labels: new Map() }; map.set(key, e) }
    e.machines.push(m)
    const raw = (m.machineType ?? '').trim()
    if (raw) e.labels.set(raw, (e.labels.get(raw) ?? 0) + 1)
  }
  const out: GtTypeGroup[] = []
  for (const [key, e] of map) {
    // 同一組裡若有多種原始寫法（只差大小寫），顯示最多台在用的那個。
    // ⚠️ 平手時用 codepoint 順序而不是 localeCompare——後者會依環境的 locale 資料而變，
    // 同一份資料在不同機器上可能顯示不同寫法。選哪個都不算錯，但一定要穩定。
    const label = [...e.labels.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? ''
    out.push({ key, label, machines: e.machines, online: e.machines.filter(isMachineOnline).length })
  }
  return out.sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1 // 沒有型號的排最後
    return a.key.localeCompare(b.key, undefined, { numeric: true })
  })
}
/**
 * 這個型號底下有沒有「版本跟大家不一樣」的線上機台。
 *
 * 用途是型號銘牌上那道光刃要不要呼吸（CodeX 的設計：只有異常的型號才給常駐動畫，
 * 不能 16 個一起閃）。**訊號刻意跟版本欄標黃色用同一個** `refVersion`——多做一套判斷等於
 * 畫面上兩個地方各自定義「異常」，之後一定漂。
 *
 * ⚠️ 只看線上機台：離線機台的版本可能是很久以前的，算進來的話幾乎每個型號都會被標成異常，
 * 那個訊號就沒有意義了（跟 referenceVersion() 只看線上是同一個理由）。
 * refVersion 是 null（只有一種版本或沒有線上機台）時一律回 false——沒有比較對象。
 */
export function hasVersionMismatch(machines: GtMachine[], refVersion: string | null): boolean {
  if (!refVersion) return false
  return machines.some(m => isMachineOnline(m) && !!m.version && m.version !== refVersion)
}

/** 彈窗裡一個渠道實際要顯示的列：預設只有線上，開關打開才含其餘。線上排前面。 */
export function visibleMachines(group: GtChannelGroup, showOffline: boolean): GtMachine[] {
  return (showOffline ? group.machines : group.machines.filter(isMachineOnline))
    .slice()
    .sort((a, b) => {
      const ao = isMachineOnline(a) ? 0 : 1
      const bo = isMachineOnline(b) ? 0 : 1
      if (ao !== bo) return ao - bo
      return (a.machineName || a.id).localeCompare(b.machineName || b.id, 'zh-Hant')
    })
}

// ── 彈窗內搜尋（v4.143.0）──────────────────────────────────────────────────────
// 比對 渠道名稱／型號／機台名稱／版本 四項。抽成純函式的理由跟這支檔案裡其他判斷一樣：
// 這裡有三個實際會出錯的邊界，留在元件裡只能靠肉眼看——
//   ① 搜渠道名或型號時，整個渠道／整組要視為符合（否則打「NCH」會什麼都不剩）
//   ② 「有命中但全被離線開關藏住」必須跟「完全沒命中」分得開（不然畫面看起來一樣是 0 筆）
//   ③ 過濾後的計數要跟實際顯示的列一致

/** 搜尋字串的正規化：trim + 小寫。空字串代表沒有在搜尋。 */
export function normalizeQuery(q: string): string {
  return (q ?? '').trim().toLowerCase()
}

/**
 * `query` 在 `text` 裡的位置，給畫面高亮用。沒有 query 或沒命中回 null。
 * 回位置而不是回 HTML —— 元件用 React 節點組，不碰 innerHTML。
 */
export function matchRange(text: string, query: string): [number, number] | null {
  if (!query) return null
  const i = (text ?? '').toLowerCase().indexOf(query)
  return i < 0 ? null : [i, i + query.length]
}

export interface GtSearchModel {
  /** 原本那組（上面的台數／線上數統計一律用它，不受搜尋影響）*/
  group: GtTypeGroup
  /** 符合搜尋的機台。沒有搜尋時就是整組 */
  matched: GtMachine[]
  /** 這一組實際要畫出來的列（matched 再套「顯示離線」開關）*/
  visible: GtMachine[]
  /** 符合搜尋、但因為「顯示離線」關著而看不到的台數 */
  hiddenByOffline: number
  /** 因為渠道名或型號命中而整組視為符合（不是逐台比對到的）*/
  wholeGroupHit: boolean
}

export interface GtSearchChannel {
  channel: GtChannelGroup
  models: GtSearchModel[]
  /** 這個渠道裡符合搜尋的台數 */
  matchCount: number
}

export interface GtSearchOutcome {
  channels: GtSearchChannel[]
  /** 有沒有在搜尋 */
  active: boolean
  /** 全部符合搜尋的台數 */
  matchCount: number
  /** 這個機種的總台數（分母，不受搜尋影響）*/
  totalCount: number
  /** 符合搜尋但被「顯示離線」開關藏起來的台數 */
  hiddenByOffline: number
}

function machineHit(m: GtMachine, q: string): boolean {
  return (m.machineName ?? '').toLowerCase().includes(q)
    || (m.version ?? '').toLowerCase().includes(q)
}

/**
 * 套用搜尋與「顯示離線」開關，算出彈窗實際要畫的東西。
 *
 * ⚠️ 沒有命中的渠道／型號**整組不放進結果**（`channels`／`models` 裡就沒有它），
 * 而不是回傳一個空的殼讓元件自己判斷要不要畫——後者等於把「要不要顯示」這個判斷
 * 又放回元件裡，兩邊遲早不一致。
 *
 * ⚠️ `totalCount` 一律是這個機種的總台數，**不隨搜尋變動**。上方「分布在 N 個渠道、
 * 共 M 台」講的是部署現況，跟著搜尋跳動會讓人以為機台真的變少了。
 */
export function searchDistribution(
  groups: GtChannelGroup[],
  query: string,
  showOffline: boolean,
): GtSearchOutcome {
  const q = normalizeQuery(query)
  const active = q.length > 0
  let matchCount = 0, totalCount = 0, hiddenByOffline = 0
  const channels: GtSearchChannel[] = []

  for (const channel of groups) {
    // 渠道名命中 → 這個渠道底下全部視為符合。否則搜「NCH」會什麼都不剩。
    const chanHit = active && channel.name.toLowerCase().includes(q)
    const models: GtSearchModel[] = []
    let chanMatch = 0

    for (const group of groupByMachineType(channel.machines)) {
      totalCount += group.machines.length
      const modelHit = active && group.label.toLowerCase().includes(q)
      const wholeGroupHit = chanHit || modelHit
      const matched = !active || wholeGroupHit
        ? group.machines
        : group.machines.filter(m => machineHit(m, q))
      if (active && matched.length === 0) continue   // 這一組完全沒命中 → 整組不顯示

      const hidden = showOffline ? 0 : matched.filter(m => !isMachineOnline(m)).length
      // 沿用 visibleMachines 的排序規則（線上排前面），只是餵進去的是 matched 而不是整組
      const visible = visibleMachines(
        { name: channel.name, machines: matched, online: 0, offline: 0, unknown: 0 },
        showOffline,
      )
      chanMatch += matched.length
      hiddenByOffline += hidden
      models.push({ group, matched, visible, hiddenByOffline: hidden, wholeGroupHit })
    }

    matchCount += chanMatch
    if (active && chanMatch === 0) continue          // 這個渠道整段沒命中 → 不顯示
    channels.push({ channel, models, matchCount: chanMatch })
  }

  return { channels, active, matchCount, totalCount, hiddenByOffline }
}
