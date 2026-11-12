/**
 * `shared/uat-tc-retarget.ts` 的測試。
 *
 * ⚠️ **跑的是產品那一份**，測試裡不重寫任何配對規則——
 *    抄一份的話驗的是抄的那份，產品改壞了照樣全綠。
 *
 * 用法：node --experimental-strip-types --test shared/uat-tc-retarget.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planTcRetarget, applyTcRetarget, retargetBlockers, normalizeTcNumber,
  snapshotOf, restoreFromSnapshot,
} from './uat-tc-retarget.ts'

const b = (recordId: string, number: string, tableId = 'tblOLD') =>
  ({ recordId, tableId, number, text: `舊-${number}`, sub: '' })
const t = (recordId: string, number: string) => ({ recordId, number, text: `新-${number}`, sub: '' })

test('編號兩邊都唯一且非空 → 給建議', () => {
  const plan = planTcRetarget([b('rOld1', 'TC-001')], [t('rNew1', 'TC-001'), t('rNew2', 'TC-002')])
  assert.equal(plan[0].reason, 'matched')
  assert.equal(plan[0].suggestion?.recordId, 'rNew1')
})

test('編號比對忽略大小寫與前後空白（複製挪用常見）', () => {
  const plan = planTcRetarget([b('rOld1', ' tc-001 ')], [t('rNew1', 'TC-001')])
  assert.equal(plan[0].suggestion?.recordId, 'rNew1')
})

test('舊綁定沒有編號 → 不猜', () => {
  const plan = planTcRetarget([b('rOld1', '')], [t('rNew1', 'TC-001')])
  assert.equal(plan[0].reason, 'number-empty')
  assert.equal(plan[0].suggestion, null)
})

test('編號在新表重複 → 不猜', () => {
  const plan = planTcRetarget([b('rOld1', 'TC-001')], [t('rNew1', 'TC-001'), t('rNew2', 'TC-001')])
  assert.equal(plan[0].reason, 'number-duplicate')
  assert.equal(plan[0].suggestion, null)
})

test('編號在舊腳本裡重複 → 兩筆都不猜（只查新表會漏掉這種）', () => {
  const plan = planTcRetarget([b('rOldA', 'TC-001'), b('rOldB', 'TC-001')], [t('rNew1', 'TC-001')])
  assert.deepEqual(plan.map(p => p.reason), ['number-duplicate', 'number-duplicate'])
})

test('新表沒有這個編號 → not-found', () => {
  const plan = planTcRetarget([b('rOld1', 'TC-999')], [t('rNew1', 'TC-001')])
  assert.equal(plan[0].reason, 'not-found')
})

test('套用時：表格、綁定、步驟歸屬一起換', () => {
  const r = applyTcRetarget({
    newTableId: 'tblNEW', newLarkUrl: 'https://x/base/app?table=tblNEW',
    oldBindings: [b('rOld1', 'TC-001'), b('rOld2', 'TC-002')],
    steps: [{ tcId: 'rOld1', action: 'click' }, { tcId: 'rOld2', action: 'read' }, { tcId: null, action: 'goto' }],
    decisions: { rOld1: 'rNew1', rOld2: 'rNew2' },
    newTcs: [t('rNew1', 'TC-001'), t('rNew2', 'TC-002')],
  })
  assert.deepEqual(r.bindings.map(x => x.recordId), ['rNew1', 'rNew2'])
  assert.ok(r.bindings.every(x => x.tableId === 'tblNEW'))
  assert.deepEqual(r.steps.map(s => s.tcId), ['rNew1', 'rNew2', null])
  assert.equal(r.unresolved.length, 0)
})

test('🚨 沒接上的步驟：tcId 保留原值，不可以清成 null', () => {
  const r = applyTcRetarget({
    newTableId: 'tblNEW', newLarkUrl: '',
    oldBindings: [b('rOld1', 'TC-001'), b('rOld2', 'TC-002')],
    steps: [{ tcId: 'rOld1' }, { tcId: 'rOld2' }],
    decisions: { rOld1: 'rNew1' },   // rOld2 沒決定
    newTcs: [t('rNew1', 'TC-001')],
  })
  assert.deepEqual(r.steps.map(s => s.tcId), ['rNew1', 'rOld2'])
  assert.deepEqual(r.unresolved.map(u => u.recordId), ['rOld2'])
})

test('決定指到新表沒有的 recordId → 當成未解決並回報', () => {
  const r = applyTcRetarget({
    newTableId: 'tblNEW', newLarkUrl: '',
    oldBindings: [b('rOld1', 'TC-001')],
    steps: [{ tcId: 'rOld1' }],
    decisions: { rOld1: 'rGHOST' },
    newTcs: [t('rNew1', 'TC-001')],
  })
  assert.deepEqual(r.invalidDecisions, ['rGHOST'])
  assert.deepEqual(r.unresolved.map(u => u.recordId), ['rOld1'])
  assert.equal(r.bindings.length, 0)
})

test('兩筆舊綁定不能接到同一個新 TC（會讓步驟歸屬合併、回寫互相覆蓋）', () => {
  const r = applyTcRetarget({
    newTableId: 'tblNEW', newLarkUrl: '',
    oldBindings: [b('rOldA', 'TC-001'), b('rOldB', 'TC-002')],
    steps: [{ tcId: 'rOldA' }, { tcId: 'rOldB' }],
    decisions: { rOldA: 'rNew1', rOldB: 'rNew1' },
    newTcs: [t('rNew1', 'TC-001')],
  })
  assert.deepEqual(r.bindings.map(x => x.recordId), ['rNew1'])
  assert.deepEqual(r.unresolved.map(u => u.recordId), ['rOldB'])
})

test('還有步驟指著舊 TC → 擋下執行，訊息要看得懂', () => {
  const blockers = retargetBlockers({
    tableId: 'tblNEW',
    bindings: [{ recordId: 'rNew1', tableId: 'tblNEW', number: 'TC-001', text: '', sub: '' }],
    steps: [{ tcId: 'rNew1' }, { tcId: 'rOld2' }],
  })
  assert.equal(blockers.length, 1)
  assert.match(blockers[0], /換表前的 TC/)
})

test('綁定不屬於目前表格 → 也要擋', () => {
  const blockers = retargetBlockers({
    tableId: 'tblNEW',
    bindings: [{ recordId: 'rX', tableId: 'tblOLD', number: '', text: '', sub: '' }],
    steps: [],
  })
  assert.match(blockers.join(' '), /不屬於目前的表格/)
})

test('全部接好之後沒有 blocker', () => {
  assert.deepEqual(retargetBlockers({
    tableId: 'tblNEW',
    bindings: [{ recordId: 'rNew1', tableId: 'tblNEW', number: 'TC-001', text: '', sub: '' }],
    steps: [{ tcId: 'rNew1' }, { tcId: null }],
  }), [])
})

test('normalizeTcNumber 收全形空白', () => {
  assert.equal(normalizeTcNumber('　TC-001　'), 'TC-001')
})

test('備份：步驟歸屬要一起存，只存 bindings 還原不回來', () => {
  const snap = snapshotOf({
    larkUrl: 'u', tableId: 'tblOLD',
    bindings: [b('rOld1', 'TC-001')],
    steps: [{ tcId: 'rOld1' }, { tcId: null }, { tcId: 'rOld1' }],
  })
  assert.deepEqual(snap.stepOwners, [[0, 'rOld1'], [1, null], [2, 'rOld1']])
})

test('還原：表格、綁定、步驟歸屬都退回去', () => {
  const snap = snapshotOf({
    larkUrl: 'old-url', tableId: 'tblOLD',
    bindings: [b('rOld1', 'TC-001')],
    steps: [{ tcId: 'rOld1' }, { tcId: 'rOld1' }],
  })
  // 換表之後步驟歸屬已經變成新表的
  const after = [{ tcId: 'rNew1' }, { tcId: 'rNew1' }]
  const r = restoreFromSnapshot(snap, after)
  assert.equal(r.tableId, 'tblOLD')
  assert.equal(r.larkUrl, 'old-url')
  assert.deepEqual(r.steps.map(s => s.tcId), ['rOld1', 'rOld1'])
})

test('🚨 還原時後來新增的步驟不可以被動到（索引超出備份範圍）', () => {
  const snap = snapshotOf({
    larkUrl: '', tableId: 'tblOLD',
    bindings: [], steps: [{ tcId: 'rOld1' }],
  })
  const after = [{ tcId: 'rNew1' }, { tcId: 'rLATER' }]   // 第 2 步是換表之後才加的
  const r = restoreFromSnapshot(snap, after)
  assert.deepEqual(r.steps.map(s => s.tcId), ['rOld1', 'rLATER'])
})

// ─── 批次改綁 ────────────────────────────────────────────────────────────────
import { batchRetargetStatus, batchDecisions } from './uat-tc-retarget.ts'

const base = { ownerEmail: 'a@x', me: 'a@x', isAdmin: false, tableId: 'tblOLD', newTableId: 'tblNEW' }
const allMatched = planTcRetarget([b('r1', 'T-1'), b('r2', 'T-2')], [t('n1', 'T-1'), t('n2', 'T-2')])
const oneMissing = planTcRetarget([b('r1', 'T-1'), b('r2', 'T-9')], [t('n1', 'T-1'), t('n2', 'T-2')])

test('批次：每一筆都配上才 ready', () => {
  assert.equal(batchRetargetStatus({ ...base, rows: allMatched }), 'ready')
})
test('批次：有一筆沒配上 → needs-review（不批次套用）', () => {
  assert.equal(batchRetargetStatus({ ...base, rows: oneMissing }), 'needs-review')
})
test('批次：別人的腳本 → forbidden；管理員可以', () => {
  assert.equal(batchRetargetStatus({ ...base, me: 'b@x', rows: allMatched }), 'forbidden')
  assert.equal(batchRetargetStatus({ ...base, me: 'b@x', isAdmin: true, rows: allMatched }), 'ready')
  assert.equal(batchRetargetStatus({ ...base, me: 'A@X', rows: allMatched }), 'ready')
})
test('批次：預覽後被改過 → conflict', () => {
  assert.equal(batchRetargetStatus({ ...base, rows: allMatched, expectedUpdatedAt: 1, currentUpdatedAt: 2 }), 'conflict')
  assert.equal(batchRetargetStatus({ ...base, rows: allMatched, expectedUpdatedAt: 2, currentUpdatedAt: 2 }), 'ready')
})
test('批次：已經是目標表 → same-table；沒綁 → no-bindings', () => {
  assert.equal(batchRetargetStatus({ ...base, newTableId: 'tblOLD', rows: allMatched }), 'same-table')
  assert.equal(batchRetargetStatus({ ...base, rows: [] }), 'no-bindings')
})
test('批次：decisions 就是建議配對', () => {
  assert.deepEqual(batchDecisions(allMatched), { r1: 'n1', r2: 'n2' })
})

// ─── 編號重複時用「編號＋內容」消歧（v5.82.0，CodeX 1112）──────────────────────
const bt = (recordId: string, number: string, text: string) => ({ recordId, tableId: 'tblOLD', number, text, sub: '' })
const nt = (recordId: string, number: string, text: string) => ({ recordId, number, text, sub: '' })

test('雙邊編號重複但內容唯一 → 以編號＋內容配對', () => {
  const plan = planTcRetarget(
    [bt('o1', 'T-004', '積分頁面 說明'), bt('o2', 'T-004', '積分頁面 明細')],
    [nt('n1', 'T-004', '積分頁面 明細'), nt('n2', 'T-004', '積分頁面 說明'), nt('n3', 'T-004', '其他')])
  assert.equal(plan[0].suggestion?.recordId, 'n2')
  assert.equal(plan[1].suggestion?.recordId, 'n1')
  assert.ok(plan.every(r => r.reason === 'matched' && r.note.includes('編號＋內容')))
})
test('同編號同內容在新表重複 → 不猜', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', 'A')], [nt('n1', 'T-4', 'A'), nt('n2', 'T-4', 'A')])
  assert.equal(plan[0].suggestion, null)
  assert.equal(plan[0].reason, 'number-duplicate')
})
test('同編號同內容在舊腳本重複 → 不猜', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', 'A'), bt('o2', 'T-4', 'A')], [nt('n1', 'T-4', 'A'), nt('n2', 'T-4', 'B')])
  assert.ok(plan.every(r => r.suggestion === null))
})
test('編號重複且內容空白 → 不配', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', ''), bt('o2', 'T-4', 'B')], [nt('n1', 'T-4', ''), nt('n2', 'T-4', 'B')])
  assert.equal(plan[0].suggestion, null)
  assert.equal(plan[1].suggestion?.recordId, 'n2')
})
test('內容只收斂空白：多空白、全形空白、前後空白仍配得上', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', ' 積分  頁面　說明 '), bt('o2', 'T-4', 'X')], [nt('n1', 'T-4', '積分 頁面 說明'), nt('n2', 'T-4', 'Y')])
  assert.equal(plan[0].suggestion?.recordId, 'n1')
})
test('編號重複時內容改了一個字 → 不配（落到人工）', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', '說明五條正確'), bt('o2', 'T-4', 'B')], [nt('n1', 'T-4', '說明六條正確'), nt('n2', 'T-4', 'B')])
  assert.equal(plan[0].suggestion, null)
})
test('編號重複時大小寫不同的內容不算一樣', () => {
  const plan = planTcRetarget([bt('o1', 'T-4', 'Go Bet'), bt('o2', 'T-4', 'B')], [nt('n1', 'T-4', 'GO BET'), nt('n2', 'T-4', 'B')])
  assert.equal(plan[0].suggestion, null)
})
test('編號唯一時不比內容（沿用原規則）', () => {
  const plan = planTcRetarget([bt('o1', 'T-9', '舊內容')], [nt('n1', 'T-9', '新內容')])
  assert.equal(plan[0].suggestion?.recordId, 'n1')
})

import { batchPlanKey } from './uat-tc-retarget.ts'
test('批次：舊腳本沒記擁有者 → 只有管理員能批次', () => {
  assert.equal(batchRetargetStatus({ ...base, ownerEmail: '', rows: allMatched }), 'no-owner')
  assert.equal(batchRetargetStatus({ ...base, ownerEmail: '', isAdmin: true, rows: allMatched }), 'ready')
})
test('批次：預覽後新表變了（recordId 換掉）→ plan-changed', () => {
  const key = batchPlanKey('tblNEW', allMatched)
  const changed = planTcRetarget([b('r1', 'T-1'), b('r2', 'T-2')], [t('n1', 'T-1'), t('nX', 'T-2')])
  assert.equal(batchRetargetStatus({ ...base, rows: allMatched, expectedPlanKey: key }), 'ready')
  assert.equal(batchRetargetStatus({ ...base, rows: changed, expectedPlanKey: key }), 'plan-changed')
})
