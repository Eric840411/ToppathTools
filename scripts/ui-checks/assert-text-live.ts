/**
 * `assert_text` 的真站台驗證（PC／Cocos label）。
 *
 *   H5_URL='<PC 網址>' npx tsx scripts/ui-checks/assert-text-live.ts
 *
 * 單元測試用的是假的 page，證明不了「真的讀得到畫面上的字」。這支在大廳上實際讀：
 *   ① 餘額（`lb_coin`）——數值模式，畫面上長這樣：31,568,677,510.61
 *   ② 帳號（`lb_name`）——文字模式，應該就是登入的帳號
 *   ③ **對不上的期望值一定要紅**（不然前兩項通過也不能算數——有可能它什麼都沒比）
 *   ④ 找不到的節點要明確報「找不到」，不是回空字串然後說通過
 *
 * ⚠️ 只讀不點。
 */
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups } from '../../server/lib/pc-cocos.js'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcNodeText } from '../../server/uat-runner/pc-node-hittest.js'

const URL_PC = process.env.H5_URL ?? ''
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o))
let pass = 0, fail = 0
const check = (title: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`)
  ok ? pass++ : fail++
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const lobby = await pcWaitLobby(page, 90000).catch(() => null)
  log({ 大廳就緒: lobby?.ready })
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2500)

  log({ 讀到的餘額: await pcNodeText(page, 'lb_coin'), 讀到的帳號: await pcNodeText(page, 'lb_name') })

  const run = (step: Record<string, unknown>) => runFrontendStep({ action: 'assert_text', name: 'text', ...step }, {
    idx: '', label: 'text', log: () => {}, page, state: {}, startUrl: URL_PC,
  }).then(() => '', (e: Error) => e.message)

  const balanceWhy = await run({ nodeName: 'lb_coin', value: '>0', matchMode: 'number' })
  check('① 餘額讀得到而且 > 0', !balanceWhy, balanceWhy)

  const nameWhy = await run({ nodeName: 'lb_name', value: 'osmel', matchMode: 'contains' })
  check('② 帳號讀得到', !nameWhy, nameWhy)

  const shouldFail = await run({ nodeName: 'lb_coin', value: '<0', matchMode: 'number' })
  check('③ 對不上的期望值真的會紅', !!shouldFail, shouldFail || '(竟然通過了)')

  const missing = await run({ nodeName: 'lb_does_not_exist', value: 'x' })
  check('④ 找不到的節點報「找不到」', /找不到/.test(missing), missing)

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  await browser.close()
}
