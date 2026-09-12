/**
 * shared/jira-required-fields 的單元測試。純函式，不開瀏覽器也不打網路。
 *
 * 跑法：npx tsx shared/jira-required-fields.test.ts
 *
 * 這裡守的是「必填不得被靜默放行」那條線。v3.97.0～v4.133.4 之間前端就是這樣壞的：
 * 拿 Jira createmeta 的 required 當條件，而強制必填那四欄在 Jira 是選填，於是畫面標紅星、
 * 送出完全不擋。後端更久——它從頭到尾只擋摘要。這兩種壞法都不會報錯、單子還開得成功，
 * 所以只能靠測試守。
 */
import {
  isForcedRequiredJiraField,
  isJiraFieldRequired,
  hasFilledJiraValue,
  missingForcedRequiredFields,
  FORCED_REQUIRED_JIRA_FIELD_KEYS,
  type JiraFieldLike,
} from './jira-required-fields.js'

let pass = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name + ' | got: ' + g + ' | want: ' + w); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}

const f = (key: string, name: string, required = false): JiraFieldLike => ({ key, name, required })

// ── 判斷本身 ──────────────────────────────────────────────────────────────────
eq('描述是強制必填', isForcedRequiredJiraField(f('description', '描述')), true)
eq('受託人是強制必填', isForcedRequiredJiraField(f('assignee', '受託人')), true)
eq('回報人是強制必填', isForcedRequiredJiraField(f('reporter', '回報人')), true)
eq('customfield_10428 是強制必填', isForcedRequiredJiraField(f('customfield_10428', 'RD負責人')), true)
// 別的專案的 RD負責人是不同的 customfield id（跟週報「QA驗證人員」同一個坑），靠名稱認
eq('別的專案的 RD負責人靠名稱也認得', isForcedRequiredJiraField(f('customfield_99999', 'RD負責人')), true)
eq('一般選填欄位不是強制必填', isForcedRequiredJiraField(f('customfield_10001', '難易度')), false)

// 這條是 v3.97.0 那個 bug 的核心：Jira 說選填，但我們說必填
eq('Jira 標選填的描述仍然算必填', isJiraFieldRequired(f('description', '描述', false)), true)
eq('Jira 標必填的欄位當然算必填', isJiraFieldRequired(f('summary', '摘要', true)), true)
eq('Jira 標選填的一般欄位不算必填', isJiraFieldRequired(f('customfield_10001', '難易度', false)), false)

// ── 有沒有填 ──────────────────────────────────────────────────────────────────
eq('空字串沒填', hasFilledJiraValue(''), false)
eq('只有空白沒填', hasFilledJiraValue('   '), false)
eq('undefined 沒填', hasFilledJiraValue(undefined), false)
eq('有字算填了', hasFilledJiraValue('x'), true)
eq('數字 0 算填了', hasFilledJiraValue(0), true)
// ⚠️ 這條最重要：前端對「Sheet 人名對不到帳號」的 user 欄位送出的就是 { accountId: '' }
eq('accountId 空字串沒填', hasFilledJiraValue({ accountId: '' }), false)
eq('accountId 有值算填了', hasFilledJiraValue({ accountId: 'abc' }), true)
eq('空陣列沒填', hasFilledJiraValue([]), false)
eq('陣列裡全是空值沒填', hasFilledJiraValue([{ accountId: '' }]), false)
eq('陣列裡有一個有值算填了', hasFilledJiraValue([{ accountId: '' }, { accountId: 'a' }]), true)

// ── 逐列判斷（動態欄位模式）────────────────────────────────────────────────────
const META = new Map<string, JiraFieldLike>([
  ['summary', f('summary', '摘要', true)],
  ['description', f('description', '描述')],
  ['assignee', f('assignee', '受託人')],
  ['reporter', f('reporter', '回報人')],
  ['customfield_10428', f('customfield_10428', 'RD負責人')],
  ['customfield_10001', f('customfield_10001', '難易度')],
])
const DYN = { requireReporter: true }

eq('動態模式四欄都填 → 不缺',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', assignee: { accountId: 'a' }, reporter: { accountId: 'b' },
    customfield_10428: [{ accountId: 'c' }],
  } }, META, DYN), [])

eq('動態模式全空 → 四欄都缺',
  missingForcedRequiredFields({ dynamicFields: {} }, META, DYN),
  ['描述', '受託人', '回報人', 'RD負責人'])

