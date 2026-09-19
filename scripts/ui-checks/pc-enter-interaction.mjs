// 找出「PC 大廳要怎麼點才會真的進機台」。
// 背景：座標修好之後點在卡片正中央仍然進不去，所以問題不在座標，在互動方式。
// 依序試：卡片中心 → 卡片裡的 btn_play → 雙擊 → 點完看有沒有跳出確認框。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby, pcSceneName } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const [w, h] = (process.env.SIZE ?? '1024x768').split('x').map(Number)
const OUT = process.env.OUT ?? '.'

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90_000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(500) }
  await page.waitForTimeout(3000)

  // ⚠️ 不能只挑「沒被佔用」——`pcScanLobby` 連捲過之後留在記憶體裡、目前在畫面外的卡片
  //    也一起回傳（y=-13199 這種）。點畫面外的座標等於沒點，會把實驗結論帶歪。
  //    這裡直接在場景裡挑「**現在就在視窗裡**而且空著」的那一張。
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
      if (name && !busy) return name
    }
    return ''
  })
  console.log(JSON.stringify({ scannedNames: (await pcScanLobby(page)).length, target }))
  if (!target) { console.log('no free machine on screen'); process.exit(0) }

  const geom = await page.evaluate((name) => {
    const cc = window.cc
    const all = []
    const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const labelOf = (n) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
    let card = null
    for (const n of all) {
      if (n.activeInHierarchy === false) continue
      if (labelOf(n) !== name) continue
      let p = n
      for (let i = 0; i < 6 && p; i++) { if (String(p.name) === 'machine_item') break; p = p.parent }
      if (p && String(p.name) === 'machine_item') { card = p; break }
    }
    if (!card) return null
    const rect = document.querySelector('canvas').getBoundingClientRect()
    const vis = cc.view.getVisibleSize()
    const toScreen = (n) => n?.worldPosition ? {
      x: Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width),
      y: Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height),
    } : null
    const ui = card.getComponent ? card.getComponent('cc.UITransform') : null
    const found = {}
    const hunt = (n, d) => {
      if (!n || d > 6) return
      for (const c of (n.children ?? [])) {
        const nm = String(c.name)
        if (['btn_play', 'bg', 'preview_img', 'main-sp', 'main-sp1'].includes(nm) && !found[nm] && c.active) {
          found[nm] = { screen: toScreen(c), active: !!c.active }
        }
        hunt(c, d + 1)
      }
    }
    hunt(card, 0)
    return {
      card: toScreen(card),
      cardSize: ui ? { w: Math.round(ui.width), h: Math.round(ui.height) } : null,
      cardScale: card.scale ? { x: card.scale.x, y: card.scale.y } : null,
      canvasScale: { x: rect.width / vis.width, y: rect.height / vis.height },
      children: found,
    }
  }, target)
  console.log(JSON.stringify({ geom }))
  if (!geom?.card) process.exit(0)

  const attempts = []
  const tryClick = async (label, x, y, dbl = false) => {
    if (await pcSceneName(page) !== 'lobby') return
    if (dbl) await page.mouse.dblclick(x, y); else await page.mouse.click(x, y)
    await page.waitForTimeout(4000)
    const scene = await pcSceneName(page)
    const popup = await page.evaluate(() => {
      const cc = window.cc
      const all = []
      const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      return all.filter(n => n.activeInHierarchy && /pop|dialog|confirm|tips|join/i.test(String(n.name))).map(n => String(n.name)).slice(0, 10)
    })
    attempts.push({ label, x, y, dbl, scene, popup })
    console.log(JSON.stringify({ label, x, y, dbl, scene, popup }))
    await page.screenshot({ path: `${OUT}/pc-enter-${label}.png` })
  }

  await tryClick('card-center', geom.card.x, geom.card.y)
  if (geom.children.btn_play?.screen) await tryClick('btn_play', geom.children.btn_play.screen.x, geom.children.btn_play.screen.y)
  await tryClick('card-center-dbl', geom.card.x, geom.card.y, true)
} finally {
  await browser.close()
}
