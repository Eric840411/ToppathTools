// node --test server/uat-runner/popup-watch.test.mjs
//
// 守住兩件事（2026-10-02，AI T-001～T-003）：
// ① 「暫停自動關彈窗」真的會停，而且**暫停當下正在跑的那一輪**不會在暫停之後才把彈窗關掉
// ② goto 的 settleMs：填 0 就不等（截載入畫面用），沒填維持舊的 3 秒
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startLobbyPopupWatcher } from './lobby-popup.js'
import { runFrontendStep } from './frontend-engine.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('暫停會等正在跑的那一輪結束，之後不再關彈窗；恢復後繼續關', async () => {
  let evaluating = 0, closes = 0
  const page = {
    evaluate: async () => { evaluating++; await sleep(80); closes++; return { closed: 'notification-close' } },
  }
  const watch = startLobbyPopupWatcher(page, { intervalMs: 20 })
  await sleep(30) // 第一輪已經進到 evaluate 裡
  assert.ok(evaluating >= 1, '看門狗應該已經開始跑')
  await watch.pause()
  const afterPause = closes
  await sleep(150)
  assert.equal(closes, afterPause, '暫停之後不能再關任何彈窗')
  assert.equal(watch.isPaused(), true)
  watch.resume()
  await sleep(150)
  assert.ok(closes > afterPause, '恢復後要繼續關')
  watch()
})

test('呼叫 stop 本身仍回傳關掉的清單（舊呼叫端不受影響）', async () => {
  const page = { evaluate: async () => ({ closed: 'closeBtn' }) }
  const watch = startLobbyPopupWatcher(page, { intervalMs: 10 })
  await sleep(40)
  const list = watch()
  assert.ok(Array.isArray(list) && list.length > 0)
})

const baseCtx = (extra = {}) => ({
  idx: '[1/1]', label: 't', log: () => {}, state: { netMark: 0 }, startUrl: 'https://uat-h5.example/lobby', ...extra,
})

test('popup_watch：host 沒給開關要明確失敗，不能當成功跳過', async () => {
  await assert.rejects(() => runFrontendStep({ action: 'popup_watch', value: 'pause' }, baseCtx({ page: {} })), /沒有自動關彈窗的開關/)
})

test('popup_watch：pause／resume 會呼叫 host 的開關；亂填的值要報錯', async () => {
  const calls = []
  const popupWatch = { pause: async () => { calls.push('pause') }, resume: () => { calls.push('resume') } }
  await runFrontendStep({ action: 'popup_watch', value: 'pause' }, baseCtx({ page: {}, popupWatch }))
  await runFrontendStep({ action: 'popup_watch', value: 'resume' }, baseCtx({ page: {}, popupWatch }))
  assert.deepEqual(calls, ['pause', 'resume'])
  await assert.rejects(() => runFrontendStep({ action: 'popup_watch', value: 'off' }, baseCtx({ page: {}, popupWatch })), /暫停.*恢復/)
})

const fakePage = () => {
  const waits = []
  return {
    waits,
    goto: async () => {},
    waitForTimeout: async ms => { waits.push(ms) },
    url: () => 'https://uat-h5.example/lobby',
  }
}

test('goto：沒填 settleMs 維持舊行為等 3000ms', async () => {
  const page = fakePage()
  await runFrontendStep({ action: 'goto' }, baseCtx({ page }))
  assert.equal(page.waits[0], 3000)
})

test('goto：settleMs=0 完全不等（截載入畫面用）', async () => {
  const page = fakePage()
  await runFrontendStep({ action: 'goto', settleMs: 0 }, baseCtx({ page }))
  assert.deepEqual(page.waits, [])
})

import { h5InGame } from './h5-seat.js'
test('h5InGame：UAT 的 uat-h5 網域也要認得（不然收尾退出機台在 UAT 永遠不生效）', () => {
  const p = u => ({ url: () => u })
  assert.equal(h5InGame(p('https://uat-h5.osmslot.org/game?gmid=1')), true)
  assert.equal(h5InGame(p('https://osm-h5.osmslot.org/game')), true)
  assert.equal(h5InGame(p('https://uat-h5.osmslot.org/lobby')), false)
  assert.equal(h5InGame(p('https://example.com/game')), false)
})

test('暫停：前一輪很慢、後一輪很快（亂序完成）時，pause 返回後也不能再關（CodeX 10-02 重現的競態）', async () => {
  let call = 0, closesAfterPause = 0, pausedAt = null
  const page = {
    evaluate: async () => {
      const mine = ++call
      await sleep(mine === 1 ? 300 : 10)
      if (pausedAt !== null) closesAfterPause++
      return { closed: 'notification-close' }
    },
  }
  const watch = startLobbyPopupWatcher(page, { intervalMs: 20 })
  await sleep(60) // 第一輪（慢）在跑，舊版這時已經疊出第二、三輪
  await watch.pause()
  pausedAt = Date.now()
  await sleep(400)
  assert.equal(closesAfterPause, 0, 'pause 返回之後不能有任何一輪再關彈窗')
  watch()
})
