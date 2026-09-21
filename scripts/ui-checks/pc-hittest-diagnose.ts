/**
 * 診斷：**點在某張遊戲卡的中心，反查卻說是隔壁那張**（2026-09-20 實測到的矛盾）。
 *
 *   H5_URL='<PC 網址>' npx tsx scripts/ui-checks/pc-hittest-diagnose.ts
 *
 * 實測到的現象：`pcFindNode('…>bwjl>game-name')` 算出來是 (371, 192)，
 * 但反查器對同一個點說最深的是 `…>jjbxgrand>content`。兩個算式都在同一頁上跑，
 * 其中一個一定是錯的——**而且錯的那個不會報錯**，只會點到隔壁那一款。
 *
 * 這支把兩邊的數字攤開來比：
 *   ① 目標節點自己的矩形（含有沒有量到尺寸）
 *   ② 該點命中的前 6 名候選，各自的矩形與深度
 *   ③ 目標節點與命中節點的**共同祖先**——差在哪一層看得出來是偏移還是重疊
 */
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcFindNode } from '../../server/lib/pc-cocos.js'
import { installPcHitTest } from '../../server/uat-runner/pc-node-hittest.js'

const URL_PC = process.env.H5_URL ?? ''
const TARGET = process.env.TARGET ?? 'ScrollView-gms>view>content>bwjl>game-name'
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await pcWaitLobby(page, 90000).catch(() => null)
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2500)
  await installPcHitTest(page)

  const viaFind = await pcFindNode(page, TARGET)
  log({ pcFindNode說: viaFind })
  if (!viaFind) throw new Error(`找不到 ${TARGET}`)

  const diag = await page.evaluate(([want, px, py]) => {
    const cc = (window as unknown as { cc?: any }).cc
    const canvas = document.querySelector('canvas')!
    const rect = canvas.getBoundingClientRect()
    const vis = cc.view?.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
    const sx = rect.width / vis.width, sy = rect.height / vis.height
    const all: Array<{ n: any; d: number }> = []
    const walk = (n: any, d: number) => { if (!n || d > 18) return; all.push({ n, d }); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const visible = (n: any) => n.activeInHierarchy !== false && !!n.worldPosition
    const sizeOf = (n: any) => {
      for (const c of (n.components ?? [])) {
        if (typeof c?.width === 'number' && typeof c?.height === 'number' && (c.width || c.height)) {
          return { w: c.width, h: c.height, ax: c.anchorX ?? 0.5, ay: c.anchorY ?? 0.5, comp: c?.constructor?.name ?? '?' }
        }
      }
      return null
    }
    const rectOf = (n: any) => {
      const s = sizeOf(n); const wp = n.worldPosition
      if (!s || !wp) return null
      const sc = n.worldScale ?? { x: 1, y: 1 }
      const ww = s.w * (sc.x ?? 1), hh = s.h * (sc.y ?? 1)
      return {
        left: Math.round(rect.left + (wp.x - s.ax * ww) * sx), right: Math.round(rect.left + (wp.x + (1 - s.ax) * ww) * sx),
        top: Math.round(rect.top + rect.height - (wp.y + (1 - s.ay) * hh) * sy),
        bottom: Math.round(rect.top + rect.height - (wp.y - s.ay * hh) * sy),
        w: Math.round(ww), h: Math.round(hh), anchor: `${s.ax},${s.ay}`, scale: `${sc.x},${sc.y}`,
      }
    }
    // 目標節點（用路徑解析）
    const parts = want.split('>')
    let cur: any = all.find(x => visible(x.n) && String(x.n.name) === parts[0])?.n
    for (let i = 1; i < parts.length && cur; i++) cur = (cur.children ?? []).find((k: any) => String(k.name) === parts[i])
    const path = (n: any) => { const out: string[] = []; let c = n; for (let i = 0; i < 8 && c; i++) { out.unshift(String(c.name ?? '')); c = c.parent } return out.join('>') }

    const cands = all.filter(({ n }) => visible(n)).map(({ n, d }) => ({ n, d, r: rectOf(n) }))
      .filter(({ r }) => r && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)
      .sort((a, b) => b.d - a.d).slice(0, 6)

    return {
      點: { px, py },
      目標: cur ? { 路徑: path(cur), 量得到尺寸: !!sizeOf(cur), 矩形: rectOf(cur), 尺寸來源: sizeOf(cur)?.comp } : '(路徑解析不到)',
      候選: cands.map(({ n, d, r }) => ({ 路徑: path(n), 深度: d, 矩形: r })),
    }
  }, [TARGET, viaFind.x, viaFind.y] as [string, number, number])
  log({ 診斷: diag })
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  await browser.close()
}
