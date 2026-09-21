/**
 * PC 機台內的下注流程盤點：**帶入額度之後轉動控制長什麼樣、鍵盤能不能觸發**。
 *
 *   PC_URL='<PC 版 token URL>' [GAME=Phoenix] npx tsx scripts/ui-checks/pc-bet-flow-recon.ts
 *
 * ⚠️ 這支是 `.ts` 不是 `.mjs`：它要 import `lib/pc-cocos.ts`，純 JS 檔用 node 直接跑會
 *    在載入當下 ERR_MODULE_NOT_FOUND（TS 只有編譯過的伺服器端有 .js）。踩第二次了。
 *
 * H5 那條是 `.btn_spin`（買入後才出現）。PC 這邊第一次盤點時**完全沒看到 spin 節點**，
 * 所以推測跟 H5 一樣要先帶入額度——這支就是來證實這件事的。
 *
 * TC 還寫了「SPIN功能 > 可以用鍵盤空白鍵、Enter可觸發」，所以順便試鍵盤。
 *
 * 🚨 **會動到餘額**（帶入額度、真的轉）。QAT 帳號，跑之前先鎖帳號。
 * ⚠️ 跑完退回大廳，把位子放掉。
 */
import { chromium } from 'playwright'
import {
  pcInstallEvalShim, pcWaitLobby, pcClosePopups, pcSeekMachine, pcEnterMachine,
  pcSceneName, pcBackToLobby, startPcPopupWatcher, pcCollectMachines,
  pcClickNode,
} from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const GAME = process.env.GAME ?? 'Phoenix'
const OUT = process.env.OUT ?? '.'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

/** 場景樹裡看得見、有名字的節點（拿來 diff） */
const names = (page: import('playwright').Page) => page.evaluate(() => {
  interface N { name?: string; activeInHierarchy?: boolean; children?: N[] }
  const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
  if (!cc) return [] as string[]
  const all: N[] = []
  const walk = (n: N | null | undefined, d: number) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
  walk(cc.director.getScene(), 0)
  return all.filter(n => n.activeInHierarchy !== false).map(n => String(n.name ?? '')).filter(Boolean)
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop: (() => void) | null = null
let page: import('playwright').Page | null = null
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await ctx.newPage()
  // 「按了」跟「server 收到了」是兩件事——只有 WS／console 分得出來
  const evidence: string[] = []
  page.on('console', m => {
    const t = m.text()
    if (/spin|dealGMAction|moneyNtc|isspin|clickAction/i.test(t)) { evidence.push(t.slice(0, 150)); log({ console: t.slice(0, 150) }) }
  })

  await page.goto(PC_URL, { timeout: 60_000 })
  await pcInstallEvalShim(page)
  let d = await pcWaitLobby(page, 25_000)
  if (!d.ready) { await page.goto(PC_URL, { timeout: 30_000 }); d = await pcWaitLobby(page, 40_000) }
  await pcClosePopups(page)
  stop = startPcPopupWatcher(page, { onClose: n => log({ 關彈窗: n }) })
  await pcCollectMachines(page, { steps: 40 })   // 不先捲一輪的話卡片點不動

  const seek = await pcSeekMachine(page, GAME)
  if (!seek.picked) { log({ fatal: `找不到可用的 ${GAME}` }); process.exit(1) }
  const entered = await pcEnterMachine(page, seek.picked.name)
  log({ 進機台: entered.entered ? entered.actual : entered.reason })
  if (!entered.entered) process.exit(1)
  await page.waitForTimeout(8000)

  const before = new Set(await names(page))
  // ── 帶入額度（play_btn1＝最小的那檔）──────────────────────────────────────
  const buy = await pcClickNode(page, 'play_btn1')
  log({ 帶入額度: buy.ok ? `點在 ${buy.at?.x},${buy.at?.y}` : buy.reason })
  await page.waitForTimeout(9000)
  await page.screenshot({ path: `${OUT}/pcbet-1-buyin.png` })

  const fresh = [...new Set((await names(page)).filter(n => !before.has(n)))].slice(0, 24)
  log('帶入額度之後新出現的節點：')
  fresh.forEach(n => console.log('   ' + n))
  // 找像 spin 的
  const spinish = fresh.filter(n => /spin|start|go|play_now/i.test(n))
  log({ 像是轉動鍵的: spinish })

  // ── 試鍵盤（TC：空白鍵／Enter 可觸發 SPIN）──────────────────────────────
  const beforeKb = evidence.length
  await page.keyboard.press('Space')
  await page.waitForTimeout(6000)
  const kbSpace = evidence.length > beforeKb
  log({ 空白鍵有觸發嗎: kbSpace })
  const beforeEnter = evidence.length
  await page.keyboard.press('Enter')
  await page.waitForTimeout(6000)
  log({ Enter有觸發嗎: evidence.length > beforeEnter })
  await page.screenshot({ path: `${OUT}/pcbet-2-after-keys.png` })

  log({ 目前累積的相關console筆數: evidence.length })
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  try {
    if (page && await pcSceneName(page).catch(() => '') === 'game') {
      const back = await pcBackToLobby(page)
      log({ 退回大廳: back.ok ? '✅' : `❌ ${back.scene}`, steps: back.steps.join(' → ') })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}
