/**
 * shared/weekly-report-rules.ts
 *
 * 週報「草稿 → 送出內容」的呈現規則，前端與後端共用**同一份**。
 *
 * ## 為什麼要有這個檔案
 * 這些規則原本只活在 `src/pages/WeeklyReportPage.tsx` 裡。要讓 Discord 按鈕能直接送出，
 * 後端就得算得出跟頁面一模一樣的內容——在 server 再寫一份的話，之後改比對規則一定會漏一邊，
 * 而且症狀會是「Discord 送出去的跟頁面上看到的不一樣」，最難查的那種。
 *
 * ## 這個檔案的規矩（跟 CodeX 定案，不要破例）
 * **只放純函式、純型別、常數。不准 import fs／DB／env／Express／React／任何 server-only 或
 * browser-only 的東西。**一旦這裡碰到 server 專屬相依，前端 build 會直接炸；反過來也一樣。
 * 需要 I/O 的部分留在各自那邊，這裡只負責「同樣的輸入算出同樣的輸出」。
 *
 * ## 抽不進來的部分
 * **手動指派**（頁籤日期式報表、未識別人員指派）本質上要有人看著決定，不是規則能算的。
 * 那部分永遠只會存在於使用者實際操作的地方。
 */

export interface FieldOption { id: string; name: string }

export interface DraftItem {
  sourceRowId: string
  content: string
  projectId: string
  projectName: string
  /** Jira 撈單套用進來的原始資料（單號 + 標題成對存，不是兩個平行陣列——只存 summaries[] 的話
   *  跟 key 的對應是隱性的，之後要追「這個標題是哪張單」會很痛，CodeX review 建議）*/
  jiraIssues?: { key: string; summary: string }[]
}

export interface FlatItem { person: string; item: DraftItem }

// ── 常數 ─────────────────────────────────────────────────────────────────────

export const DEFAULT_SCAN_SHEET_PROJECT_NAME = 'P7-005-OSM'
export const DEFAULT_TAB_DATE_PROJECT_NAME = 'P7-007-第三方測試'
/** 每人合併成一條的目標專案。刻意沿用上面那個常數而不是寫死第二份字串 */
export const MERGE_PROJECT_NAME = DEFAULT_SCAN_SHEET_PROJECT_NAME
export const MERGE_CONTENT = 'OSM需求'

// ── 專案名稱比對 ──────────────────────────────────────────────────────────────

/** 比對 Jira 專案真實名稱（例如 "P7-007 第三方測試"）跟 Lark 專案選項（例如 "P7-007-第三方測試"）——
 *  已用真實資料證實兩者幾乎一樣，只差空格/連字號，正規化（去空白連字號、轉小寫）後理論上會完全相等；
 *  完全相等比對不到才退一步用 contains，比對不到就回傳 undefined，不會亂猜 */
export function normalizeProjectName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, '')
}

export function matchLarkProjectByJiraName(jiraProjectName: string, larkProjects: FieldOption[]): FieldOption | undefined {
  if (!jiraProjectName) return undefined
  const norm = normalizeProjectName(jiraProjectName)
  return larkProjects.find(p => normalizeProjectName(p.name) === norm)
    ?? larkProjects.find(p => {
      const pn = normalizeProjectName(p.name)
      return pn.includes(norm) || norm.includes(pn)
    })
}

// ── Jira 標題標籤歸集 ─────────────────────────────────────────────────────────

/** 取標題開頭連續的中括號標籤。刻意只吃開頭，本文中間出現的中括號不算——例如
 *  「修正 [OSM] 顯示問題」的 [OSM] 不是分類標籤（CodeX review 建議）。 */
export function leadingTags(summary: string): string[] {
  const m = summary.trim().match(/^(\[[^\]]+\])+/)
  if (!m) return []
  return (m[0].match(/\[[^\]]+\]/g) ?? []).map(t => t.slice(1, -1).trim()).filter(Boolean)
}

/** 依標題標籤把一組 Jira 單歸集成幾句話。使用者定義的規則（2026-08-20 當面確認）：
 *  **先依第一個標籤分組**——沒有共同標籤的單不是串成一句，而是拆成不同項目各寫一條。
 *  每組取該組所有單的共同標籤（同組第一個標籤必然相同，所以至少有一個），組成「◯◯相關需求測試」。
 *  例：[OSM][GM] + [OSM][後端] → 一條「OSM相關需求測試」（共同的只有 OSM）
 *      [OSM][GM] + [LuckyLink][後端] → 兩條「OSM GM相關需求測試」「LuckyLink 後端相關需求測試」
 *  標題沒有中括號的單無法歸集，改成**直接寫該張單的標題**、一張單一條（使用者 2026-08-20 指定）。 */
export function jiraTagGroups(issues: { key: string; summary: string }[]): {
  labels: string[]
  untagged: { key: string; summary: string }[]
} {
  const groups = new Map<string, { key: string; summary: string }[]>()
  const untagged: { key: string; summary: string }[] = []
  for (const iss of issues) {
    const tags = leadingTags(iss.summary)
    if (tags.length === 0) { untagged.push(iss); continue }
    const bucket = groups.get(tags[0])
    if (bucket) bucket.push(iss)
    else groups.set(tags[0], [iss])
  }
  const labels: string[] = []
  for (const list of groups.values()) {
    const tagLists = list.map(i => leadingTags(i.summary))
    const common = tagLists[0].filter(tag => tagLists.every(l => l.includes(tag)))
    labels.push(`${common.join(' ')}相關需求測試`)
  }
  return { labels, untagged }
}

// ── 預設專案補值 ─────────────────────────────────────────────────────────────

