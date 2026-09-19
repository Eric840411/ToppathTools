// 「這個視窗一次只看得到 0 張卡片」到底是什麼造成的？
// 上一輪 800x360 過、667x375 與 844x390 掛；再上一輪剛好相反——**同一個尺寸時好時壞**，
// 所以不是解析度的幾何問題。這支逐格印出「捲動有沒有成功」與「視窗內看得到幾張卡」，
// 把「ScrollView 根本沒捲」和「捲了但卡片不在視窗內」分開。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const STEPS = Number(process.env.STEPS ?? 10)

for (const size of (process.env.SIZES ?? '844x390').split(',')) {
  const [w, h] = size.split('x').map(Number)
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    const diag = await pcWaitLobby(page, 90_000)
    for (let i = 0; i < 2; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }

    const geo = await page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { viewport: { w: innerWidth, h: innerHeight }, canvas: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
    })
    console.log(JSON.stringify({ size, ready: diag.ready, hasGrid: diag.hasGrid, machineItems: diag.machineItems, labelled: diag.labelled, ...geo }))
    // 大廳清單沒建出來的時候，畫面上到底顯示什麼？光看節點數猜不出來，要看圖。
    await page.screenshot({ path: `${process.env.OUT ?? '.'}/pc-nogrid-${size}.png` })
    const topLevel = await page.evaluate(() => {
      const cc = window.cc
      const out = []
      const walk = (n, d) => { if (!n || d > 4) return; out.push('  '.repeat(d) + String(n.name) + (n.activeInHierarchy ? '' : ' (inactive)')); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      return out.slice(0, 60).join('\n')
    })
    console.log(topLevel)

    for (let i = 0; i <= STEPS; i++) {
      const moved = await page.evaluate((frac) => {
        const cc = window.cc
        const all = []
        const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
        walk(cc.director.getScene(), 0)
        const svOf = (node) => {
          for (const c of (node.components ?? [])) if (typeof c.scrollToOffset === 'function' && typeof c.getMaxScrollOffset === 'function') return c
          return null
        }
        const named = all.find(n => String(n.name ?? '') === 'ScrollView-gms')
        const sv = named ? svOf(named) : null
        if (!sv) return 'no-sv'
        const max = sv.getMaxScrollOffset()
        sv.scrollToOffset({ x: 0, y: max.y * frac }, 0.25)
        return 'ok:maxY=' + Math.round(max.y)
      }, i / STEPS).catch(e => 'err:' + String(e).slice(0, 60))
      await page.waitForTimeout(900)
      const all = await pcScanLobby(page)
      const vis = await pcScanLobby(page, { onScreenOnly: true })
      console.log(JSON.stringify({ size, step: i, moved: String(moved).slice(0, 30), labelled: all.length, onScreen: vis.length, fiveDragons: all.filter(m => m.name.startsWith('5 Dragons')).length }))
    }
  } catch (e) {
    console.log(JSON.stringify({ size, fatal: String(e).slice(0, 200) }))
  } finally { await browser.close() }
}
