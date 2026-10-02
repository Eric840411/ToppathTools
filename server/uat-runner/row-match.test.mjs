// node --test server/uat-runner/row-match.test.mjs
//
// 守住（2026-10-02，AI T-003 前後台比對）：
// ① 「表格要有一筆符合」：數值／時間格式差異不能誤判，對不上時要說差在哪，變數不存在要先失敗
// ② 「影片要真的在播」：沒暫停但時間不動（卡載入）不能算過
// ③ 後台片段只多收「讀取表格」，斷言類仍然擋掉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRowConditions, checkRowCondition, runFrontendStep } from './frontend-engine.js'
import { unsupportedBackendOps } from './backend-ops.js'

// 實際 UAT 後台 Jackpot Ranking 第 2 列（2026-10-02 讀到的）
const ROW = {
  Account: 'testaaa', 'Bet Time': '2026-06-17 15:41:17', 'Machine Name': 'Rising Rockets Emperor-140',
  'Jackpot Amount': '8,000,000,111', 'Client Announcement Time': '2026-10-01 00:00:00 To 2026-10-31 23:59:59',
}
const NOW = new Date(2026, 9, 2, 16, 0, 0)
const vars = { amount: '₱8,000,000,111', time: '2026-06-17\n15:41:17', acc: 'te*****aa' }
const lookup = name => vars[name]
const conds = text => parseRowConditions(text, lookup)

test('= 兩邊像數字就比數值：₱8,000,000,111 等於 8,000,000,111', () => {
  assert.equal(checkRowCondition(ROW, conds('Jackpot Amount = {{amount}}')[0], NOW), null)
  assert.match(checkRowCondition(ROW, conds('Jackpot Amount = 8000000112')[0], NOW), /≠/)
})

test('= 時間的換行與空白不影響（浮層的 TIME 是兩行）', () => {
  assert.equal(checkRowCondition(ROW, conds('Bet Time = {{time}}')[0], NOW), null)
  assert.match(checkRowCondition(ROW, conds('Bet Time = 2026-06-17 15:41:18')[0], NOW), /≠/)
})

test('~= 遮罩：te*****aa 對得上 testaaa，對不上 qatestoo', () => {
  assert.equal(checkRowCondition(ROW, conds('Account ~= {{acc}}')[0], NOW), null)
  assert.match(checkRowCondition({ ...ROW, Account: 'qatestoo' }, conds('Account ~= {{acc}}')[0], NOW), /遮罩/)
})

test('@now：在期間內過、過期不過、迄是空白算已到期', () => {
  const c = conds('Client Announcement Time @now')[0]
  assert.equal(checkRowCondition(ROW, c, NOW), null)
  assert.match(checkRowCondition({ ...ROW, 'Client Announcement Time': '2026-08-19 00:00:00 To 2026-08-31 23:59:59' }, c, NOW), /不在有效期間/)
  assert.match(checkRowCondition({ ...ROW, 'Client Announcement Time': '2026-08-19 00:00:00' }, c, NOW), /空白算已到期/)
})

test('欄名忽略大小寫與空白；欄位不存在要講出有哪些欄', () => {
  assert.equal(checkRowCondition(ROW, conds('jackpot  amount = {{amount}}')[0], NOW), null)
  assert.match(checkRowCondition(ROW, conds('Amount = 1')[0], NOW), /沒有「Amount」.*Jackpot Amount/)
})

test('引用不存在的變數要在比對前就失敗（不能變成「找不到符合的列」）', () => {
  assert.throws(() => conds('Bet Time = {{nope}}'), /變數「nope」不存在/)
  assert.throws(() => conds('亂寫一通'), /看不懂/)
  assert.throws(() => conds(''), /至少要填一條/)
})

const ctxWith = (state, page = {}) => ({ idx: '[1/1]', label: 't', log: () => {}, state, page })

