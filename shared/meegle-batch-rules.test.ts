/**
 * Meegle 批量開單列規則的測試。跑法：npx tsx shared/meegle-batch-rules.test.ts
 * 資料取自使用者實際的 Sheet（2026-10-01，136 列）：人員是暱稱、一格多人、CPMS 是團隊名。
 */
import { collectAliases, isRestorablePrevious, normAlias, planRow, splitPeople, type MappedPerson } from './meegle-batch-rules.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const reqs = [{ id: '15170734', name: '系统维护' }, { id: '15171668', name: 'Rust Server' }, { id: '1', name: 'OSM' }, { id: '2', name: 'OSM' }]
const map: Record<string, MappedPerson> = {
  'felix': { userKey: 'uf', email: 'felix@x.tw', name: 'Felix' },
  'zen': { userKey: 'uz', email: 'zen@x.tw', name: 'Zen' },
  'james chang': { userKey: 'uj', email: 'james@x.tw', name: 'James' },
  'dean': { userKey: 'ud', email: 'dean@x.tw', name: 'Dean' },
}
const rec = { 回報者: 'felix', 摘要: 'Free Bet Record頁面內 缺少文字', 描述: 'd', RD負責人: 'zen,James Chang', QA驗證人員: 'felix', 進度: '已上正式' }
const defaults = { requirementId: '15170734', roles: { assignee: ['Dean'] } }

eq('一格多人（逗號、全形逗號、頓號、換行）', splitPeople('zen,James Chang、YC，Xuan\nYukai'), ['zen', 'James Chang', 'YC', 'Xuan', 'Yukai'])
eq('人名正規化', normAlias('  James   Chang '), 'james chang')

{
  const p = planRow({ record: rec }, defaults, reqs, map)
  eq('全部對到 → 沒有擋、沒有警告', [p.blocks, p.warnings], [[], []])
  eq('名稱用摘要', p.name, 'Free Bet Record頁面內 缺少文字')
  eq('沒填需求 → 用整批預設', p.requirement?.id, '15170734')
  eq('RD 兩個人都帶入', p.roles.rdOwner.people.map(x => x.userKey), ['uz', 'uj'])
  eq('受托人用整批預設', p.roles.assignee.people.map(x => x.userKey), ['ud'])
  eq('Code Review 沒預設 → 空', p.roles.codeReview.aliases, [])
}
{
  const p = planRow({ record: { ...rec, RD負責人: 'zen,CPMS' } }, defaults, reqs, map)
  eq('CPMS 對不上 → 不擋整列（使用者決定）', p.blocks, [])
  eq('但要有警告，送出前看得到', p.warnings.length === 1 && p.warnings[0].includes('CPMS'), true)
  eq('對到的人照樣帶', p.roles.rdOwner.people.map(x => x.userKey), ['uz'])
}
{
  const p = planRow({ record: { ...rec, RD負責人: 'Yukai' } }, defaults, reqs, map)
  eq('整格都對不上 → 警告寫「將留空」', p.warnings[0].includes('將留空'), true)
}
{
  const p = planRow({ record: { ...rec, 關聯需求: '不存在的需求' } }, defaults, reqs, map)
  eq('Sheet 有填需求但對不到 → 擋，不退回整批預設', [p.requirement, p.blocks.length], [null, 1])
}
{
  const p = planRow({ record: { ...rec, 關聯需求: 'OSM' } }, defaults, reqs, map)
  eq('同名多筆 → 擋', p.blocks.length, 1)
  const q = planRow({ record: { ...rec, 關聯需求: 'OSM' }, requirementOverride: '2' }, defaults, reqs, map)
  eq('逐列指定 ID 優先於 Sheet 欄', [q.requirement?.id, q.blocks], ['2', []])
}
{
  const p = planRow({ record: rec }, { requirementId: '', roles: {} }, reqs, map)
  eq('沒有預設也沒填 → 擋', p.blocks.some(b => b.includes('沒有關聯需求')), true)
  const q = planRow({ record: rec }, { requirementId: '999', roles: {} }, reqs, map)
  eq('整批預設需求已被刪 → 擋', q.blocks.some(b => b.includes('已不存在')), true)
}
{
  const p = planRow({ record: { ...rec, 摘要: '', 標題: '' } }, defaults, reqs, map)
  eq('沒有摘要也沒有標題 → 擋', p.blocks.some(b => b.includes('任務名稱')), true)
  const q = planRow({ record: { ...rec, 摘要: '', 標題: '用標題' } }, defaults, reqs, map)
  eq('摘要空白 → 用標題', q.name, '用標題')
  const r = planRow({ record: { ...rec, 摘要: '第一行\n第二行' } }, defaults, reqs, map)
  eq('名稱裡的換行換成空白', r.name, '第一行 第二行')
}
{
  const p = planRow({ record: rec, roleOverrides: { rdOwner: [], codeReview: ['zen'] } }, defaults, reqs, map)
  eq('逐列把 RD 清空 → 真的清空（不是退回 Sheet 值）', p.roles.rdOwner.aliases, [])
  eq('逐列指定 Code Review', p.roles.codeReview.people.map(x => x.userKey), ['uz'])
}
eq('「進度」欄不影響任何結果', JSON.stringify(planRow({ record: { ...rec, 進度: '未過退回' } }, defaults, reqs, map)) === JSON.stringify(planRow({ record: rec }, defaults, reqs, map)), true)
eq('收集人名：去重、保留原寫法、含整批預設', collectAliases([{ record: rec }, { record: { ...rec, 回報者: 'FELIX' } }], defaults), ['zen', 'James Chang', 'felix', 'Dean'])

// ── 讀 Sheet 時要接回原批次的歷史列（CodeX review df9b538 [P2]）──
eq('待確認 → 接回', isRestorablePrevious({ createPhase: 'unknown', statePhase: 'none' }), true)
eq('開單中 → 接回', isRestorablePrevious({ createPhase: 'creating', statePhase: 'none' }), true)
eq('已開單、有目標、推狀態前中斷（none）→ 接回，才有重推入口', isRestorablePrevious({ createPhase: 'created', statePhase: 'none', targetStateKey: 'K', workItemId: '1' }), true)
eq('已開單、推狀態失敗 → 接回', isRestorablePrevious({ createPhase: 'created', statePhase: 'failed', targetStateKey: 'K', workItemId: '1' }), true)
eq('已開單、推完了 → 不接回（只標已開過）', isRestorablePrevious({ createPhase: 'created', statePhase: 'done', targetStateKey: 'K', workItemId: '1' }), false)
eq('已開單、沒有目標狀態 → 不接回', isRestorablePrevious({ createPhase: 'created', statePhase: 'none', targetStateKey: '', workItemId: '1' }), false)

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
