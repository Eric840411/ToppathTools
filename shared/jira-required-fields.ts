// 批量開單的「強制必填」單一定義來源。
//
// 為什麼要放在 shared/：這幾欄的必填是**我們自己加的**，Jira createmeta 回的
// `required` 對它們一律是 false（描述／受託人／回報人／RD負責人在 Jira 都是選填）。
// 前端靠這份清單顯示紅星與擋送出，後端也要靠它補驗（改 payload 可以繞過前端），
// 兩邊各寫一份的話遲早漂移——而漂移的症狀是「畫面標必填、送出卻放行」，
// 沒有任何徵兆（不報錯、不少列，單子開得成功，只是缺欄位）。v3.97.0～v4.133.4
// 之間就是這樣壞了三個月。
//
// ⚠️ shared/ 只放純函式、型別、常數，不碰 fs／DB／env／Express／React。

/** Jira 標記為選填、但本工具一律要求填寫的欄位 key。 */
export const FORCED_REQUIRED_JIRA_FIELD_KEYS = [
  'description',
  'assignee',
  'reporter',
  'customfield_10428', // RD負責人（這個 id 只對目前在用的專案成立，見下方名稱比對）
] as const

/**
 * RD負責人在**每個專案可能是不同的自訂欄位 id**（跟週報「QA驗證人員」那個坑同一種：
 * 同名 people 欄位在 Jira 實例裡有三十幾個，寫死一個 id 只對一個專案有效）。
 * 所以除了 key 之外，拿得到欄位名稱時一律再用名稱比對一次。
 */
export const RD_OWNER_FIELD_NAME = 'RD負責人'

/** 組錯誤訊息用的顯示名稱；拿不到 createmeta 時的 fallback。 */
export const FORCED_REQUIRED_JIRA_FIELD_LABELS: Record<string, string> = {
  description: '描述',
  assignee: '受託人',
  reporter: '回報人',
  customfield_10428: 'RD負責人',
}

/** 前後端各有一份 NormalizedJiraField，這裡只取判斷用得到的欄位（結構型別）。 */
export interface JiraFieldLike {
  key: string
  name?: string
  required?: boolean
}

const FORCED_KEY_SET: ReadonlySet<string> = new Set<string>(FORCED_REQUIRED_JIRA_FIELD_KEYS)

/** 強制必填：即使 Jira 標記為選填，這幾欄也一律自動顯示並要求填寫。 */
export function isForcedRequiredJiraField(f: JiraFieldLike): boolean {
  return FORCED_KEY_SET.has(f.key) || (f.name ?? '').includes(RD_OWNER_FIELD_NAME)
}

/**
 * 必填 = Jira 自己標的必填 **或** 我們的強制必填。
 *
 * ⚠️ 驗證一定要用這支，不能直接用 `f.required`——後者對強制必填那四欄永遠是 false，
 * 會變成「畫面標紅星、送出完全不擋」。
 */
export function isJiraFieldRequired(f: JiraFieldLike): boolean {
  return !!f.required || isForcedRequiredJiraField(f)
}

// ─── 後端補驗用的純判斷 ────────────────────────────────────────────────────────
// 放在 shared/ 而不是留在 server/routes/jira.ts 裡的原因有兩個：① 判斷本身是純函式，
// 留在 route 檔案裡就只能連同 DB／env 一起 import 才測得到，實際上等於測不了；
// ② 前端擋送出、後端補驗，兩邊要是同一份規則。

/** payload 裡一列的形狀（只取判斷用得到的欄位）。 */
export interface ForcedRequiredCheckRow {
  description?: string
  assigneeAccountId?: string
  rdOwnerAccountId?: string
  reporterAccountId?: string
  dynamicFields?: Record<string, unknown>
}

/** 這個值算不算「有填」。 */
export function hasFilledJiraValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (typeof v === 'number' || typeof v === 'boolean') return true
  if (Array.isArray(v)) return v.some(hasFilledJiraValue)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // Jira 的欄位值常包一層（{accountId}/{id}/{name}/{value}）。
    // ⚠️ 不能只看「key 存在」——前端對「Sheet 人名對不到帳號」的 user 欄位送出的是
    // `{ accountId: '' }`，那是空值不是有值，只檢查 key 會把它當成填好了。
    for (const k of ['accountId', 'id', 'name', 'value']) {
      if (k in o) return hasFilledJiraValue(o[k])
    }
    return Object.keys(o).length > 0
  }
  return false
}

/**
 * 回傳這一列缺哪些強制必填欄位（顯示名稱）；空陣列 = 都有填。
 *
 * @param fieldMeta 這個專案 createmeta 正規化後的欄位（拿不到就傳空 Map）
 * @param opts.requireReporter 只有動態欄位模式才要求回報人，理由見 batchCreateSchema 的註解
 */
export function missingForcedRequiredFields(
  row: ForcedRequiredCheckRow,
  fieldMeta: ReadonlyMap<string, JiraFieldLike>,
  opts: { requireReporter: boolean },
): string[] {
  // ⚠️ createmeta 拿得到時**只認 meta 裡真的存在的欄位**，不要把常數清單跟 meta 聯集：
  // RD負責人在每個專案可能是不同的 customfield id（跟週報「QA驗證人員」同一個坑），聯集的話
  // 在別的專案會同時要求 customfield_10428 跟該專案真正的那個 id，而前者根本不在建立畫面上，
  // 結果是「每一列都被擋、而且擋的理由根本不存在」。meta 才是這個專案的權威來源，
  // 也跟前端算 requiredJiraFields 用的是同一份資料。
  const forcedKeys = fieldMeta.size > 0
    ? [...fieldMeta.values()].filter(isForcedRequiredJiraField).map(f => f.key)
    : [...FORCED_REQUIRED_JIRA_FIELD_KEYS]

  // 傳統模式的值在 payload 頂層、動態欄位模式在 dynamicFields，兩種形狀都要認
  const legacyTopLevel: Record<string, unknown> = {
    description: row.description,
    assignee: row.assigneeAccountId,
    reporter: row.reporterAccountId,
  }

  const missing: string[] = []
  for (const key of forcedKeys) {
    if (key === 'reporter' && !opts.requireReporter) continue
    const label = fieldMeta.get(key)?.name || FORCED_REQUIRED_JIRA_FIELD_LABELS[key] || key
    const isRdOwner = key === 'customfield_10428' || label.includes(RD_OWNER_FIELD_NAME)
    const candidates: unknown[] = [
      row.dynamicFields?.[key],
      isRdOwner ? row.rdOwnerAccountId : legacyTopLevel[key],
    ]
    if (candidates.some(hasFilledJiraValue)) continue
    missing.push(label)
  }
  return missing
}
