// 試「用大廳的搜尋框篩選機台」這條路。
// 為什麼要試：短的橫版視窗（800x360）整個視窗裡只看得到 2 張卡片，
// 用捲動掃 695 台去找某一款機台等於大海撈針（要 300+ 格）。
// 搜尋框如果能把清單篩到剩幾台，短視窗也能穩定挑到目標。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const [w, h] = (process.env.SIZE ?? '800x360').split('x').map(Number)
const KEYWORD = process.env.KEYWORD ?? 'Dancing Drums'
const OUT = process.env.OUT ?? '.'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90_000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(500) }
  await page.waitForTimeout(2000)

  const box = await page.evaluate(() => {
    const cc = window.cc
    const all = []
    const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const rect = document.querySelector('canvas').getBoundingClientRect()
    const vis = cc.view.getVisibleSize()
    const hits = []
    for (const n of all) {
      if (!n.activeInHierarchy || !n.worldPosition) continue
      const comps = n.components ?? []
      const isEdit = comps.some(c => typeof c.placeholder === 'string' || typeof c.placeholderLabel === 'object' && c.placeholderLabel)
      if (!isEdit) continue
      hits.push({
        name: String(n.name),
        placeholder: comps.map(c => c.placeholder).find(p => typeof p === 'string') ?? '',
        x: Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width),
        y: Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height),
      })
    }
    return { hits, viewport: { w: window.innerWidth, h: window.innerHeight } }
  })
  console.log(JSON.stringify(box))
  const edit = box.hits.find(x => x.x >= 0 && x.x <= box.viewport.w && x.y >= 0 && x.y <= box.viewport.h)
  if (!edit) { console.log('search box not reachable at this size'); process.exit(0) }

  const before = (await pcScanLobby(page)).length
  await page.mouse.click(edit.x, edit.y)
  await page.waitForTimeout(800)
  const domInput = await page.evaluate(() => {
    const el = document.querySelector('input.cocosEditBox, input')
    return el ? { visible: el.style.display !== 'none', focused: document.activeElement === el } : null
  })
  await page.keyboard.type(KEYWORD, { delay: 60 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  const after = await pcScanLobby(page)
  console.log(JSON.stringify({ domInput, before, afterCount: after.length, afterFree: after.filter(m => !m.occupied).length, sample: after.slice(0, 6).map(m => m.name + (m.occupied ? '(busy)' : '(free)')) }))
  await page.screenshot({ path: `${OUT}/pc-search-${w}x${h}.png` })
} finally {
  await browser.close()
}
