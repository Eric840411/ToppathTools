// 進到機台之後要怎麼回大廳？
// 背景：一個 task 拍完照沒有離開機台，下一個 task 重新載入 URL 就**直接回到那台機台**
// （scene='game'），大廳清單根本不會建出來。找出回大廳的按鈕。
import { chromium } from 'playwright'
import { pcWaitLobby, pcSceneName, pcClosePopups } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const [w, h] = (process.env.SIZE ?? '1024x768').split('x').map(Number)
const OUT = process.env.OUT ?? '.'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }

  // è¦æ¾ãåå¤§å»³çæéãå°±å¿é åççå¨æ©å°è£¡ââå¤§å»³ç«é¢æå°çé£äºé½ä¸æ¯
  if (await pcSceneName(page) === 'lobby') {
    const target = await page.evaluate(() => {
      const cc = window.cc
      const all = []
      const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const labelOf = (n) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
      const RE = /^[A-Za-z0-9'’&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const vis = cc.view.getVisibleSize()
      const BUSY = ['occupied', 'gm_reserved', 'offline', 'gm_handpay']
      for (const card of all.filter(n => String(n.name) === 'machine_item' && n.activeInHierarchy)) {
        if (!card.worldPosition) continue
        const x = rect.left + (card.worldPosition.x / vis.width) * rect.width
        const y = rect.top + rect.height - (card.worldPosition.y / vis.height) * rect.height
        if (!(x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight)) continue
        let name = '', busy = false
        const dig = (n, d) => {
          if (!n || d > 6) return
          for (const c of (n.children ?? [])) {
            if (!name && RE.test(labelOf(c))) name = labelOf(c)
            if (BUSY.includes(String(c.name)) && c.active) busy = true
            dig(c, d + 1)
          }
        }
        dig(card, 0)
        if (name && !busy) return { name, x: Math.round(x), y: Math.round(y) }
      }
      return null
    })
    console.log(JSON.stringify({ enteringTarget: target }))
    if (target) { await page.mouse.click(target.x, target.y); await page.waitForTimeout(8000) }
  }
  const scene = await pcSceneName(page)
  console.log(JSON.stringify({ scene }))
  if (scene === 'lobby') { console.log('still in lobby - cannot hunt for back button'); process.exit(0) }
  await pcClosePopups(page)

  const candidates = await page.evaluate(() => {
    const cc = window.cc
    const all = []
    const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const rect = document.querySelector('canvas').getBoundingClientRect()
    const vis = cc.view.getVisibleSize()
    return all
      .filter(n => n.activeInHierarchy && /back|return|exit|leave|lobby|hall|close|quit/i.test(String(n.name)))
      .map(n => ({
        name: String(n.name),
        parent: String(n.parent?.name ?? ''),
        x: n.worldPosition ? Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width) : null,
        y: n.worldPosition ? Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height) : null,
      }))
      .filter(c => c.x !== null && c.x >= 0 && c.x <= window.innerWidth && c.y >= 0 && c.y <= window.innerHeight)
      .slice(0, 15)
  })
  console.log(JSON.stringify({ candidates }, null, 1))
  await page.screenshot({ path: `${OUT}/pc-ingame-before-back.png` })

  for (const c of candidates) {
    if (await pcSceneName(page) === 'lobby') break
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(5000)
    const s = await pcSceneName(page)
    console.log(JSON.stringify({ clicked: c.name, at: [c.x, c.y], scene: s }))
    if (s === 'lobby') { await page.screenshot({ path: `${OUT}/pc-back-to-lobby.png` }); break }
    // 點了沒反應？可能是跳了確認框。把點完之後新出現的可見節點倒出來看
    const popped = await page.evaluate(() => {
      const cc = window.cc
      const all = []
      const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const labelOf = (n) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const vis = cc.view.getVisibleSize()
      return all.filter(n => n.activeInHierarchy && /pop|dialog|confirm|tip|alert|sure|msg|exit|quit|leave/i.test(String(n.name)))
        .map(n => ({ name: String(n.name), parent: String(n.parent?.name ?? ''), label: labelOf(n).slice(0, 40),
          x: n.worldPosition ? Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width) : null,
          y: n.worldPosition ? Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height) : null }))
        .slice(0, 20)
    })
    console.log(JSON.stringify({ afterClick: c.name, popped }))
    await page.screenshot({ path: `${OUT}/pc-after-${c.name}.png` })
  }
} finally { await browser.close() }
