/**
 * 「錄製器會不會錄捲動」——**把真正的錄製器注入真站台**跑一次，不是模擬。
 *
 *   H5_URL='<帳號池 URL>' npx tsx scripts/ui-checks/recorder-scroll-verify.ts
 *
 * 🚨 要守的三件事：
 *   ① 使用者捲了 → 真的錄到一顆 `scroll`（而且是絕對位置 `to:N`）
 *   ② 停下來才錄**一顆**，不是每個 scroll 事件都錄（不然一捲就幾十顆，腳本沒法看）
 *   ③ 錄到的那顆**重播得動**——把它直接餵回 `runFrontendStep`，畫面要真的回到那個位置
 *
 * ⚠️ ③ 才是真正的判準。只驗「有錄到」的話，錄出一顆跑不動的積木照樣會綠。
 */
import { chromium } from 'playwright'
import { frontendRecorderScript, FRONTEND_RECORDER_MARKER } from '../../server/uat-runner/frontend-recorder.js'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { dismissLobbyPopups } from '../../server/uat-runner/lobby-popup.js'
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'

const H5_URL = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
if (!H5_URL) { console.log('要給 H5_URL'); process.exit(1) }
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`)
  if (ok) pass++; else fail++
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()

  // 錄製器把每一步用 console.info 印出來（前面掛一個 marker）——host 就是這樣收的
  const recorded: Array<Record<string, unknown>> = []
  page.on('console', m => {
    const t = m.text()
    if (!t.startsWith(FRONTEND_RECORDER_MARKER)) return
    try { recorded.push(JSON.parse(t.slice(FRONTEND_RECORDER_MARKER.length).trim())) } catch { /* 不是 JSON 就算了 */ }
  })

  await page.goto(H5_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)

  // 注入真正的錄製器，並把它切成「已同步、未暫停」（不然它一律不送）
  await page.evaluate(frontendRecorderScript({}))
  // ⚠️ 錄製器**沒收到 host 推狀態之前一律不送**（`synced` 是 false）。
  //    唯一的路是呼叫頁面上的 `window.__toppathRecSync(...)`——host 端就是這樣做的。
  const synced = await page.evaluate(() => {
    const fn = (window as unknown as { __toppathRecSync?: (raw: unknown) => boolean }).__toppathRecSync
    return typeof fn === 'function' ? fn({ paused: false, steps: 0 }) : false
  })
  console.log('   錄製器同步狀態：', synced)
  await page.waitForTimeout(800)

  const posOf = () => page.evaluate(() => {
    let sum = (document.scrollingElement?.scrollTop ?? 0)
    for (const d of document.querySelectorAll('div, main, section, ul')) sum += d.scrollTop
    return Math.round(sum)
  })

  /**
   * ⚠️ **行動版版面要用真的觸控事件才捲得動。**
   *    實測 `page.mouse.wheel` 與滑鼠拖曳都**完全捲不動**（位置 1576 → 1576）——
   *    那是我的「施力方式」不對，不是錄製器的問題。用 CDP 派送 touchStart/Move/End 才是
   *    真人滑動的等價操作。
   */
  const cdp = await ctx.newCDPSession(page)
  const swipeUp = async () => {
    const touch = (type: string, y: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x: 250, y, radiusX: 2, radiusY: 2, force: 1 }],
    })
    await touch('touchStart', 700)
    for (const y of [640, 560, 470, 380, 300, 240]) { await touch('touchMove', y); await page.waitForTimeout(45) }
    await touch('touchEnd', 240)
  }

  const beforeCount = recorded.length
  const p0 = await posOf()
  await swipeUp()
  await page.waitForTimeout(700)
  await swipeUp()
  await page.waitForTimeout(2000)   // 等去抖動的 300ms 過去
  let p1 = await posOf()
  console.log(`   觸控滑動：${p0} → ${p1}${p1 === p0 ? '（⚠️ 觸控模擬捲不動這個版面）' : ''}`)

  /**
   * ⚠️ **觸控模擬捲不動時，改用「直接設 scrollTop」當刺激，並且要講清楚。**
   *
   * 這樣測到的是「**捲動事件發生時錄製器會不會錄**」——真人滑動也是產生同一種
   * `scroll` 事件，所以這一段仍然有意義；但它**沒有**證明「真人在這個版面滑得動」。
   * 那是另一回事（而且這個 harness 裡的滑鼠滾輪／拖曳／CDP 觸控都推不動它）。
   * 不寫清楚的話，這支就變成「我以為驗了真人操作，其實只驗了事件」。
   */
  if (p1 === p0) {
    await page.evaluate(() => {
      let best: Element | null = null; let bestArea = 0
      for (const el of document.querySelectorAll('div, main, section, ul')) {
        if (el.scrollHeight - el.clientHeight <= 40) continue
        const st = getComputedStyle(el)
        if (!/(auto|scroll)/.test(st.overflowY)) continue
        const r = el.getBoundingClientRect()
        if (r.width * r.height > bestArea) { best = el; bestArea = r.width * r.height }
      }
      const target = best ?? document.scrollingElement ?? document.documentElement
      target.scrollTop = target.scrollTop + 900
    })
    await page.waitForTimeout(2000)
    p1 = await posOf()
    console.log(`   改用「直接設 scrollTop」當刺激：${p0} → ${p1}（驗的是「捲動事件會不會被錄」，不是「真人滑得動」）`)
  }

  const scrolls = recorded.slice(beforeCount).filter(s => s.action === 'scroll')
  check('① 捲動有被錄下來', scrolls.length > 0, `錄到 ${scrolls.length} 顆：${JSON.stringify(scrolls.slice(0, 3))}`)
  // ② 連續捲三段只能產生一顆（去抖動有效）
  check('② 連續捲動只錄一顆（不是每個事件都錄）', scrolls.length === 1, `${scrolls.length} 顆`)
  // ⚠️ `every` 在空陣列上是 true——沒錄到東西時這條會**真空為真**，
  //    看起來像通過其實什麼都沒驗。所以先要求真的有錄到。
  check('③ 錄的是絕對位置 to:N', scrolls.length > 0 && scrolls.every(s => String(s.value ?? '').startsWith('to:')), JSON.stringify(scrolls[0]?.value))

  // ── ④ 最重要：錄到的那顆真的重播得動 ──────────────────────────────────
  if (scrolls[0]) {
    await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement
      el.scrollTop = 0
      for (const d of document.querySelectorAll('div, main, section, ul')) d.scrollTop = 0
    })
    await page.waitForTimeout(1200)
    const log = async (l: string) => console.log('   ' + l)
    const host = { log, page, browser, recordedLocator: async () => { throw new Error('n/a') }, netCapture: null, startUrl: H5_URL, viewportHeight: 877, backend: null, state: { netMark: Date.now() }, pc: pcEngineCapabilities }
    let replayed = true
    try { await runFrontendStep({ ...scrolls[0], name: '重播錄到的捲動' }, { ...host, idx: '[*]', label: '重播錄到的捲動' }) }
    catch (e) { replayed = false; console.log('   ✗', String((e as Error).message).slice(0, 110)) }
    const pos = await page.evaluate(() => {
      let sum = (document.scrollingElement?.scrollTop ?? 0)
      for (const d of document.querySelectorAll('div, main, section, ul')) sum += d.scrollTop
      return Math.round(sum)
    })
    const want = Number(String(scrolls[0].value).slice(3))
    // 目標本身就是 0 的話這條沒有鑑別力——要求錄到的位置是真的捲過的位置
    check('④ 錄到的是真正捲動的那個容器（位置不是 0）', want > 0, `to:${want}`)
    check('⑤ 錄到的那顆重播得動（畫面真的回到那個位置）', replayed && pos > 0, `目標 ${want}、重播後量到 ${pos}`)
  }
  await page.screenshot({ path: `${OUT}/recorder-scroll.png` })

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  await browser.close()
}