eq('動態模式只缺受託人',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', reporter: { accountId: 'b' }, customfield_10428: [{ accountId: 'c' }],
  } }, META, DYN), ['受託人'])

// 這條是「人名對不到帳號」那個洞：欄位有送、但 accountId 是空的
eq('受託人只送了空 accountId → 仍算缺',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', assignee: { accountId: '' }, reporter: { accountId: 'b' },
    customfield_10428: [{ accountId: 'c' }],
  } }, META, DYN), ['受託人'])

eq('選填欄位空著不會被擋',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', assignee: { accountId: 'a' }, reporter: { accountId: 'b' },
    customfield_10428: [{ accountId: 'c' }], customfield_10001: '',
  } }, META, DYN), [])

// ── 逐列判斷（傳統模式：值在 payload 頂層、且不要求回報人）──────────────────────
const LEGACY = { requireReporter: false }
eq('傳統模式頂層欄位認得',
  missingForcedRequiredFields({
    description: '內容', assigneeAccountId: 'a', rdOwnerAccountId: 'c',
  }, META, LEGACY), [])

eq('傳統模式不要求回報人',
  missingForcedRequiredFields({
    description: '內容', assigneeAccountId: 'a', rdOwnerAccountId: 'c', reporterAccountId: '',
  }, META, LEGACY), [])

eq('動態模式就會要求回報人',
  missingForcedRequiredFields({
    description: '內容', assigneeAccountId: 'a', rdOwnerAccountId: 'c', reporterAccountId: '',
  }, META, DYN), ['回報人'])

eq('傳統模式缺描述與 RD負責人',
  missingForcedRequiredFields({ assigneeAccountId: 'a' }, META, LEGACY), ['描述', 'RD負責人'])

// ── createmeta 拿不到時 ───────────────────────────────────────────────────────
const NO_META = new Map<string, JiraFieldLike>()
eq('沒有 meta 時退回常數清單',
  missingForcedRequiredFields({ dynamicFields: {} }, NO_META, DYN),
  ['描述', '受託人', '回報人', 'RD負責人'])
eq('沒有 meta 時的 key 數量與常數清單一致', FORCED_REQUIRED_JIRA_FIELD_KEYS.length, 4)

// ⚠️ 這幾條守的是「不要把常數清單跟 meta 聯集」：別的專案的 RD負責人是 customfield_99999，
// 聯集的話會連 customfield_10428 一起要求，而它根本不在這個專案的建立畫面上——結果是
// 每一列都被擋、而且擋的理由不存在。
const OTHER_PROJECT_META = new Map<string, JiraFieldLike>([
  ['description', f('description', '描述')],
  ['assignee', f('assignee', '受託人')],
  ['reporter', f('reporter', '回報人')],
  ['customfield_99999', f('customfield_99999', 'RD負責人')],
])
eq('別的專案：只要求該專案真正存在的 RD負責人欄位',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', assignee: { accountId: 'a' }, reporter: { accountId: 'b' },
    customfield_99999: [{ accountId: 'c' }],
  } }, OTHER_PROJECT_META, DYN), [])
eq('別的專案：缺的是 RD負責人（不會多報一個不存在的欄位）',
  missingForcedRequiredFields({ dynamicFields: {
    description: '內容', assignee: { accountId: 'a' }, reporter: { accountId: 'b' },
  } }, OTHER_PROJECT_META, DYN), ['RD負責人'])
eq('別的專案：rdOwnerAccountId 頂層值也對得到該專案的欄位',
  missingForcedRequiredFields({
    description: '內容', assigneeAccountId: 'a', rdOwnerAccountId: 'c',
  }, OTHER_PROJECT_META, LEGACY), [])

// 建立畫面上沒有描述欄位的專案，就不該要求描述（跟前端 requiredJiraFields 同一份資料）
const NO_DESC_META = new Map<string, JiraFieldLike>([['assignee', f('assignee', '受託人')]])
eq('meta 裡沒有的欄位不會被要求',
  missingForcedRequiredFields({ dynamicFields: { assignee: { accountId: 'a' } } }, NO_DESC_META, DYN), [])

console.log('')
console.log(pass + '/' + (pass + fails.length) + ' 通過')
if (fails.length > 0) {
  console.log('')
  console.log('失敗：')
  for (const item of fails) console.log('  - ' + item)
  process.exit(1)
}
