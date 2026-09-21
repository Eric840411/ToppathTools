/**
 * PC（Cocos）**機台內**有哪些可點的節點——為了把 TC 表「machine」那 27 筆變成可執行的腳本。
 *
 *   PC_URL='<PC 版 token URL>' [GAME=Phoenix] npx tsx scripts/ui-checks/pc-ingame-recon.ts
 *
 * PC 機台內一樣沒有 DOM，只能讀場景樹。這支把「**有文字標籤、而且看得見**」的節點倒出來，
 * 那些才是寫得出斷言／點得到的東西（路書、最愛、History、Rank、Daily…）。
 *
 * ⚠️ 會真的進機台（佔位子），跑完會退回大廳。**跑之前先鎖帳號。**
 * ⚠️ **只看不點。** 機台內亂點可能下注或預約，那是有副作用的動作。
 */
import { chromium } from 'playwright'
import {
  pcInstallEvalShim, pcWaitLobby, pcClosePopups, pcSeekMachine, pcEnterMachine,
  pcSceneName, pcInGameMachineName, pcBackToLobby, startPcPopupWatcher, pcCollectMachines,
} from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const GAME = process.env.GAME ?? 'Phoenix'
const OUT = process.env.OUT ?? '.'
if (!PC_URL) { console.log('要給 PC_URL'); process.exit(1) }

/** 場景樹裡「看得見 + 有文字」的節點：名稱、標籤、位置、大小 */
const dumpNodes = (page: import('playwright').Page) => page.evaluate(() => {
  interface N {
    name?: string; activeInHierarchy?: boolean; children?: N[]; parent?: N | null
    worldPosition?: { x: number; y: number }
    components?: Array<{ string?: string }>
    getComponent?: (t: string) => { contentSize?: { width: number; height: number } } | null
  }
  const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
  if (!cc) return { hasCc: false, nodes: [] as Array<Record<string, unknown>> }
  const all: N[] = []
  const walk = (n: N | null | undefined, d: number) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
  walk(cc.director.getScene(), 0)
  const labelOf = (n: N) => {
    for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim()
    return ''
  }
  const out: Array<Record<string, unknown>> = []
  for (const n of all) {
    if (n.activeInHierarchy === false || !n.worldPosition) continue
    const label = labelOf(n)
    const name = String(n.name ?? '')
    // 要嘛有文字標籤，要嘛名字看起來像按鈕——其他的是排版容器，寫不出斷言
    if (!label && !/btn|button|menu|icon|tab/i.test(name)) continue
    const ui = n.getComponent?.('cc.UITransform')
    out.push({
      name: name.slice(0, 28),
      label: label.slice(0, 26),
      x: Math.round(n.worldPosition.x), y: Math.round(n.worldPosition.y),
      w: Math.round(ui?.contentSize?.width ?? 0), h: Math.round(ui?.contentSize?.height ?? 0),
      parent: String(n.parent?.name ?? '').slice(0, 22),
    })
  }
  const seen = new Set<string>()
  return { hasCc: true, nodes: out.filter(o => { const k = `${o.name}|${o.label}`; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 60) }
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop: (() => void) | null = null
let page: import('playwright').Page | null = null
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await ctx.newPage()
  await page.goto(PC_URL, { timeout: 60_000 })
  await pcInstallEvalShim(page)
  let d = await pcWaitLobby(page, 25_000)
  if (!d.ready) { await page.goto(PC_URL, { timeout: 30_000 }); d = await pcWaitLobby(page, 40_000) }
  await pcClosePopups(page)
  stop = startPcPopupWatcher(page, { onClose: n => console.log(`🧹 看門狗關掉 ${n} 個彈窗`) })

  // 先捲一輪讓卡片畫出來（不捲的話點不進去，見 frontend-engine 裡的說明）
  const warm = await pcCollectMachines(page, { steps: 40 })
  console.log(`先捲一輪：看到 ${warm.machines.length} 台`)

  const seek = await pcSeekMachine(page, GAME)
  if (!seek.picked) { console.log(`找不到可用的 ${GAME}`); process.exit(1) }
  const entered = await pcEnterMachine(page, seek.picked.name)
  console.log(`進機台：${entered.entered ? '✅' : '❌'} ${entered.actual || entered.reason}`)
  if (!entered.entered) process.exit(1)
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${OUT}/pc-ingame.png` })
  console.log('場景 =', await pcSceneName(page), '｜機台 =', await pcInGameMachineName(page))

  const { hasCc, nodes } = await dumpNodes(page)
  console.log(`機台內有標籤／像按鈕的節點（hasCc=${hasCc}）：`)
  for (const n of nodes) console.log('   ' + JSON.stringify(n))
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  // 位子一定要放掉
  try {
    if (page && await pcSceneName(page).catch(() => '') === 'game') {
      const back = await pcBackToLobby(page)
      console.log(`退回大廳：${back.ok ? '✅' : '❌'} ${back.steps.join(' → ')}`)
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}
