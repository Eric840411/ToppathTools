// 驗證 PC 大廳「捲到卡片 → 點下去」的點擊座標到底落在哪裡。
// 為什麼要這支：2026-09-18 一輪 15 個解析度全部 err，訊息都是「點了 (x, y) 但還停在大廳」，
// 而且 x/y 每次都剛好是畫布正中心——看起來像卡片沒被點到，但從 log 分不出是
// (a) 座標算錯、(b) 卡片其實不在中心、還是 (c) 機台真的被佔用。這支把三者分開。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby, pcScrollIntoView, pcMachineScreenPos, pcSceneName, pcInGameMachineName } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const SIZES = (process.env.SIZES ?? '1024x768,360x800').split(',')
const OUT = process.env.OUT ?? '.'

for (const size of SIZES) {
  const [w, h] = size.split('x').map(Number)
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await pcWaitLobby(page, 90_000)
    for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(500) }

    const machines = await pcScanLobby(page)
    const free = machines.filter(m => !m.occupied)
    const target = (free[0] ?? machines[0])
    const name = target?.name ?? ''

    const posBefore = await pcMachineScreenPos(page, name)
    const pos = await pcScrollIntoView(page, name)
    const posAfter = await pcMachineScreenPos(page, name)

    const geo = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      const cc = window.cc
      const vis = cc?.view?.getVisibleSize?.() ?? null
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        canvasCss: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        canvasAttr: { w: c.width, h: c.height },
        visibleSize: vis ? { w: Math.round(vis.width), h: Math.round(vis.height) } : null,
      }
    })

    console.log(JSON.stringify({
      size, name,
      scanned: machines.length, free: free.length,
      posBefore, scrollResult: pos, posAfter,
      ...geo,
      xOutsideViewport: pos ? pos.x >= geo.viewport.w : null,
      yOutsideViewport: pos ? pos.y >= geo.viewport.h : null,
    }))

    if (pos) {
      await page.evaluate(([x, y]) => {
        const d = document.createElement('div')
        d.style.cssText = `position:fixed;left:${x - 12}px;top:${y - 12}px;width:24px;height:24px;border:3px solid red;border-radius:50%;z-index:2147483647;pointer-events:none`
        d.id = '__probe_marker'
        document.body.appendChild(d)
      }, [pos.x, pos.y])
      await page.screenshot({ path: `${OUT}/pc-probe-${size}-marked.png` })
      await page.evaluate(() => document.getElementById('__probe_marker')?.remove())

      await page.mouse.click(pos.x, pos.y)
      await page.waitForTimeout(6000)
      const scene = await pcSceneName(page)
      const actual = await pcInGameMachineName(page)
      console.log(JSON.stringify({ size, clicked: pos, scene, actual, entered: scene !== 'lobby' }))
      await page.screenshot({ path: `${OUT}/pc-probe-${size}-after-click.png` })
    }
  } catch (err) {
    console.log(JSON.stringify({ size, fatal: String(err).slice(0, 300) }))
  } finally {
    await browser.close()
  }
}
