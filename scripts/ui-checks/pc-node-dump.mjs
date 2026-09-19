// 一次性診斷：卡片節點到底長怎樣、worldPosition 讀到什麼、正確的螢幕座標怎麼算。
// 背景見 pc-click-target-probe.mjs：pcMachineScreenPos 算出來的座標是假的。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const [w, h] = (process.env.SIZE ?? '1024x768').split('x').map(Number)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await pcWaitLobby(page, 90_000)
  for (let i = 0; i < 3; i++) { await pcClosePopups(page); await page.waitForTimeout(500) }
  const machines = await pcScanLobby(page)
  const target = (machines.find(m => !m.occupied) ?? machines[0])?.name ?? ''

  const dump = await page.evaluate((name) => {
    const cc = window.cc
    const out = { target: name, nodes: [], canvas: null, cameras: [], err: null }
    try {
      const all = []
      const walk = (n, d) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)

      const labelOf = (n) => {
        for (const comp of (n.components ?? [])) {
          if (typeof comp.string === 'string' && comp.string.trim()) return comp.string.trim()
        }
        return ''
      }
      const chain = (n) => { const a = []; let p = n; for (let i = 0; i < 8 && p; i++) { a.push(String(p.name)); p = p.parent } return a.join(' < ') }

      for (const n of all) {
        if (labelOf(n) !== name) continue
        const ui = n.getComponent ? n.getComponent('cc.UITransform') : null
        let card = n
        for (let i = 0; i < 6 && card; i++) { if (String(card.name) === 'machine_item') break; card = card.parent }
        const cardUi = card && card.getComponent ? card.getComponent('cc.UITransform') : null
        out.nodes.push({
          chain: chain(n),
          active: n.active, activeInHierarchy: n.activeInHierarchy,
          worldPosition: n.worldPosition ? { x: Math.round(n.worldPosition.x), y: Math.round(n.worldPosition.y) } : null,
          position: n.position ? { x: Math.round(n.position.x), y: Math.round(n.position.y) } : null,
          hasUITransform: !!ui,
          uiSize: ui ? { w: Math.round(ui.width), h: Math.round(ui.height) } : null,
          cardFound: card ? String(card.name) : null,
          cardChain: card ? chain(card) : null,
          cardWorld: card?.worldPosition ? { x: Math.round(card.worldPosition.x), y: Math.round(card.worldPosition.y) } : null,
          cardUiSize: cardUi ? { w: Math.round(cardUi.width), h: Math.round(cardUi.height) } : null,
          getWorldPositionFn: typeof n.getWorldPosition === 'function',
        })
        if (out.nodes.length >= 4) break
      }

      const canvasNode = all.find(n => n.getComponent && n.getComponent('cc.Canvas'))
      if (canvasNode) {
        const comp = canvasNode.getComponent('cc.Canvas')
        out.canvas = {
          name: String(canvasNode.name),
          world: canvasNode.worldPosition ? { x: Math.round(canvasNode.worldPosition.x), y: Math.round(canvasNode.worldPosition.y) } : null,
          hasCameraComponent: !!comp?.cameraComponent,
        }
        const cam = comp?.cameraComponent
        if (cam) {
          const n0 = out.nodes[0]
          const src = n0?.cardWorld ?? n0?.worldPosition
          let screen = null
          try {
            if (src && typeof cam.worldToScreen === 'function') {
              const v = cam.worldToScreen(new cc.Vec3(src.x, src.y, 0))
              screen = { x: Math.round(v.x), y: Math.round(v.y) }
            }
          } catch (e) { screen = 'worldToScreen threw: ' + String(e).slice(0, 120) }
          out.cameras.push({ name: String(cam.node?.name ?? '?'), worldToScreen: screen })
        }
      }
      const r = document.querySelector('canvas').getBoundingClientRect()
      out.canvasRect = { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      out.visibleSize = cc.view.getVisibleSize ? { w: Math.round(cc.view.getVisibleSize().width), h: Math.round(cc.view.getVisibleSize().height) } : null
      out.designSize = cc.view.getDesignResolutionSize ? { w: Math.round(cc.view.getDesignResolutionSize().width), h: Math.round(cc.view.getDesignResolutionSize().height) } : null
      out.frameSize = cc.view.getFrameSize ? { w: Math.round(cc.view.getFrameSize().width), h: Math.round(cc.view.getFrameSize().height) } : null
      out.devicePixelRatio = window.devicePixelRatio
    } catch (e) { out.err = String(e).slice(0, 300) }
    return out
  }, target)

  console.log(JSON.stringify(dump, null, 1))
} finally {
  await browser.close()
}
