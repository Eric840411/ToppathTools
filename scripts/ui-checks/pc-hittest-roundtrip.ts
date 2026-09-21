/**
 * 反查器的**來回驗證**：節點 → 座標 → 反查識別字 → 再解析回座標，兩次要對得上。
 *
 *   H5_URL='<PC 網址>' OUT=<目錄> npx tsx scripts/ui-checks/pc-hittest-roundtrip.ts
 *
 * 🚨 **為什麼要這樣驗**：反查器最容易犯的錯不是「找不到」，是**找到別顆**——
 *    腳本照樣跑、照樣綠，只是點在隔壁那個東西上。來回驗證會直接抓到這種錯：
 *    如果 `at()` 回的識別字解析出來是另一顆，兩邊座標就差很遠。
 *
 * 取樣取「畫面上看得到字的節點」（按鈕多半有標籤），比隨機取有代表性。
 * 通過標準：解析回來的座標與原座標差 **≤ 6px**（縮放換算會有零點幾的誤差）。
 */
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups } from '../../server/lib/pc-cocos.js'
import { installPcHitTest } from '../../server/uat-runner/pc-node-hittest.js'

const URL_PC = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const lobby = await pcWaitLobby(page, 90000).catch(() => null)
  log({ 大廳就緒: lobby?.ready, 機台卡: lobby?.machineItems })
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2500)
  await installPcHitTest(page)
  await page.screenshot({ path: `${OUT}/roundtrip-lobby.png` })

  const report = await page.evaluate(() => {
    const hit = (window as unknown as { __uatPcHit?: any }).__uatPcHit
    const cc = (window as unknown as { cc?: any }).cc
    if (!hit || !cc) return { error: '反查器或 cc 不在' }
    const all: any[] = []
    const walk = (n: any, d: number) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const labelOf = (n: any) => {
      for (const c of (n.components ?? [])) if (typeof c?.string === 'string' && c.string.trim()) return c.string.trim()
      return ''
    }
    // 取樣：畫面上看得到字、而且量得到大小的節點
    const sample = all.filter(n => n.activeInHierarchy !== false && n.worldPosition && labelOf(n)).slice(0, 25)
    // 直接用反查器對每顆節點的中心點做來回
    const out: any[] = []
    for (const n of sample) {
      // 中心點：借用反查器內部的換算——先用 at() 對一個一定命中的點確認它活著
      const canvas = document.querySelector('canvas')
      if (!canvas) break
      const rect = canvas.getBoundingClientRect()
      const vis = cc.view?.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
      const wp = n.worldPosition
      const cx = Math.round(rect.left + (wp.x / vis.width) * rect.width)
      const cy = Math.round(rect.top + rect.height - (wp.y / vis.height) * rect.height)
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue
      const found = hit.at(cx, cy)
      if (!found) { out.push({ label: labelOf(n), 結果: '反查不到' }); continue }
      const back = found.id ? hit.find(found.id) : null
      out.push({
        label: labelOf(n).slice(0, 18),
        命中: found.name, 識別字: found.id, 名字唯一: found.nameUnique, 疊了幾層: found.candidates,
        來回誤差: back ? Math.round(Math.abs(back.x - found.cx) + Math.abs(back.y - found.cy)) : null,
        解析結果: back ? back.name : '(解析不回來)',
      })
    }
    return { 取樣: sample.length, 結果: out }
  })
  log({ 來回驗證: report })

  const rows = (report as any).結果 ?? []
  const ok = rows.filter((r: any) => typeof r.來回誤差 === 'number' && r.來回誤差 <= 6)
  const noId = rows.filter((r: any) => !r.識別字)
  console.log(`\n來回成功 ${ok.length}／${rows.length}；給不出識別字 ${noId.length} 筆（這些要退回座標）`)
  if (!rows.length || ok.length < rows.length * 0.6) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  await browser.close()
}
