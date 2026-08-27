/**
 * shared/weekly-report-rules 的單元測試。純函式，不開瀏覽器也不打網路。
 *
 * 跑法：npx tsx shared/weekly-report-rules.test.ts
 *
 * 這裡守的是「規則抽成共用之後行為沒變」那條線。案例直接取自 CLAUDE.md 第 23 節裡
 * 使用者當面確認過的那張對照表——那是規格本身，不是我事後推導的。
 */
import {
  MERGE_PROJECT_NAME, MERGE_CONTENT,
  leadingTags, jiraTagGroups, matchLarkProjectByJiraName, normalizeProjectName,
  buildPreviewItems, countMergeable, countJiraTagAffected,
  type DraftItem,
} from './weekly-report-rules.js'

let pass = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; return }
  fails.push(`${name}\n    得到 ${g}\n    預期 ${w}`)
}

// ── leadingTags：只吃開頭，本文中間的中括號不算 ──────────────────────────────
eq('開頭連續標籤', leadingTags('[OSM][GM]修正顯示'), ['OSM', 'GM'])
eq('沒有標籤', leadingTags('修正顯示問題'), [])
eq('中間的中括號不算', leadingTags('修正 [OSM] 顯示問題'), [])
eq('標籤內留白會 trim', leadingTags('[ OSM ][GM]x'), ['OSM', 'GM'])

// ── jiraTagGroups：使用者當面確認的四個案例 ─────────────────────────────────
eq('三張單只有 OSM 共同 → 一條',
  jiraTagGroups([
    { key: 'A-1', summary: '[OSM][GM][API日誌]a' },
    { key: 'A-2', summary: '[OSM][API、GW]b' },
    { key: 'A-3', summary: '[OSM][後端]c' },
  ]).labels,
  ['OSM相關需求測試'])

eq('兩張都是 OSM H5 → 共同標籤兩個都留',
  jiraTagGroups([
    { key: 'B-1', summary: '[OSM][H5]a' },
    { key: 'B-2', summary: '[OSM][H5]b' },
  ]).labels,
  ['OSM H5相關需求測試'])

eq('第一個標籤不同 → 拆成兩條，不是串成一句',
  jiraTagGroups([
    { key: 'C-1', summary: '[OSM][GM]a' },
    { key: 'C-2', summary: '[LuckyLink][後端]b' },
  ]).labels,
  ['OSM GM相關需求測試', 'LuckyLink 後端相關需求測試'])

eq('沒有中括號的單獨立列出、保留標題',
  jiraTagGroups([{ key: 'D-1', summary: '修一個東西' }]).untagged,
  [{ key: 'D-1', summary: '修一個東西' }])

// ── 專案名稱比對 ─────────────────────────────────────────────────────────────
const projects = [
  { id: 'p1', name: 'P7-005-OSM' },
  { id: 'p2', name: 'P7-007-第三方測試' },
]
eq('正規化去掉空白與連字號', normalizeProjectName('P7-007 第三方測試'), 'p7007第三方測試')
eq('空格版對得到連字號版', matchLarkProjectByJiraName('P7-007 第三方測試', projects)?.id, 'p2')
eq('完全對不到回 undefined 不亂猜', matchLarkProjectByJiraName('完全不存在的專案', projects), undefined)
eq('空字串不比對', matchLarkProjectByJiraName('', projects), undefined)

// ── buildPreviewItems ────────────────────────────────────────────────────────
const osm = (n: string): DraftItem => ({ sourceRowId: n, content: n, projectId: 'p1', projectName: MERGE_PROJECT_NAME })
const other = (n: string): DraftItem => ({ sourceRowId: n, content: n, projectId: 'p2', projectName: '別的專案' })

eq('兩個開關都關 → 原封不動',
  buildPreviewItems({ Eric: [osm('a'), osm('b'), other('c')] }, { mergeJiraTags: false, mergeOsm: false })
    .map(x => x.item.content),
  ['a', 'b', 'c'])

eq('開 OSM 合併 → 同一人的 P7-005-OSM 併成一條，其他項目不動',
  buildPreviewItems({ Eric: [osm('a'), osm('b'), other('c')] }, { mergeJiraTags: false, mergeOsm: true })
    .map(x => x.item.content),
  [MERGE_CONTENT, 'c'])

eq('合併是「每個人各自」，不是全部人併成一條',
  buildPreviewItems({ Eric: [osm('a'), osm('b')], Lusa: [osm('c')] }, { mergeJiraTags: false, mergeOsm: true })
    .map(x => `${x.person}:${x.item.content}`),
  [`Eric:${MERGE_CONTENT}`, `Lusa:${MERGE_CONTENT}`])

eq('專案名稱前後有空白也要併得到（不 trim 會漏）',
  buildPreviewItems({ Eric: [{ ...osm('a'), projectName: ` ${MERGE_PROJECT_NAME} ` }, osm('b')] },
    { mergeJiraTags: false, mergeOsm: true }).length,
  1)

const jiraItem: DraftItem = {
  sourceRowId: 'Jira · Eric', content: 'X-1、X-2', projectId: 'p2', projectName: '別的專案',
  jiraIssues: [{ key: 'X-1', summary: '[OSM][GM]a' }, { key: 'X-2', summary: '[LuckyLink][後端]b' }],
}
eq('開標籤歸集 → 一筆草稿拆成兩條描述',
  buildPreviewItems({ Eric: [jiraItem] }, { mergeJiraTags: true, mergeOsm: false }).map(x => x.item.content),
  ['OSM GM相關需求測試', 'LuckyLink 後端相關需求測試'])

eq('沒有 jiraIssues 的項目不受標籤歸集影響',
  buildPreviewItems({ Eric: [other('c')] }, { mergeJiraTags: true, mergeOsm: false }).map(x => x.item.content),
  ['c'])

// 順序：標籤歸集先跑，再跑 OSM 合併。合併那段必須讀歸集後的結果，
// 不然同時開兩個開關時會把歸集結果整個蓋掉（這是 2026-08-20 定案的順序）
const jiraOsmItem: DraftItem = {
  sourceRowId: 'Jira · Eric', content: 'Y-1', projectId: 'p1', projectName: MERGE_PROJECT_NAME,
  jiraIssues: [{ key: 'Y-1', summary: '[OSM][GM]a' }],
}
eq('兩個開關同時開 → OSM 合併吃掉歸集結果（P7-005-OSM 權重較高）',
  buildPreviewItems({ Eric: [jiraOsmItem, other('c')] }, { mergeJiraTags: true, mergeOsm: true })
    .map(x => x.item.content),
  [MERGE_CONTENT, 'c'])

eq('人員排序穩定（zh-Hant）',
  buildPreviewItems({ Lusa: [other('b')], Eric: [other('a')] }, { mergeJiraTags: false, mergeOsm: false })
    .map(x => x.person),
  ['Eric', 'Lusa'])

// ── 計數 ─────────────────────────────────────────────────────────────────────
eq('countMergeable 算的是原始草稿裡有幾筆會被併', countMergeable({ Eric: [osm('a'), osm('b'), other('c')] }), 2)
eq('countJiraTagAffected 只算帶 jiraIssues 的', countJiraTagAffected({ Eric: [jiraItem, other('c')] }), 1)

// ── 結果 ─────────────────────────────────────────────────────────────────────
console.log(`\n通過 ${pass} 項`)
if (fails.length) {
  console.log(`\n失敗 ${fails.length} 項：`)
  for (const f of fails) console.log(`  ❌ ${f}`)
  process.exit(1)
}
console.log('全部通過 ✅')