test('assert_row_match：有一列全部符合就過；都不符合時回報最接近那列差在哪', async () => {
  const state = { netMark: 0, vars: { ...vars, jp: { rows: [{ ...ROW, 'Jackpot Amount': '1' }, ROW] } } }
  await runFrontendStep({ action: 'assert_row_match', from: 'jp.rows', value: 'Jackpot Amount = {{amount}}\nBet Time = {{time}}' }, ctxWith(state))
  const bad = { netMark: 0, vars: { ...vars, jp: { rows: [{ ...ROW, 'Bet Time': '2026-01-01 00:00:00' }] } } }
  await assert.rejects(
    () => runFrontendStep({ action: 'assert_row_match', from: 'jp.rows', value: 'Jackpot Amount = {{amount}}\nBet Time = {{time}}' }, ctxWith(bad)),
    /1 列裡沒有一列.*Bet Time「2026-01-01 00:00:00」/,
  )
})

test('assert_row_match：表格變數不存在或是空的要明確失敗', async () => {
  await assert.rejects(() => runFrontendStep({ action: 'assert_row_match', from: 'jp.rows', value: 'Bet Time = 1' }, ctxWith({ netMark: 0, vars: {} })), /不是表格/)
  await assert.rejects(() => runFrontendStep({ action: 'assert_row_match', from: 'jp.rows', value: 'Bet Time = 1' }, ctxWith({ netMark: 0, vars: { jp: { rows: [] } } })), /是空的/)
})

const videoPage = (samples) => {
  let i = 0
  return {
    waitForTimeout: async () => {},
    locator: () => ({ count: async () => 1, first: () => ({ evaluate: async () => samples[Math.min(i++, samples.length - 1)] }) }),
  }
}

test('assert_video_playing：時間有往前走才算在播', async () => {
  const page = videoPage([{ paused: true, t: 0 }, { paused: false, t: 0.3 }, { paused: false, t: 0.9 }])
  await runFrontendStep({ action: 'assert_video_playing', timeoutMs: 2000 }, ctxWith({ netMark: 0 }, page))
})

test('assert_video_playing：沒暫停但時間不動（卡載入）不能過', async () => {
  const page = videoPage([{ paused: false, t: 0, ready: 1 }])
  await assert.rejects(() => runFrontendStep({ action: 'assert_video_playing', timeoutMs: 1000 }, ctxWith({ netMark: 0 }, page)), /時間沒前進/)
})

test('後台片段：多收「讀取表格」，斷言類仍然擋掉（判定只在前台做）', () => {
  assert.deepEqual(unsupportedBackendOps([{ action: 'open_page' }, { action: 'read_table' }]), [])
  assert.deepEqual(unsupportedBackendOps([{ action: 'assert_text' }, { action: 'assert_each_row' }]), ['assert_text', 'assert_each_row'])
})

test('assert_video_playing：接近片尾循環回 0 也算在播（不能用最後一次減第一次）', async () => {
  const page = videoPage([{ paused: false, t: 11.6 }, { paused: false, t: 11.9 }, { paused: false, t: 0.3 }, { paused: false, t: 0.8 }])
  await runFrontendStep({ action: 'assert_video_playing', minAdvanceSec: 1, timeoutMs: 3000 }, ctxWith({ netMark: 0 }, page))
})

import { fillSnippetVars } from './frontend-engine.js'
test('後台片段的 {{變數}} 換成前台值；變數不存在要在跑後台前就失敗；原片段不被改到', () => {
  const steps = [{ action: 'type_text', selector: '#acc', value: '{{machine}}' }, { action: 'wait', waitMs: 500 }]
  const ctx = { state: { vars: { machine: 'Rising Rockets Emperor-140' } } }
  const out = fillSnippetVars(steps, ctx)
  assert.equal(out[0].value, 'Rising Rockets Emperor-140')
  assert.equal(steps[0].value, '{{machine}}', '原片段物件不能被改')
  assert.throws(() => fillSnippetVars(steps, { state: { vars: {} } }), /變數「machine」不存在/)
  assert.equal(fillSnippetVars([{ action: 'wait', waitMs: 1 }], { state: {} })[0].waitMs, 1, '沒有 {{}} 就原樣回傳、也不需要變數表')
})
