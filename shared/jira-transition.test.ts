/**
 * shared/jira-transition 的測試。跑法：npx tsx shared/jira-transition.test.ts
 *
 * 資料取自 2026-10-01 真實 Jira（slphc）回的 /transitions：
 * CGFB 的 `4` 是「本機測試完成」，P5MA 的 `4` 卻是「Done」——舊寫法拿第一張單（CGFB）的 ID 套到 P5MA，
 * 十張單被切成「完成」。這裡守的就是「同一個 transitionId、不同目標」不能再發生。
 */
import { pickTransitionForTarget, targetStatusOptions, type JiraTransitionLike } from './jira-transition.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const t = (id: string, name: string, toId: string, toName: string): JiraTransitionLike => ({ id, name, to: { id: toId, name: toName } })
// 真實資料（2026-10-01）
const CGFB = [t('2', '開發中', '10246', '開發中'), t('3', '本機免測試', '10652', '本機免測試'), t('4', '本機測試完成', '10252', '本機測試完成'),
  t('5', 'C服', '10206', 'C服'), t('6', '不處理', '10212', '不處理'), t('21', 'To Do', '10205', '待辦事項'), t('31', '可本機測試', '10208', '可本機測試'), t('41', 'Done', '10207', '完成')]
const P5MA = [t('2', '本機環境', '10208', '可本機測試'), t('3', '239環境', '10209', '台北測試服'), t('4', 'Done', '10207', '完成'), t('5', '不處理', '10212', '不處理'),
  t('6', '開發中', '10246', '開發中'), t('7', '本機測試完成', '10252', '本機測試完成'), t('8', '本機環境驗證失敗', '10263', '本機環境驗證失敗'),
  t('21', 'To Do', '10205', '待辦事項'), t('31', 'C服', '10206', 'C服'), t('32', '本機免測試', '10652', '本機免測試'), t('33', '暫停', '11208', '暫停')]

const id = (r: ReturnType<typeof pickTransitionForTarget>) => ('transitionId' in r ? r.transitionId : r.code)

// ── 這次出事的情境 ──
eq('目標「本機測試完成」→ CGFB 走 4', id(pickTransitionForTarget(CGFB, '10252')), '4')
eq('目標「本機測試完成」→ P5MA 走 7（不是 4）', id(pickTransitionForTarget(P5MA, '10252')), '7')
eq('目標「完成」→ CGFB 走 41、P5MA 走 4', [id(pickTransitionForTarget(CGFB, '10207')), id(pickTransitionForTarget(P5MA, '10207'))], ['41', '4'])
// transition 名稱不同、目標相同也要對得上
eq('目標「可本機測試」：CGFB 叫「可本機測試」(31)、P5MA 叫「本機環境」(2)', [id(pickTransitionForTarget(CGFB, '10208')), id(pickTransitionForTarget(P5MA, '10208'))], ['31', '2'])

// ── 沒有路徑 ──
const none = pickTransitionForTarget(CGFB, '10263', '本機環境驗證失敗')
eq('CGFB 沒有「本機環境驗證失敗」→ NO_PATH、不送', id(none), 'NO_PATH')
eq('NO_PATH 訊息講清楚是哪個狀態', 'message' in none && none.message.includes('本機環境驗證失敗'), true)
eq('空的 transitions → NO_PATH', id(pickTransitionForTarget([], '10252')), 'NO_PATH')

// ── 同一目標多條路徑 ──
const dup = [...CGFB, t('99', '快速完成', '10252', '本機測試完成')]
eq('同一目標兩條路徑 → AMBIGUOUS，不挑第一條', id(pickTransitionForTarget(dup, '10252')), 'AMBIGUOUS')

// ── 不做名稱比對 ──
eq('只給名稱（不是 ID）對不到 → NO_PATH（不用名稱 fallback）', id(pickTransitionForTarget(P5MA, '本機測試完成')), 'NO_PATH')
eq('同名不同 ID 的狀態不會被當成同一個', id(pickTransitionForTarget([t('7', '本機測試完成', '99999', '本機測試完成')], '10252')), 'NO_PATH')

// ── 選單選項 ──
eq('選單以目標狀態去重', targetStatusOptions(dup).filter(o => o.toId === '10252').length, 1)
eq('選單顯示目標狀態名稱', targetStatusOptions(CGFB).find(o => o.toId === '10207')?.toName, '完成')
eq('沒有 to.id 的不列', targetStatusOptions([{ id: '1', name: 'x' }]).length, 0)

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
