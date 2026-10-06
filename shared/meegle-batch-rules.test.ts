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

// ── 欄名別名（第二份 Sheet 叫「填寫人」「RD」）──
{
  const rec2 = { 摘要: 'x', 填寫人: 'felix', RD: 'zen', 進度: '' }
  const p = planRow({ record: rec2 }, defaults, reqs, map)
  eq('「填寫人」當回報者、「RD」當 RD 負責人', [p.roles.reporter.people.map(x => x.userKey), p.roles.rdOwner.people.map(x => x.userKey)], [['uf'], ['uz']])
  eq('沒有 QA 欄 → 空，不報錯', p.roles.qaVerifier.aliases, [])
  const both = planRow({ record: { 摘要: 'x', 回報者: '', 填寫人: 'felix' } }, defaults, reqs, map)
  eq('「回報者」欄存在但這列空白 → 不會改抓「填寫人」', both.roles.reporter.aliases, [])
  eq('欄名前後有空白也認得', planRow({ record: { 摘要: 'x', ' RD ': 'zen' } }, defaults, reqs, map).roles.rdOwner.aliases, ['zen'])
  eq('收集人名也認別名', collectAliases([{ record: rec2 }], { requirementId: '', roles: {} }), ['zen', 'felix'])
}

// ── 重複的標題列（實測第二份 Sheet 第 10、15 列）──
{
  const hdr = { 日期: '日期', 填寫人: '填寫人', 摘要: '摘要', RD: 'RD', 描述: '描述' }
  const p = planRow({ record: hdr }, defaults, reqs, map)
  eq('重複標題列 → 擋，不會開一張叫「摘要」的單', p.blocks, ['這列是重複的標題列，不是資料'])
  eq('重複標題列的欄名不會被當成人名', collectAliases([{ record: hdr }], { requirementId: '', roles: {} }), [])
  eq('只有一格剛好等於欄名（例如類別欄填「類別」）不算', planRow({ record: { ...rec, 類別: '類別' } }, defaults, reqs, map).blocks, [])
}

// ── CodeX review 0c30dde [P2]：值剛好等於欄名的真資料不能被當成標題列 ──
{
  const real = { 摘要: '修正登入驗證失敗', RD: 'RD', QA: 'QA', 填寫人: 'felix' }
  eq('兩格剛好等於欄名、但摘要是真的 → 不擋', planRow({ record: real }, defaults, reqs, map).blocks, [])
  eq('這種列的人名照樣收', collectAliases([{ record: real }], { requirementId: '', roles: {} }).includes('felix'), true)
  eq('摘要欄＝「摘要」→ 一定是標題列', planRow({ record: { 摘要: '摘要', RD: 'RD', 描述: '真的內容', 填寫人: 'felix', 類別: '前端' } }, defaults, reqs, map).blocks, ['這列是重複的標題列，不是資料'])
}

// ── 任務類型（2026-10-06：兩空間都改建立必填；CodeX 定案：逐列 → Sheet → 整批預設，有填但無效就擋、不退回預設）──
{
  const tt = { required: true, options: ['需求', 'BUG'] }
  const plan = (input: Record<string, unknown>, over?: string, def?: string, meta: typeof tt | null = tt) =>
    planRow({ record: { ...rec, ...input }, taskTypeOverride: over }, { ...defaults, taskType: def }, reqs, map, meta)
  eq('必填、哪裡都沒填 → 擋', plan({}).blocks, ['沒有任務類型（Meegle 必填；請選整批預設，或在這列／Sheet 指定）'])
  eq('整批預設 BUG → 帶 BUG', [plan({}, undefined, 'BUG').taskType, plan({}, undefined, 'BUG').blocks], ['BUG', []])
  eq('Sheet 欄優先於整批預設', plan({ 任務類型: '需求' }, undefined, 'BUG').taskType, '需求')
  eq('逐列覆寫優先於 Sheet', plan({ 任務類型: '需求' }, 'BUG', '需求').taskType, 'BUG')
  eq('大小寫／空白不拘，帶正式寫法', plan({ 任務類型: '  bug ' }).taskType, 'BUG')
  const bad = plan({ 任務類型: '缺陷' }, undefined, 'BUG')
  eq('Sheet 填了無效選項 → 擋，**不退回整批預設**', [bad.taskType, bad.blocks], [null, ['Sheet「任務類型」「缺陷」不是 Meegle 的選項（可選：需求、BUG）']])
  eq('整批預設的選項被刪 → 擋', plan({}, undefined, 'Story').blocks.length, 1)
  eq('非必填、沒填 → 可送、不帶', [plan({}, undefined, undefined, { required: false, options: ['BUG'] }).taskType, plan({}, undefined, undefined, { required: false, options: ['BUG'] }).blocks], [null, []])
  eq('非必填、填了無效 → 仍然擋', plan({ 任務類型: 'X' }, undefined, undefined, { required: false, options: ['BUG'] }).blocks.length, 1)
  const none = plan({ 任務類型: 'BUG' }, undefined, undefined, null)
  eq('空間沒有這欄位 → 不帶、只警告', [none.taskType, none.blocks, none.warnings.length], [null, [], 1])
  eq('舊呼叫（沒給 meta）→ 行為不變', planRow({ record: rec }, defaults, reqs, map).blocks, [])
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
