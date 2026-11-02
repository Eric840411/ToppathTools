/**
 * 新版外框的兩個回歸（CodeX 審 ea86844 重現過的）：
 *  1. 動畫開關關掉後，「從 opacity:0 播進場」的內容（Dashboard 事件、仙俠逐字標題）要看得見
 *  2. 頁面裡沒走 createPortal 的彈窗遮罩，要蓋得住側欄（不能還點得到側欄切頁）
 *  3. 動畫關掉時排行榜境界圖要換靜態 PNG
 * 跑法：node scripts/ui-checks/redesign-motion-stack.mjs <base url>
 */
import Database from 'better-sqlite3'
import { chromium } from 'playwright'
import { mintDevSession } from './lib/dev-session.mjs'

const [H] = process.argv.slice(2)
if (!H) { console.error('用法：node scripts/ui-checks/redesign-motion-stack.mjs <base url>'); process.exit(2) }
const db = new Database('server/data.db')
const { sid } = mintDevSession(db, 'eric.wu@toppath.tw', 1800000)
const u = new URL(H)
let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

const b = await chromium.launch()
for (const theme of ['classic', 'xianxia']) {
  console.log(`== ${theme}`)
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: u.hostname, path: '/' }])
  await ctx.addInitScript(t => { try { localStorage.setItem('toppath-theme-mode', t); localStorage.setItem('toppath-motion', 'off') } catch { /* */ } }, theme)
  const p = await ctx.newPage()
  await p.goto(H + '/', { waitUntil: 'networkidle' })
  await p.waitForTimeout(1500)
  check('動畫開關是關的', await p.evaluate(() => document.documentElement.classList.contains('rd-no-motion')))
  const ev = await p.evaluate(() => [...document.querySelectorAll('.dashboard-event')].map(e => getComputedStyle(e).opacity))
  check('Dashboard 事件看得見', ev.length > 0 && ev.every(o => o === '1'), JSON.stringify(ev.slice(0, 3)))
  if (theme === 'xianxia') {
    const xw = await p.evaluate(() => [...document.querySelectorAll('.xx-reveal > .xx-w')].map(e => getComputedStyle(e).opacity))
    check('仙俠逐字標題看得見', xw.length > 0 && xw.every(o => o === '1'), `${xw.length} 字`)
  }
  // 非 portal 彈窗：在 main-content 裡塞一個 z-index 9999 的 fixed 遮罩，側欄那一點應該點到遮罩
  const covered = await p.evaluate(() => {
    const m = document.querySelector('.main-content')
    const d = document.createElement('div')
    d.id = 'probe-overlay'
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4)'
    m.appendChild(d)
    const s = document.querySelector('.app-sidebar').getBoundingClientRect()
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + 200)
    d.remove()
    return hit?.id === 'probe-overlay'
  })
  check('非 portal 彈窗遮罩蓋得住側欄', covered)
  // 背景沒蓋到內容：主內容中間那點不是背景層
  const bgOnTop = await p.evaluate(() => {
    const r = document.querySelector('.main-content').getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 120)
    return !!hit?.closest('.rd-ambient')
  })
  check('背景層不在內容上面', !bgOnTop)
  if (theme === 'xianxia') {
    await p.locator('.sidebar-nav-item').filter({ hasText: /群英榜|境界排行/ }).first().click()
    await p.waitForTimeout(1500)
    const srcs = await p.evaluate(() => [...document.querySelectorAll('.realm-art img')].map(i => i.currentSrc))
    check('排行榜境界圖是靜態 PNG', srcs.length > 0 && srcs.every(s => s.includes('/realms-v1/') && s.endsWith('.png')), srcs[0])
  }
  await ctx.close()
}
await b.close()
console.log(fail ? `\n${fail} 條失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)
