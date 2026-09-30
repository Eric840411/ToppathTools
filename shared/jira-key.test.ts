/**
 * shared/jira-key 的單元測試。純函式，不開瀏覽器也不打網路。
 *
 * 跑法：npx tsx shared/jira-key.test.ts
 *
 * 守的是「合法單號不得被靜默漏掉」：舊規則 `[A-Z]{2,}[0-9]*-\d+` 讓第二碼是數字的
 * 專案代號（P5MA）整批消失，畫面上只是少了幾張，沒有任何錯誤。
 */
import {
  JIRA_KEY_EXACT_RE,
  JIRA_KEY_AT_START_RE,
  JIRA_KEY_IN_TEXT_RE,
  JIRA_KEY_IN_BROWSE_URL_RE,
  JIRA_KEY_BRACKET_PREFIX_RE,
} from './jira-key.js'

let pass = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name + ' | got: ' + g + ' | want: ' + w); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}

const first = (re: RegExp, s: string) => s.match(re)?.[1] ?? null

// ── 這次的 bug：第二碼是數字的代號 ──
eq('完整比對：P5MA-9675', JIRA_KEY_EXACT_RE.test('P5MA-9675'), true)
eq('開頭：P5MA-9675 標題', first(JIRA_KEY_AT_START_RE, 'P5MA-9675 所有桌子未轉換'), 'P5MA-9675')
eq('任意位置：P5MA', first(JIRA_KEY_IN_TEXT_RE, '單號 P5MA-9570 已修'), 'P5MA-9570')
eq('browse 網址：P5MA', first(JIRA_KEY_IN_BROWSE_URL_RE, 'https://slphc.atlassian.net/browse/P5MA-9675'), 'P5MA-9675')
eq('中括號開頭：P5MA', first(JIRA_KEY_BRACKET_PREFIX_RE, '[P5MA-9675]所有桌子未轉換'), 'P5MA-9675')

// ── 原本就抓得到的不能壞 ──
eq('完整比對：CGFB-106', JIRA_KEY_EXACT_RE.test('CGFB-106'), true)
eq('開頭：CGFB-98', first(JIRA_KEY_AT_START_RE, 'CGFB-98'), 'CGFB-98')
eq('browse 網址帶 query', first(JIRA_KEY_IN_BROWSE_URL_RE, 'https://x.atlassian.net/browse/CGFB-106?focusedCommentId=1'), 'CGFB-106')
eq('字母後接數字的代號：CGLD3-1', first(JIRA_KEY_BRACKET_PREFIX_RE, '[CGLD3-1]標題'), 'CGLD3-1')
eq('中括號開頭的標題群組', '[CGLD3-1] 標題'.match(JIRA_KEY_BRACKET_PREFIX_RE)?.[2], ' 標題')
eq('單號後直接接中文', first(JIRA_KEY_AT_START_RE, 'CGFB-98標題'), 'CGFB-98')

// ── 結尾邊界：數字不能被截短；但連結文字黏著標題（真資料）要抓得到 ──
eq('CGFB-12 不能被截成 CGFB-1（任意位置）', first(JIRA_KEY_IN_TEXT_RE, '見 CGFB-12 說明'), 'CGFB-12')
eq('單號黏著標題：CGFB-1Free Bet（真 Sheet 第 50 列）', first(JIRA_KEY_IN_TEXT_RE, 'CGFB-1Free Bet 製作主單'), 'CGFB-1')
eq('單號黏著標題：開頭比對', first(JIRA_KEY_AT_START_RE, 'CGFB-1Free Bet 製作主單'), 'CGFB-1')
eq('完整比對拒絕尾巴', JIRA_KEY_EXACT_RE.test('P5MA-9675abc'), false)

// ── 開頭邊界（任意位置搜尋）：真 Sheet 的 URL 欄讀回公式原文，不能從裡面挖出單號 ──
const formula = 'IFERROR(HYPERLINK("https://slphc.atlassian.net/browse/" & REGEXEXTRACT(Q2, "[A-Z0-9]+-[0-9]+"), REGEXEXTRACT(Q2, "[A-Z0-9]+-[0-9]+")), "")'
eq('公式原文裡的 [A-Z0-9]+-[0-9]+ 不算單號', first(JIRA_KEY_IN_TEXT_RE, formula), null)
eq('P5MA-9570 不能被截成 MA-9570', first(JIRA_KEY_IN_TEXT_RE, 'xP5MA-9570'), null)
eq('前面是中括號照樣抓得到', first(JIRA_KEY_IN_TEXT_RE, '[]:[P5MA-9568][前端]'), 'P5MA-9568')
eq('前面是中文照樣抓得到', first(JIRA_KEY_IN_TEXT_RE, '單號P5MA-9568'), 'P5MA-9568')
eq('公式結果字串裡的單號照樣抓得到', first(JIRA_KEY_IN_TEXT_RE, '", "CGFB-17")'), 'CGFB-17')

// ── 不合法的形狀 ──
eq('數字開頭不算', JIRA_KEY_EXACT_RE.test('5PMA-1'), false)
eq('單一字母不算', JIRA_KEY_EXACT_RE.test('P-1'), false)
eq('小寫不算', JIRA_KEY_EXACT_RE.test('cgfb-1'), false)

// ── 已知限制（寫下來，不是背書）：H5-1 符合格式 ──
eq('H5-1 符合格式（已知限制）', JIRA_KEY_EXACT_RE.test('H5-1'), true)
eq('[前端][H5/PC] 不會被抓成單號', first(JIRA_KEY_IN_TEXT_RE, '[前端][H5/PC] 大廳列表'), null)

// ── 那 37 列的格式：只看開頭／browse 網址的路徑（前端批量評論）這次維持不擷取 ──
const bracketMid = '[]:[CGFB-2][前端][H5/PC] 大廳列表，FreeBet模式製作'
eq('「[]:[CGFB-2]…」開頭比對不擷取', first(JIRA_KEY_AT_START_RE, bracketMid), null)
eq('「[]:[CGFB-2]…」中括號開頭比對不擷取', first(JIRA_KEY_BRACKET_PREFIX_RE, bracketMid), null)

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
