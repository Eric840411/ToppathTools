/**
 * server/lib/spec-chunk 的單元測試。純函式，不打網路。
 *
 * 跑法：npx tsx scripts/ui-checks/spec-chunk.test.ts
 *
 * 守三條容易靜默壞掉的線：
 *   ① 切塊不能掉字（掉了就是「AI 沒看到那段」，而且生成會照樣成功）
 *   ② 合併後編號不能重複（重號在畫面上看起來完全正常，最難用肉眼抓）
 *   ③ 偵測不到編號前綴時不准硬塞（等於捏造資料）
 */
import {
  splitSpecIntoChunks,
  detectNumberPrefix,
  renumberCases,
  describeBatchOutcome,
  runBatched,
} from '../../server/lib/spec-chunk.ts'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

// ── 切塊 ─────────────────────────────────────────────────────────────────────
eq('沒超過上限就不切', splitSpecIntoChunks('短短一段', 100), ['短短一段'])
eq('空字串回空陣列', splitSpecIntoChunks('', 100), [])
eq('只有空白也回空陣列', splitSpecIntoChunks('   \n\n  ', 100), [])

const P = (n: number, len: number) => Array.from({ length: n }, (_, i) =>
  `段落${i + 1}` + '字'.repeat(len - 3)).join('\n\n')

const spec = P(6, 50)          // 6 段，每段 50 字
const chunks = splitSpecIntoChunks(spec, 120)
eq('按段落邊界切成多批', chunks.length > 1, true)
eq('每批都不超過上限', chunks.every(c => c.length <= 120), true)
// ⚠️ 最重要的一條：切完不能掉字
eq('切塊前後字元總數守恆（去掉分隔符後）',
  chunks.join('').replace(/\s/g, '').length, spec.replace(/\s/g, '').length)
eq('沒有空批次', chunks.every(c => c.trim().length > 0), true)
// 不硬切：每批的開頭都應該是某個段落的開頭
eq('每批都從段落開頭起始', chunks.every(c => /^段落\d/.test(c)), true)

// 單一段落自己就超過上限 → 只能硬切它，但不能因此丟掉
const huge = '超長'.repeat(200)          // 400 字，無段落分隔
const hugeChunks = splitSpecIntoChunks(huge, 150)
eq('單段超長時仍會切開', hugeChunks.length, 3)
eq('單段超長切完也不掉字', hugeChunks.join(''), huge)

// 混合：正常段落 + 一個超長段落
const mixed = ['短段一', '超長'.repeat(100), '短段二'].join('\n\n')
const mixedChunks = splitSpecIntoChunks(mixed, 80)
eq('混合情況不掉字',
  mixedChunks.join('').replace(/\s/g, ''), mixed.replace(/\s/g, ''))
eq('limit <= 0 會擋下來', (() => {
  try { splitSpecIntoChunks('x', 0); return '沒擋' } catch { return '有擋' }
})(), '有擋')

// ── 編號前綴偵測 ─────────────────────────────────────────────────────────────
eq('抓得到底線前綴', detectNumberPrefix([{ 編號: 'POS_ROOM_001' }]), 'POS_ROOM_')
eq('抓得到連字號前綴', detectNumberPrefix([{ 編號: 'TC-012' }]), 'TC-')
eq('前面幾筆沒編號也能往後找', detectNumberPrefix([{}, { 編號: '' }, { 編號: 'AB_007' }]), 'AB_')
eq('完全沒編號回 null', detectNumberPrefix([{ 測試標題: 'x' } as never]), null)
// ⚠️ 純數字編號不動它——那可能是別的模板的既有格式
eq('純數字編號不算前綴', detectNumberPrefix([{ 編號: '001' }]), null)

