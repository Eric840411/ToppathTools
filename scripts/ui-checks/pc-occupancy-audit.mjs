// 稽核 PC 大廳「空機 / 佔用」是怎麼判的。
// 背景：修掉跑馬燈假卡片之後空機數從 5 → 2 → 0，使用者質疑判斷本身有問題。
// 這支把每張卡片底下的子節點名稱與 active 狀態全部倒出來，再配一張同一時間的截圖，
// 就能用肉眼對照「畫面上看起來是空的那幾台，程式到底看到什麼」。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const [w, h] = (process.env.SIZE ?? '1024x768').split('x').map(Number)
const OUT = process.env.OUT ?? '.'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90_000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(500) }
  await page.waitForTimeout(2000)

  const cards = await page.evaluate(() => {
    const cc = window.cc
    const all = []
    const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const labelOf = (n) => {
      for (const comp of (n.components ?? [])) {
        if (typeof comp.string === 'string' && comp.string.trim()) return comp.string.trim()
      }
      return ''
    }
    const NAME_RE = /^[A-Za-z0-9'’&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
    const items = all.filter(n => String(n.name ?? '') === 'machine_item')
    const canvas = document.querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    const vis = cc.view.getVisibleSize()
    return items.map(card => {
      let name = ''
      const findName = (n, d) => {
        if (!n || d > 8 || name) return
        const s = labelOf(n)
        if (NAME_RE.test(s)) { name = s; return }
        for (const c of (n.children ?? [])) findName(c, d + 1)
      }
      findName(card, 0)
      const kids = []
      const dumpKids = (n, d) => {
        if (!n || d > 6) return
        for (const c of (n.children ?? [])) {
          kids.push({ n: String(c.name), a: !!c.active, ah: !!c.activeInHierarchy, d, label: labelOf(c) || undefined })
          dumpKids(c, d + 1)
        }
      }
      dumpKids(card, 0)
      const x = card.worldPosition ? rect.left + (card.worldPosition.x / vis.width) * rect.width : null
      const y = card.worldPosition ? rect.top + rect.height - (card.worldPosition.y / vis.height) * rect.height : null
      return {
        name,
        activeInHierarchy: !!card.activeInHierarchy,
        screen: x === null ? null : { x: Math.round(x), y: Math.round(y) },
        onScreen: x !== null && x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight,
        occupiedFlag: kids.some(k => k.n === 'gm_occupied' && k.a),
        kids: kids.filter(k => k.a).map(k => k.n),
        kidsInactive: kids.filter(k => !k.a).map(k => k.n),
      }
    }).filter(c => c.onScreen)
  })

  console.log(JSON.stringify({ visibleCards: cards.length, cards }, null, 1))
  await page.screenshot({ path: `${OUT}/pc-occupancy-${w}x${h}.png` })
} finally {
  await browser.close()
}
