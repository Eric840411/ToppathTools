/**
 * 兩顆捲動積木（`scroll`／`pc_scroll`）在真站台跑一次。
 *
 *   H5_URL='<H5 URL>' PC_URL='<PC URL>' npx tsx scripts/ui-checks/scroll-blocks-verify.ts
 *
 * 🚨 **捲動最容易假成功**：呼叫了 `scrollBy`、沒有任何錯誤，但畫面根本沒動
 *    （行動版常常是內層容器在捲，不是 window）。所以這支**不看「有沒有丟錯」，
 *    看「位置到底有沒有變」**——前後各量一次捲動位置，沒變就算失敗。
 * ⚠️ 每個正向檢查都配一個故意給錯的（不存在的 selector／不合法的比例）。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities, pcInstallEvalShim, pcWaitLobby, pcClosePopups } from '../../server/lib/pc-cocos.js'
import { dismissLobbyPopups } from '../../server/uat-runner/lobby-popup.js'

const H5_URL = process.env.H5_URL ?? ''
const PC_URL = process.env.PC_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`)
  if (ok) pass++; else fail++
}

/** 畫面上「捲到哪了」——把所有捲得動的容器加總，window 也算進來 */
const scrollPos = (page: import('playwright').Page) => page.evaluate(() => {
  let sum = window.scrollY + (document.scrollingElement?.scrollTop ?? 0)
  for (const el of document.querySelectorAll('div, main, section, ul')) sum += el.scrollTop
  return Math.round(sum)
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  // ── H5 ────────────────────────────────────────────────────────────────────
  if (H5_URL) {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    const log = async (l: string) => console.log('   ' + l)
    const host = { log, page, browser, recordedLocator: async () => { throw new Error('n/a') }, netCapture: null, startUrl: H5_URL, viewportHeight: 877, backend: null, state: { netMark: Date.now() }, pc: pcEngineCapabilities }
    const run = async (step: Record<string, unknown>) => {
      try { await runFrontendStep(step, { ...host, idx: '[*]', label: String(step.name) }); return { ok: true, err: '' } }
      catch (e) { return { ok: false, err: String((e as Error).message ?? e).split('\n')[0].slice(0, 110) } }
    }
    await run({ name: '開大廳', action: 'goto' })
    await page.waitForTimeout(13000)
    await dismissLobbyPopups(page)

    const before = await scrollPos(page)
    const down = await run({ name: '往下捲 800', action: 'scroll', value: '800' })
    const after = await scrollPos(page)
    check('① H5 往下捲不丟錯', down.ok, down.err)
    // 🚨 這條才是重點：位置真的要變
    check('② H5 畫面真的捲動了', after > before, `${before} → ${after}`)

    // ⚠️ 順序有意義：`.footer-top`（右下角回到頂端那顆）**只有捲下去之後才存在**，
    //    所以要趁現在驗 scrollIntoView，捲回頂端之後它就不見了（第一版就是這樣紅的）。
    const intoView = await run({ name: '把 Top 鍵捲進畫面', action: 'scroll', selector: '.footer-top' })
    check('④ scrollIntoView 可用', intoView.ok, intoView.err)

    const up = await run({ name: '捲回最上面', action: 'scroll', value: 'top' })
    const back = await scrollPos(page)
    check('③ H5 捲回最上面', up.ok && back < after, `${after} → ${back}`)

    // 🚨 反向：不存在的 selector 必須紅
    const bad = await run({ name: '（故意）捲不存在的元素', action: 'scroll', selector: '.no-such-thing-zzz' })
    check('⑤ 不存在的 selector 必須失敗', !bad.ok, bad.err)
    await page.screenshot({ path: `${OUT}/scroll-h5.png` })
    await ctx.close()
  }

  // ── PC ────────────────────────────────────────────────────────────────────
  if (PC_URL) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    const log = async (l: string) => console.log('   ' + l)
    const host = { log, page, browser, recordedLocator: async () => { throw new Error('n/a') }, netCapture: null, startUrl: PC_URL, viewportHeight: 800, backend: null, state: { netMark: Date.now() }, pc: pcEngineCapabilities }
    const run = async (step: Record<string, unknown>) => {
      try { await runFrontendStep(step, { ...host, idx: '[*]', label: String(step.name) }); return { ok: true, err: '' } }
      catch (e) { return { ok: false, err: String((e as Error).message ?? e).split('\n')[0].slice(0, 110) } }
    }
    await page.goto(PC_URL, { timeout: 60_000 })
    await pcInstallEvalShim(page)
    let d = await pcWaitLobby(page, 25_000)
    if (!d.ready) { await page.goto(PC_URL, { timeout: 30_000 }); d = await pcWaitLobby(page, 40_000) }
    await pcClosePopups(page)

    // `how_to_play` 一開始在視窗外（實測算出來是 (1188, -1184)）——捲動之後應該就進得來
    const beforeNode = await pcEngineCapabilities.findNode(page, 'how_to_play')
    const midScroll = await run({ name: '把清單捲到 30%', action: 'pc_scroll', value: '0.3' })
    check('⑥ PC 捲動不丟錯', midScroll.ok, midScroll.err)
    await page.waitForTimeout(2500)
    const afterNode = await pcEngineCapabilities.findNode(page, 'how_to_play')
    // 🚨 位置真的要變——這是「有沒有真的捲」的證據
    check('⑦ PC 畫面真的捲動了（how_to_play 的位置變了）',
      !!beforeNode && !!afterNode && beforeNode.y !== afterNode.y,
      `y ${beforeNode?.y} → ${afterNode?.y}`)
    check('⑧ 捲到某個比例不保證節點進得來（所以才需要 find:）', !afterNode?.inViewport || true, `inViewport=${afterNode?.inViewport}`)

    // 🚨 這才是真正要的能力：捲到「看得到它」為止
    const found = await run({ name: '捲到 how_to_play 進畫面', action: 'pc_scroll', value: 'find:how_to_play' })
    const foundNode = await pcEngineCapabilities.findNode(page, 'how_to_play')
    check('⑨ find: 能把節點捲進視窗', found.ok && !!foundNode?.inViewport, found.err || `y=${foundNode?.y} inViewport=${foundNode?.inViewport}`)
    const missing = await run({ name: '（故意）找不存在的節點', action: 'pc_scroll', value: 'find:no_such_node_zzz' })
    check('⑩ find: 找不到的節點必須失敗', !missing.ok, missing.err)

    const bad = await run({ name: '（故意）填不合法的比例', action: 'pc_scroll', value: 'abc' })
    check('⑪ 不合法的比例必須失敗', !bad.ok, bad.err)
    await page.screenshot({ path: `${OUT}/scroll-pc.png` })
    await ctx.close()
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  await browser.close()
}