// ── 重編號 ───────────────────────────────────────────────────────────────────
// 模擬兩批合併：兩批都從 001 開始 → 合併後重號
const merged = [
  { 編號: 'POS_ROOM_001', 測試標題: 'A' },
  { 編號: 'POS_ROOM_002', 測試標題: 'B' },
  { 編號: 'POS_ROOM_001', 測試標題: 'C' },   // ← 第二批的第一筆
  { 編號: 'POS_ROOM_002', 測試標題: 'D' },
]
eq('合併後原本真的有重號（證明這條測試驗得到東西）',
  new Set(merged.map(c => c.編號)).size, 2)
const fixed = renumberCases(merged)
eq('重編後編號不重複', new Set(fixed.map(c => c.編號)).size, 4)
eq('重編後依序遞增', fixed.map(c => c.編號),
  ['POS_ROOM_001', 'POS_ROOM_002', 'POS_ROOM_003', 'POS_ROOM_004'])
eq('重編不動其他欄位', fixed.map(c => c.測試標題), ['A', 'B', 'C', 'D'])
eq('不會就地改動原陣列', merged[2].編號, 'POS_ROOM_001')

// 🚨 前綴帶語意：CG_TestCase 的編號是「類型_類別_序號」（POS_ROOM / NEG_LOBBY…）。
// 全域套同一個前綴的話，負面測試會被改寫成 POS_ROOM_xxx——資料被竄改而且看不出來。
const multi = [
  { 編號: 'POS_ROOM_001', t: 'a' },
  { 編號: 'NEG_LOBBY_001', t: 'b' },
  { 編號: 'POS_ROOM_002', t: 'c' },
  { 編號: 'NEG_LOBBY_001', t: 'd' },   // ← 第二批的負面案例，跟 b 撞號
  { 編號: 'BND_BACK_001', t: 'e' },
]
const multiFixed = renumberCases(multi)
eq('不同前綴各自編號，不會被併成同一個前綴',
  multiFixed.map(c => c.編號),
  ['POS_ROOM_001', 'NEG_LOBBY_001', 'POS_ROOM_002', 'NEG_LOBBY_002', 'BND_BACK_001'])
eq('重編後每個前綴內都不重複',
  new Set(multiFixed.map(c => c.編號)).size, multi.length)
eq('前綴本身一個都沒被改掉',
  multiFixed.map(c => String(c.編號).replace(/\d+$/, '')),
  ['POS_ROOM_', 'NEG_LOBBY_', 'POS_ROOM_', 'NEG_LOBBY_', 'BND_BACK_'])
eq('順序不變', multiFixed.map(c => c.t), ['a', 'b', 'c', 'd', 'e'])

// 沒有編號的模板一律不動——硬塞編號等於捏造資料
const noNum = [{ 測試標題: 'A' }, { 測試標題: 'B' }]
eq('沒有編號欄位時原樣返回', renumberCases(noNum as never), noNum)
eq('沒有編號欄位時不會長出編號',
  renumberCases(noNum as never).every(c => !('編號' in c)), true)

// 同一批裡有些有編號、有些沒有（AI 偶爾會漏欄位）→ 只動有編號的
const mixedNum = [{ 編號: 'A_001', t: 'x' }, { t: 'y' }, { 編號: 'A_001', t: 'z' }]
const mixedNumFixed = renumberCases(mixedNum as never) as { 編號?: string; t: string }[]
eq('沒編號的那筆不會長出編號', '編號' in mixedNumFixed[1], false)
eq('有編號的仍正確重編',
  [mixedNumFixed[0].編號, mixedNumFixed[2].編號], ['A_001', 'A_002'])

// 超過 999 筆時位數要跟著長，否則會出現 POS_1000 跟 POS_001 混排
const many = Array.from({ length: 1200 }, () => ({ 編號: 'X_001' }))
const manyFixed = renumberCases(many)
eq('破千時補零位數跟著長', manyFixed[0].編號, 'X_0001')
eq('破千時最後一筆正確', manyFixed[1199].編號, 'X_1200')
eq('破千時仍然全部不重複', new Set(manyFixed.map(c => c.編號)).size, 1200)

