// 直接反覆測 pcBackToLobby：進機台 → 退回大廳 → 確認大廳真的重建 → 再來一次。
// 為什麼要迴圈：退出成功率是這條流程唯一還不穩的地方，單次成功不代表修好了。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcSceneName, pcInGameMachineName, pcBackToLobby, pcSeekMachine, pcEnterMachine } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const ROUNDS = Number(process.env.ROUNDS ?? 3)
const [w, h] = (process.env.SIZE ?? '1024x768').split('x').map(Number)
const OUT = process.env.OUT ?? '.'
const WANT = process.env.WANT ?? '5 Dragons'

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

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let pass = 0, fail = 0
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90_000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }

  for (let round = 1; round <= ROUNDS; round++) {
    // 用正式的 seek + enter，測到的才是實際上線的路徑（不能只靠第一螢剛好有空機）
    let t = await pickFreeOnScreen(page)
    let enter
    if (t) {
      enter = await pcEnterMachine(page, t.name)
    } else {
      const seek = await pcSeekMachine(page, WANT)
      if (!seek.picked) { console.log(JSON.stringify({ round, skip: 'seek found nothing', scanned: seek.scanned })); continue }
      t = { name: seek.picked.name }
      enter = await pcEnterMachine(page, seek.picked.name)
    }
    const scene = await pcSceneName(page)
    const inGame = await pcInGameMachineName(page)
    if (scene !== 'game') { console.log(JSON.stringify({ round, enterFailed: true, target: t.name, scene, reason: enter?.reason })); continue }

    const r = await pcBackToLobby(page)
    const d = r.ok ? await pcWaitLobby(page, 45_000) : null
    const ok = !!(r.ok && d?.ready && d.hasGrid)
    if (ok) pass++; else { fail++; await page.screenshot({ path: `${OUT}/exit-fail-round${round}.png` }) }
    console.log(JSON.stringify({ round, entered: inGame, backOk: r.ok, lobbyReady: d?.ready ?? false, hasGrid: d?.hasGrid ?? false, machineItems: d?.machineItems ?? 0, steps: r.steps, verdict: ok ? 'PASS' : 'FAIL' }))
    for (let i = 0; i < 2; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }
  }
} finally {
  await browser.close()
  console.log(JSON.stringify({ summary: { pass, fail } }))
}
