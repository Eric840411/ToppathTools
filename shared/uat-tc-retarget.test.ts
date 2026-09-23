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