// ── 批次結果描述 ─────────────────────────────────────────────────────────────
eq('沒分批時不出訊息', describeBatchOutcome({ total: 1, succeeded: 1, failures: [] }), '')
eq('全部成功也要講（不能讓人以為沒分批）',
  describeBatchOutcome({ total: 3, succeeded: 3, failures: [] }), '規格書分 3 批生成，全部成功。')
const partial = describeBatchOutcome({ total: 3, succeeded: 2, failures: [{ index: 2, error: 'boom' }] })
eq('部分失敗要講幾批成功', partial.includes('2/3'), true)
eq('部分失敗要指出是第幾批', partial.includes('第 2 批'), true)
// ⚠️ 最關鍵：不能讓使用者以為結果是完整的
eq('部分失敗要明說結果不完整', partial.includes('沒有包含在結果裡'), true)

// ── runBatched（合併與部分失敗）────────────────────────────────────────────
// 這段本來在 route 的迴圈裡，抽出來就是為了驗「合併」跟「某批失敗」這兩條路徑。
const arrOf = (...ids: string[]) => ids.map(id => ({ 編號: id }))

{
  const r = await runBatched(['a', 'b', 'c'], async (_c, _l, i) => arrOf(`P_00${i + 1}`))
  eq('全部成功時三批都收進來', r.collected.length, 3)
  eq('全部成功時沒有 failures', r.failures, [])
}
{
  // 第 2 批丟錯：其餘仍要保留
  // ⚠️ 要先確認 runBatched **自己不會把錯往外丟**——往外丟的話下面幾條根本跑不到，
  // 整支測試會以未捕捉例外中斷，看起來像「沒有失敗」而不是「這條沒過」。
  let threw = ''
  let r: Awaited<ReturnType<typeof runBatched<{ 編號: string }>>> | null = null
  try {
    r = await runBatched(['a', 'b', 'c'], async (_c, _l, i) => {
      if (i === 1) throw new Error('boom')
      return arrOf(`P_00${i + 1}`)
    })
  } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  eq('單批失敗時 runBatched 不會把錯往外丟', threw, '')
  eq('單批失敗不影響其他批', r?.collected.length ?? -1, 2)
  eq('失敗批次序號是 1-based', r?.failures.map(f => f.index) ?? [], [2])
  eq('失敗原因有記下來', r?.failures[0]?.error ?? '', 'boom')
}
{
  // 全部失敗：collected 是空的，呼叫端要據此丟錯（不能當成「這份規格沒有案例」）
  const r = await runBatched(['a', 'b'], async () => { throw new Error('all dead') })
  eq('全部失敗時 collected 為空', r.collected.length, 0)
  eq('全部失敗時 failures 有兩筆', r.failures.length, 2)
}
{
  // Jira 格式：{ feature_name, test_cases }
  const r = await runBatched(['a', 'b'], async (_c, _l, i) =>
    ({ feature_name: i === 0 ? '抽獎 4.0' : '', test_cases: arrOf(`J_00${i + 1}`) }))
  eq('Jira 格式的 test_cases 會被攤平', r.collected.length, 2)
  eq('取第一個非空的 feature_name', r.featureName, '抽獎 4.0')
}
{
  // ⚠️ 第一批失敗、第二批才有 feature_name —— 不能因為第一批掛了就丟掉名稱
  const r = await runBatched(['a', 'b'], async (_c, _l, i) => {
    if (i === 0) throw new Error('x')
    return { feature_name: '後來才有的名稱', test_cases: arrOf('J_001') }
  })
  eq('第一批失敗時仍取得到後面的 feature_name', r.featureName, '後來才有的名稱')
}

console.log('')
console.log(`${pass}/${pass + fails.length} 通過`)
if (fails.length) {
  console.log('')
  console.log('失敗：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