/** 預設那份來源 Sheet（`OSM需求單`）的網址。內容欄位是「摘要」——完整句子，不是乾淨關鍵字，
 *  既有的專案關鍵字比對抓不到，所以 2026-08-17 使用者要求這個來源固定預設 P7-005-OSM。*/
export const DEFAULT_SCAN_SHEET_URL = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'

/**
 * 把「預設來源 Sheet 沒比對到專案就補 P7-005-OSM」這條規則套上去。
 *
 * `sourceRowId` 是 `"{sheetIndex}-{rowIndex}"`，所以開頭 `"0-"` 代表來自第一份 Sheet。
 * **只補沒比對到的**——`projectName` 已經有值就不覆蓋，後端關鍵字比對出來的結果比較準。
 *
 * 前端掃描完會呼叫它，後端要算出「跟頁面一樣的內容」時也呼叫同一支。
 */
export function applyDefaultScanSheetProject(
  draftsByPerson: Record<string, DraftItem[]>,
  firstSheetUrl: string | undefined,
  projects: FieldOption[],
): Record<string, DraftItem[]> {
  if (firstSheetUrl !== DEFAULT_SCAN_SHEET_URL) return draftsByPerson
  const fallback = matchLarkProjectByJiraName(DEFAULT_SCAN_SHEET_PROJECT_NAME, projects)
  if (!fallback) return draftsByPerson
  return Object.fromEntries(Object.entries(draftsByPerson).map(([person, items]) => [
    person,
    items.map(it => (it.sourceRowId.startsWith('0-') && !it.projectName)
      ? { ...it, projectId: fallback.id, projectName: fallback.name }
      : it),
  ]))
}

// ── 草稿 → 送出內容 ───────────────────────────────────────────────────────────

export interface PreviewOptions {
  /** 依 Jira 標題標籤歸集 */
  mergeJiraTags: boolean
  /** 每個人的 P7-005-OSM 項目合併成一條 */
  mergeOsm: boolean
}

/**
 * 把逐人草稿攤平成「實際要寫進 Lark 的那一份」。
 *
 * **轉換順序固定**：原始草稿 → Jira 標籤歸集（依 summary 語意，較細）→ P7-005-OSM 每人合併
 * （依專案，較粗）。兩個開關互相獨立；真的重疊時（Jira 單被歸到 P7-005-OSM）後者把前者結果
 * 再併掉，符合「P7-005-OSM 權重更高」的直覺。
 *
 * ⚠️ 合併那段**必須讀標籤歸集後的結果**而不是原始草稿——不然同時開啟兩個開關時，
 * 後者會把前者的結果整個蓋掉。
 *
 * 這是**衍生轉換，不動原始草稿**：關掉開關完全恢復逐筆，個別編輯過的內容不會因為切換開關而消失。
 */
export function buildPreviewItems(
  draftsByPerson: Record<string, DraftItem[]>,
  options: PreviewOptions,
): FlatItem[] {
  const peopleList = Object.keys(draftsByPerson).sort((a, b) => a.localeCompare(b, 'zh-Hant'))
  const rawFlatItems: FlatItem[] = peopleList.flatMap(person =>
    draftsByPerson[person].map(item => ({ person, item })))

  const tagApplied: FlatItem[] = !options.mergeJiraTags ? rawFlatItems : rawFlatItems.flatMap(({ person, item }) => {
    // 只有帶著 Jira 原始資料的項目才跑這條規則，不從 content 反推單號或標題（CodeX review 建議）
    if (!item.jiraIssues || item.jiraIssues.length === 0) return [{ person, item }]
    const { labels, untagged } = jiraTagGroups(item.jiraIssues)
    if (labels.length === 0 && untagged.length === 0) return [{ person, item }]
    const out: FlatItem[] = labels.map((label, i) => ({
      person,
      item: { ...item, sourceRowId: `${item.sourceRowId} · 標籤${i + 1}`, content: label },
    }))
    // 沒有標籤的單無法歸集，直接寫該張單的標題、一張單一條——它們彼此沒有共同標籤可以合併，
    // 串成一坨只會變成很長一行；標題本身就是人看得懂的描述（使用者指定）。
    for (const iss of untagged) {
      out.push({ person, item: { ...item, sourceRowId: `${item.sourceRowId} · ${iss.key}`, content: iss.summary } })
    }
    return out
  })

  if (!options.mergeOsm) return tagApplied

  return peopleList.flatMap(person => {
    const items = tagApplied.filter(x => x.person === person).map(x => x.item)
    const out: FlatItem[] = []
    let mergedInserted = false
    for (const item of items) {
      // trim 比對：Sheet／Jira 來源的專案名稱可能帶前後空白，不 trim 會漏合併（CodeX review 建議）
      if (item.projectName.trim() === MERGE_PROJECT_NAME) {
        if (mergedInserted) continue
        mergedInserted = true
        out.push({
          person,
          item: {
            sourceRowId: `合併 · ${MERGE_PROJECT_NAME}`,
            content: MERGE_CONTENT,
            projectId: item.projectId,
            projectName: item.projectName,
          },
        })
        continue
      }
      out.push({ person, item })
    }
    return out
  })
}

/** 有幾筆會被 P7-005-OSM 合併規則吃到（畫面上顯示「開啟後會合併 N 筆」用） */
export function countMergeable(draftsByPerson: Record<string, DraftItem[]>): number {
  return Object.values(draftsByPerson)
    .flat()
    .filter(item => item.projectName.trim() === MERGE_PROJECT_NAME).length
}

/** 有幾筆帶著 Jira 原始資料、會被標籤歸集規則處理到 */
export function countJiraTagAffected(draftsByPerson: Record<string, DraftItem[]>): number {
  return Object.values(draftsByPerson)
    .flat()
    .filter(item => item.jiraIssues && item.jiraIssues.length > 0).length
}
