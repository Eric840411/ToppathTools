/**
 * 直接用 UAT 的 H5 積木引擎（`server/uat-runner/frontend-engine.js`）跑一段真流程。
 *
 * **為什麼不走 `/api/frontend-auto/runs/:id/execute`**：那條路一定要有登入身分，
 * 而且 agent 必須屬於同一個身分（`pickUatAgent` 明確拒絕沒登入的派工）。
 * 我沒有可用的登入身分，也不打算借別人的帳號。
 * 但「積木在真實 H5 上跑不跑得動」跟派工是兩件事——這支把前者驗完，
 * 派工那層等拿到身分再補。
 *
 * ⚠️ 這裡跑的是**同一支引擎**，不是另外寫一份模擬：behaviour 只有一份，
 *    否則就變成「測試自己寫了一套對的邏輯，然後測它自己」。
 */
import { chromium } from 'playwright'
import { compileFrontendSteps, runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { createRecordedLocators } from '../../server/uat-runner/recorded-selector.js'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

// 選擇器是 2026-09-19 從線上大廳現場盤出來的
const rawSteps = [
  { action: 'wait', value: '10000', name: '等大廳載入' },
  { action: 'assert_visible', selector: '.grid-item-name', minCount: 5, name: '大廳有機台卡片' },
  { action: 'assert_visible', selector: '.section-title', minCount: 1, name: '分區標題存在' },
  { action: 'assert_visible', selector: '.jackpot-number', minCount: 1, name: '獎池數字有顯示' },
  { action: 'screenshot', name: '大廳畫面' },
  { action: 'assert_visible', selector: '.this-selector-should-not-exist', minCount: 1, name: '（故意失敗）不存在的選擇器' },
  // ⚠️ click 用 `.grid-item`（命中 30 個）會被擋下來，而且**那是對的**：
  //    不知道該點哪一個就不該亂點。錄製器產出來的是指向單一元素的寫法，
  //    所以這裡改成用機台名稱定位（執行時帶入）。
  { action: 'click', selector: '__MACHINE__', name: '點第一台機台' },
  { action: 'wait', value: '12000', name: '等機台載入' },
  { action: 'screenshot', name: '機台畫面' },
]

const main = async () => {
  const { steps, dropped } = compileFrontendSteps(rawSteps)
  console.log(JSON.stringify({ compiled: steps.length, dropped }))

  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const results = []
  let stopWatcher = null
  try {
    const ctx0 = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
    const page = await ctx0.newPage()
    const netLog = []
    page.on('request', r => netLog.push({ url: r.url(), at: Date.now() }))
    await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(10000)
    // ⚠️ 大廳一進去可能蓋一張整頁的 JACKPOT 中獎彈窗，蓋著的話**每個 click 都會 timeout**。
    //    這裡呼叫的是 agent 上線跑的同一支 `dismissLobbyPopups`，不是另外抄一份。
    const popupResult = await dismissLobbyPopups(page)
    console.log(JSON.stringify(popupResult))
    // ⚠️ 關一次不夠：別人中獎就會再播一張，整段測試期間都要盯著關。
    stopWatcher = startLobbyPopupWatcher(page, { onClose: cls => console.log(JSON.stringify({ watcherClosed: cls })) })
    // 拿一台真實存在的機台名稱，把 click 的選擇器換成指向單一元素的寫法
    const firstName = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    // ⚠️ 點「名稱」那個元素會 timeout（實測）——可點的是外層卡片，
    //    所以用 :has() 從名稱找回它所屬的 .grid-item。
    const machineSelector = firstName ? `.grid-item:has(.grid-item-name:text-is("${firstName.trim()}"))` : '.grid-item'
    console.log(JSON.stringify({ pickedMachine: firstName.trim(), machineSelector }))
    for (const st of steps) if (st.selector === '__MACHINE__') st.selector = machineSelector

    let shotNo = 0
    const ctx = {
      page, browser, startUrl: URL_H5, viewportHeight: 877,
      state: { netMark: Date.now() },
      netCapture: { entries: () => netLog },
      takeScreenshot: async (label) => {
        const file = `${OUT}/h5-step-${++shotNo}-${String(label ?? 'shot').replace(/[^\w-]/g, '_').slice(0, 20)}.png`
        await page.screenshot({ path: file })
        return { path: file }
      },
      loadBaseline: async () => null,
      compareTemplate: async () => ({ score: 0 }),
      decodePng: null,
      // ⬇ 跟 agent 一模一樣：錄製器會產出 text=/label=/:text-is() 這些非原生 CSS 寫法，
      //    直接 page.locator() 會在 label= 那種直接拋錯。requireUnique：命中多筆一律失敗。
      recordedLocator: createRecordedLocators(page, { requireUnique: true, resolveTimeoutMs: 10000 }).recordedLocator,
      backend: null,
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const label = step.name ?? step.action
      const started = Date.now()
      let verdict = 'pass', detail = ''
      try {
        const out = await runFrontendStep(step, {
          ...ctx, idx: i + 1, label,
          log: async (m) => { detail = String(m).slice(0, 160) },
        })
        if (out && out.ok === false) { verdict = 'fail'; detail = String(out.message ?? detail).slice(0, 160) }
      } catch (err) {
        verdict = 'fail'
        detail = String(err?.message ?? err).split('\n')[0].slice(0, 160)
      }
      results.push({ n: i + 1, action: step.action, label, verdict, ms: Date.now() - started, detail })
      console.log(JSON.stringify(results[results.length - 1]))
    }
  } finally {
    try { const all = stopWatcher?.(); if (all?.length) console.log(JSON.stringify({ watcherTotal: all.length, watcherClosed: all })) } catch { /* ignore */ }
    await browser.close()
    const pass = results.filter(r => r.verdict === 'pass').length
    console.log(JSON.stringify({ summary: { total: results.length, pass, fail: results.length - pass } }))
  }
}
main().catch(e => console.log('FATAL', String(e).slice(0, 400)))
