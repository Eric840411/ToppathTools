/**
 * PC 大廳捲動／節點探針（1008，claude-osm-2 T-A-002：pc_scroll 一直「捲動失敗（err）」、btn_top 找不到）。
 * 用 main 現在的 pc-cocos／反查器對真的大廳跑一次，把每一步的原始結果與例外印出來。只讀＋捲動，不點任何按鈕。
 *
 *   H5_URL='<PC 大廳網址>' npx tsx scripts/ui-checks/pc-scroll-probe.ts
 */
import { chromium } from 'playwright'
import { pcInstallEvalShim, pcWaitLobby, pcClosePopups, pcScrollToFraction, pcFindNode, describePcLobby } from '../../server/lib/pc-cocos.js'
import { pcNodeVisibility, pcResolveNodeId } from '../../server/uat-runner/pc-node-hittest.js'

const URL_PC = process.env.H5_URL ?? ''
if (!URL_PC) { console.log('要給 H5_URL'); process.exit(1) }
const out = (k: string, v: unknown) => console.log(`${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage()
  await pcInstallEvalShim(page)
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const lobby = await pcWaitLobby(page, 90000)
  out('大廳', describePcLobby(lobby))
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2000)
  // 直接在頁面裡看 ScrollView-gms 的元件，以及「捲動」本身會不會丟例外
  out('ScrollView-gms 元件', await page.evaluate(`(() => {
    const cc = window.cc; const all = []; const walk = (n, d) => { if (!n || d > 16) return; all.push(n); (n.children || []).forEach(c => walk(c, d + 1)) }
    walk(cc.director.getScene(), 0)
    const n = all.find(x => x.name === 'ScrollView-gms'); if (!n) return 'not found'
    return (n.components || []).map(c => ({ cls: (cc.js && cc.js.getClassName) ? cc.js.getClassName(c) : '', scrollToOffset: typeof c.scrollToOffset, getMax: typeof c.getMaxScrollOffset, getOff: typeof c.getScrollOffset, max: (() => { try { return c.getMaxScrollOffset && c.getMaxScrollOffset() } catch (e) { return 'throw:' + e.message } })(), vertical: c.vertical, content: !!c.content }))
  })()`))
  for (const f of [1, 0]) {
    const r = await pcScrollToFraction(page, f)
    out(`pcScrollToFraction(${f})`, r)
    await page.waitForTimeout(1200)
    out('btn_top（名稱）', await pcFindNode(page, 'btn_top'))
    out('btn_top（可見）', await pcNodeVisibility(page, 'btn_top'))
  }
  out('wlzbhelix>game-name 路徑', await pcResolveNodeId(page, 'gm-list>ScrollView-gms>view>content>wlzbhelix>game-name'))
  out('more_ScrollView>view>content>item1 路徑', await pcResolveNodeId(page, 'more_ScrollView>view>content>item1'))
  await page.screenshot({ path: 'pc-scroll-probe.png' })
  out('截圖', 'pc-scroll-probe.png')
} catch (e) {
  out('例外', (e as Error).stack ?? String(e))
} finally { await browser.close() }
