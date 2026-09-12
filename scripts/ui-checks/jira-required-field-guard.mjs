// 批量開單必填防呆的「接線」結構檢查（純靜態分析，不連服務、不開瀏覽器）。
//
// 跑法：node scripts/ui-checks/jira-required-field-guard.mjs
//
// 分工：
//   - 規則本身（哪些欄位算必填、什麼算有填）由 shared/jira-required-fields.test.ts 驗（34 項）
//   - 這支只驗「接線」：前端擋送出、後端補驗，兩邊是不是真的接到那份共用規則上
//
// 為什麼接線也要驗：v3.97.0 為了讓「＋新增欄位」的選填欄位不被誤判成必填，把
// validateDynamicFields() 的條件改成 `field.required && !val`。條件本身是對的，但
// field.required 是 Jira createmeta 自己回的旗標，而描述/受託人/回報人/RD負責人 在 Jira
// 是選填——它們的必填是我們自己加的。於是那四欄變成「畫面標紅星、送出完全不擋」，空值
// 直接開單，而後端當時只擋摘要也不會拒。這種壞法沒有任何徵兆（不報錯、不少列、單子還
// 開得成功），就這樣過了三個月才被發現。
import { readFileSync } from 'node:fs'

const FRONT = 'src/pages/JiraPage.tsx'
const BACK = 'server/routes/jira.ts'
const SHARED = 'shared/jira-required-fields.ts'

// ⚠️ 剝行註解一律用 [^\r\n] 不用 .*$——CRLF 檔案下 `.` 不匹配 \r，用 .*$ 會把 \r 留下，
// 之後的字串比對全部莫名對不上（這個坑踩過）。
const strip = (s) => s.replace(/\/\/[^\r\n]*/g, '')

const read = (p) => strip(readFileSync(p, 'utf8'))

/** 抓出某個宣告的函式本體（大括號配對，不用 regex 猜結尾）*/
function fnBody(text, decl) {
  const at = text.indexOf(decl)
  if (at < 0) return null
  const open = text.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open, i + 1) }
  }
  return null
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

// ─── 共用規則模組 ─────────────────────────────────────────────────────────────
const shared = read(SHARED)
for (const key of ['description', 'assignee', 'reporter', 'customfield_10428']) {
  check(`共用清單仍涵蓋 ${key}`, shared.includes(`'${key}'`))
}
check('共用判斷仍用名稱比對 RD負責人', /RD_OWNER_FIELD_NAME\s*=\s*'RD負責人'/.test(shared))
check(
  'isJiraFieldRequired = Jira 必填 or 強制必填',
  /f\.required\s*\|\|\s*isForcedRequiredJiraField\(f\)/.test(shared),
)

// ─── 前端：擋送出 ─────────────────────────────────────────────────────────────
const front = read(FRONT)
check(
  '前端接到共用規則（有 import）',
  /from '\.\.\/\.\.\/shared\/jira-required-fields\.js'/.test(front),
)
// 防止有人又在前端複製一份清單出來——那正是三個月前那個 bug 的土壤
check(
  '前端沒有自己另寫一份強制必填清單',
  !/f\.key === 'description'/.test(front),
  "出現 `f.key === 'description'` 代表清單被複製回前端了",
)
check(
  'isFieldRequired 委派給共用判斷',
  /const isFieldRequired\s*=[^\r\n]*isJiraFieldRequired\(/.test(front),
)

const validate = fnBody(front, 'const validateDynamicFields =')
check('找得到 validateDynamicFields()', validate)
if (validate) {
  // 核心那條
  check(
    '必填判斷用 isFieldRequired(field)',
    /isFieldRequired\(field\)\s*&&\s*!val/.test(validate),
    '要有 `isFieldRequired(field) && !val`',
  )
  // 反向守：field.required 單獨當必填條件會靜默放行強制必填那四欄
  check(
    '必填判斷沒有退回 field.required',
    !/field\.required\s*&&\s*!val/.test(validate),
    '出現 `field.required && !val` 代表強制必填那四欄又被放行了',
  )
  // 兩個有多來源的欄位要走共用 resolver，否則會出現「送出會用 Sheet 值、驗證卻擋下來」
  check('summary 走 resolveRowSummary()', /resolveRowSummary\(/.test(validate))
  check('description 走 resolveRowDescription()', /resolveRowDescription\(/.test(validate))
}

// 送出路徑與驗證必須共用同一支 description resolver（v4.6.1 摘要那條縫的同型問題）
const handleCreate = fnBody(front, 'const handleCreate =')
check('找得到 handleCreate()', handleCreate)
if (handleCreate) {
  check(
    '送出的 description 走 resolveRowDescription()',
    /description:\s*resolveRowDescription\(/.test(handleCreate),
    '驗證與送出各寫一套 fallback 就會漂',
  )
  check(
    '送出沒有自己另寫一套 description fallback',
    !/rowCells\['description'\]\s*\|\|/.test(handleCreate),
  )
  // 後端只在動態欄位模式才強制回報人，所以模式要真的傳過去
  check(
    '送出有帶 dynamicFieldMode 給後端',
    /dynamicFieldMode:/.test(handleCreate),
  )
}

// ─── 後端：補驗（改 payload 可以繞過前端）──────────────────────────────────────
const back = read(BACK)
check(
  '後端接到共用規則（有 import）',
  /import \{ missingForcedRequiredFields \} from '\.\.\/\.\.\/shared\/jira-required-fields\.js'/.test(back),
)
check(
  '後端沒有自己複製一份判斷',
  !/function missingForcedRequiredFields\(/.test(back),
)
check('後端 schema 收得到 dynamicFieldMode', /dynamicFieldMode:\s*z\.boolean\(\)/.test(back))

const route = fnBody(back, "router.post('/api/jira/batch-create', async")
check('找得到 batch-create route', route)
if (route) {
  check(
    'batch-create 有跑補驗',
    /missingForcedRequiredFields\(row, dynamicFieldMeta/.test(route),
    '只擋摘要的話，改 payload 就能送出缺欄位的單',
  )
  // 擋下來要真的跳過建立，不是記個錯誤然後照樣開單
  check(
    '缺欄位的列會被跳過（不是只記錯誤）',
    /missingRequired\.length > 0\)\s*\{[\s\S]{0,240}?continue/.test(route),
  )
  check('摘要那條原本的防呆還在', /缺少摘要欄位/.test(route))
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`)
}
console.log(`\n${results.length - failed}/${results.length} 通過`)
process.exit(failed > 0 ? 1 : 0)
