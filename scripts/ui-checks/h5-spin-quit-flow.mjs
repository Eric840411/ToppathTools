/**
 * H5 完整收尾：SPIN → Cash Out → Confirm → Quit → Confirm →**回到大廳，而且位子真的放掉了**。
 *
 * 這支要證的不是「按鈕點得到」，是**下一輪不會再掉回機台**。
 * 所以最後會**重新載入一次**：載入後停在 /lobby 才算過。停在 /game 就是位子沒放掉——
 * 那正是目前這個 bug 的症狀（大廳積木全部命中 0，看起來像選擇器壞了）。
 *
 * 選擇器（2026-09-19 由 `h5-spin-quit-recon.mjs` 在真站台量到，不是猜的）：
 *   `.btn_spin`        轉動。**帶入額度之後才出現**，所以順序不能顛倒
 *   `.box-btn_text2`   Tips 框的 Confirm（`.box-btn_text1` 是 Cancel）
 *                      ⚠️ 前一版用 `:text-is("Confirm")` 命中 0，卡在這裡很久
 *   `.header_btn_item` header 三顆（CCTV／Sound／Quit），Quit 是**最後一顆**
 *
 * ⚠️ 會動到餘額（買入 + 真的 SPIN）。QAT 帳號，跑之前先鎖帳號。
 *
 * 跑法：H5_URL='<帳號池 URL>' OUT=<目錄> [SPINS=3] node scripts/ui-checks/h5-spin-quit-flow.mjs
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const SPINS = Number(process.env.SPINS ?? 3)
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(JSON.stringify(o))

let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }

/** 被蓋住時退到 JS click（見 recon 檔的說明）。**不退到座標。** */
async function tap(locator, label) {
  try { await locator.click({ timeout: 8000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch (e) { log({ tap: label, via: 'FAIL', err: String(e).split('\n')[0].slice(0, 80) }); return false }
  }
}

/**
 * ⚠️ 機台內的 CREDIT **不在 DOM 裡**（在 Galacean canvas 上），`body.innerText` 抓到的
 *    「132」其實是 `132 Credits` 那顆買入按鈕的文字。唯一讀得到真實餘額的地方是
 *    Cash Out 的 Tips 框：「Cash out credit: N」。
 */
const cashoutCredit = (page) => page.evaluate(() => {
  const t = document.querySelector('.text-msg')?.textContent ?? ''
  const m = t.match(/([\d,\.]+)\s*$/)
  return m ? m[1] : null
})

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()

  // 「按了」跟「server 收到了」是兩件事——只有這裡分得出來（見 project_h5_spin_mechanism）
  const spinEvidence = []
  page.on('console', m => {
    const t = m.text()
    if (/clickAction|dealGMAction|moneyNtc|isspin|Spin/i.test(t)) { spinEvidence.push(t.slice(0, 140)); log({ console: t.slice(0, 140) }) }
  })

  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(13000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page, { onClose: c => log({ popup: c }) })

  // ── 進機台 ────────────────────────────────────────────────────────────────
  if (!page.url().includes('/game')) {
    const g = await page.locator('.grid-item-name').first().innerText().catch(() => '')
    await page.locator(`.grid-item:has(.grid-item-name:text-is("${g.trim()}"))`).click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(8000)
    await page.locator(':text-is("Quick Join")').first().click({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(15000)
  }
  check('進到機台（/game）', page.url().includes('/game'), page.url().slice(-28))
  if (!page.url().includes('/game')) process.exit(1)

  // 上一輪留下的 Tips 框會擋住整個畫面，先關掉（Cancel，不是 Confirm——不替別人決定要不要 cash out）
  if (await page.locator('.box-btn_text1').count()) {
    await tap(page.locator('.box-btn_text1').first(), '關掉上一輪殘留的 Tips 框(Cancel)')
    await page.waitForTimeout(2500)
  }

  // ── 選面額 → 帶入額度 → 這時候 .btn_spin 才會出現 ──────────────────────────
  await tap(page.locator('.btn_bet:not(.my-button--disabled)').first(), '面額')
  await page.waitForTimeout(6000)
  const spinBefore = await page.locator('.btn_spin').count()
  await tap(page.locator('.btn_play').first(), '帶入額度')
  await page.waitForTimeout(9000)
  const spinAfter = await page.locator('.btn_spin').count()
  await page.screenshot({ path: `${OUT}/flow-1-buyin.png` })
  check('帶入額度之後出現轉動控制 .btn_spin', spinAfter > 0, `買入前 ${spinBefore} → 買入後 ${spinAfter}`)

  // ── SPIN ──────────────────────────────────────────────────────────────────
  const before = spinEvidence.length
  for (let i = 0; i < SPINS; i++) {
    await tap(page.locator('.btn_spin').first(), `SPIN #${i + 1}`)
    // ⚠️ 單局約 3 秒，點太快只會被 server 以 1035（上一局未完成）拒絕＝假轉
    await page.waitForTimeout(5000)
  }
  await page.screenshot({ path: `${OUT}/flow-2-spun.png` })
  const sent = spinEvidence.slice(before)
  check('SPIN 真的送到 server（不是只有按鈕動畫）',
    sent.some(t => /clickAction\s*Spin|dealGMAction/i.test(t)),
    `${sent.length} 筆相關 console`)

  // ── 收尾 ①：Cash Out → Confirm ────────────────────────────────────────────
  await tap(page.locator('.btn_cashout').first(), 'Cash Out')
  await page.waitForTimeout(5000)
  const credit = await cashoutCredit(page)
  check('Cash Out 跳出 Tips 框', await page.locator('.box-btn_text2').count() > 0, `credit=${credit}`)
  await page.screenshot({ path: `${OUT}/flow-3-cashout-tips.png` })
  await tap(page.locator('.box-btn_text2').first(), 'Tips 框 Confirm')
  await page.waitForTimeout(6000)
  check('Confirm 之後 Tips 框關掉', await page.locator('.box-btn_text2').count() === 0)

  // ── 收尾 ②：Quit（header 最後一顆）→ 可能再一個確認框 ──────────────────────
  const header = page.locator('.header_btn_item')
  log({ headerCount: await header.count() })
  await tap(header.last(), 'Quit')
  await page.waitForTimeout(4000)
  if (await page.locator('.box-btn_text2').count()) {
    await page.screenshot({ path: `${OUT}/flow-4-quit-tips.png` })
    await tap(page.locator('.box-btn_text2').first(), '退出確認 Confirm')
    await page.waitForTimeout(6000)
  }
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/flow-5-after-quit.png` })
  check('退出後回到大廳', !page.url().includes('/game'), page.url().slice(-30))

  // ── 真正的證明：重新載入一次，還會不會掉回機台 ─────────────────────────────
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  await page.screenshot({ path: `${OUT}/flow-6-reload.png` })
  check('🚨 重新載入停在大廳（位子真的放掉了）', !page.url().includes('/game'), page.url().slice(-30))

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}
