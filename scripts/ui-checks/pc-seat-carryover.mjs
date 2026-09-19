// 重現「上一輪的位子還佔著 → 下一輪被自動送回機台 → 退不出來」這個狀態，
// 並把退出失敗那一刻的畫面與節點全部倒出來。
// 目的：pcBackToLobby 成功率只有一半，失敗時 box_sure 輪詢 5 秒都不出現，要知道為什麼。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcSceneName, pcInstallEvalShim, pcInGameMachineName, pcBackToLobby } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const OUT = process.env.OUT ?? '.'
const SIZE2 = process.env.SIZE2 ?? '667x375'

const launch = () => chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })

const pickFreeOnScreen = (page) => page.evaluate(() => {
  const cc = window.cc
  const all = []
  const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
  walk(cc.director.getScene(), 0)
  const labelOf = (n) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
  const RE = /^[A-Za-z0-9'\u2019&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
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

const dumpBoxes = (page) => page.evaluate(() => {
  const cc = window.cc
  const all = []
  const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
  walk(cc.director.getScene(), 0)
  const labelOf = (n) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
  const rect = document.querySelector('canvas').getBoundingClientRect()
  const vis = cc.view.getVisibleSize()
  const pos = (n) => n?.worldPosition ? [Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width), Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height)] : null
  return all.filter(n => /box|confirm|sure|dialog|pop|alert|msg|tip/i.test(String(n.name)))
    .map(n => ({ n: String(n.name), p: String(n.parent?.name ?? ''), act: !!n.activeInHierarchy, label: labelOf(n).slice(0, 30) || undefined, at: pos(n) }))
    .slice(0, 30)
})

// ── 第一步：進一台機台，然後直接關掉瀏覽器（模擬 task 結束沒退出）──────────
let seated = ''
{
  const b = await launch()
  try {
    const page = await b.newPage({ viewport: { width: 1024, height: 768 } })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await pcWaitLobby(page, 90_000)
    for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }
    const t = await pickFreeOnScreen(page)
    if (t) { await page.mouse.click(t.x, t.y); await page.waitForTimeout(8000) }
    seated = await pcInGameMachineName(page)
    console.log(JSON.stringify({ step: 'seat', target: t?.name, scene: await pcSceneName(page), seated }))
  } finally { await b.close() }
}

// ── 第二步：用目標尺寸重新開，看會不會被送回機台，然後試著退出 ─────────────
{
  const [w, h] = SIZE2.split('x').map(Number)
  const b = await launch()
  try {
    const page = await b.newPage({ viewport: { width: w, height: h } })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await pcInstallEvalShim(page)
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(2500)
      const s = await pcSceneName(page)
      if (s === 'game') break
    }
    console.log(JSON.stringify({ step: 'reopen', size: SIZE2, scene: await pcSceneName(page), inGame: await pcInGameMachineName(page) }))
    await page.screenshot({ path: `${OUT}/seat-1-reopen.png` })

    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForTimeout(2500)
    console.log(JSON.stringify({ step: 'resized', scene: await pcSceneName(page) }))
    await page.screenshot({ path: `${OUT}/seat-2-resized.png` })
    console.log(JSON.stringify({ boxesBefore: await dumpBoxes(page) }))

    const back = await page.evaluate(() => {
      const cc = window.cc
      const all = []
      const walk = (n, d) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const n = all.find(x => String(x.name) === 'menu_back' && x.activeInHierarchy)
      if (!n?.worldPosition) return null
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const vis = cc.view.getVisibleSize()
      return { x: Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width), y: Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height) }
    })
    console.log(JSON.stringify({ menuBack: back }))
    // 直接跑正式的 pcBackToLobby，這樣測到的就是實際上線的那條路徑
    const r = await pcBackToLobby(page)
    console.log(JSON.stringify({ step: 'pcBackToLobby', ok: r.ok, scene: r.scene, steps: r.steps }))
    await page.screenshot({ path: `${OUT}/seat-3-after-back.png` })
    if (r.ok) {
      const d = await pcWaitLobby(page, 45_000)
      console.log(JSON.stringify({ step: 'lobbyAfterBack', ready: d.ready, hasGrid: d.hasGrid, machineItems: d.machineItems }))
    }
  } finally { await b.close() }
}
