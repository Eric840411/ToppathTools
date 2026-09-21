/**
 * 「預約達上限時，再預約同款的另一台會不會提示替換」。
 *
 *   H5_URL='<帳號池 URL>' OUT=<目錄> node scripts/ui-checks/h5-reserve-limit-replace.mjs
 *
 * 後台 `Game Setting → Machine Reservation Limit` 是**每款遊戲**的上限，
 * 實測 QAT：RISINGROCKETS=1、BULLBLI=1、JJBX=1、coincombo=0、JJBXGRAND=0。
 * 所以**不用改後台**就測得了：同款預約第二台時應該要跳「替換原預約」的提示。
 *
 * ⚠️ H5 面板上的「Number of reservations remaining: 50」是**帳號層級的總數**，
 *    跟這裡的每款上限不是同一個東西——我一開始以為要預約 50 台才打得到上限。
 *
 * 🚨 流程需要**同款的兩台**。Quick Join 在身上有預約時會把你送回**你預約的那一台**，
 *    所以第二台要從機台列表自己挑（點卡片 → 列表 → 挑一台 → `.gm-info-join`）。
 * 🚨 會真的預約，`finally` 一定要清乾淨。
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'

const URL_H5 = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))
let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }

async function tap(locator, label) {
  try { await locator.click({ timeout: 7000 }); log({ tap: label, via: 'click' }); return true }
  catch {
    try { await locator.evaluate(el => el.click()); log({ tap: label, via: 'js' }); return true }
    catch { log({ tap: label, via: 'FAIL' }); return false }
  }
}
const machineName = (page) => page.locator('.machine-id').first().innerText().then(t => t.trim()).catch(() => '')
const pickDenom = async (page) => {
  const d = page.locator('.btn_bet:not(.my-button--disabled)').first()
  await d.click({ timeout: 6000 }).catch(() => d.evaluate(el => el.click()).catch(() => {}))
  await page.waitForTimeout(5000)
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null, page = null, reserved = false
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  page = await ctx.newPage()
  await page.goto(URL_H5, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  await dismissLobbyPopups(page)
  stop = startLobbyPopupWatcher(page)

  // ── ① 進第一台並預約 ──────────────────────────────────────────────────────
  if (!h5InGame(page)) {
    await tap(page.locator('.grid-item').first(), '點遊戲卡片')
    await page.waitForTimeout(8000)
    await tap(page.locator('text=Quick Join').first(), 'Quick Join')
    await page.waitForTimeout(16000)
  }
  await pickDenom(page)
  const X = await machineName(page)
  check('① 進得了第一台', !!X, X)
  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await tap(page.locator('.reserve-btn-long').first(), '🚨 Reserve Now（預約 X）')
  reserved = true
  await page.waitForTimeout(6000)

  // ── ② 離開，再從機台列表挑**同款的另一台** ───────────────────────────────
  const left = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
  check('② 離開 X', left.ok, left.steps.join(' → ').slice(0, 60))
  await page.waitForTimeout(6000)

  /**
   * 找**同款的第二台空機**。
   *
   * ⚠️ 兩個踩過的坑：
   *   ① H5 大廳的 `.grid-item` 是「**機台卡片**」不是「遊戲卡片」——直接取第一張非目標的
   *      會挑到隔壁款；而上限是**每款**算的，換款就打不到上限。
   *   ② 大廳**一次只渲染幾張卡**，可視範圍內常常沒有同款的第二台。
   *
   * 解法：先用左側的遊戲分類（`.menu-item`，文字是遊戲名）跳到那一款，再邊捲邊收集。
   */
  await page.waitForTimeout(4000)
  const gameKey = X.replace(/[^A-Za-z]/g, '').slice(0, 12).toLowerCase()
  const menuHit = await page.evaluate((key) => {
    for (const el of document.querySelectorAll('.menu-item')) {
      const t = (el.textContent ?? '').replace(/\s+/g, '').toLowerCase()
      if (t && key.startsWith(t.slice(0, 8))) { el.click(); return t }
    }
    return ''
  }, gameKey)
  log({ 跳到遊戲分類: menuHit || '(沒對到，留在原本的清單)' })
  await page.waitForTimeout(5000)

  /** 邊捲邊收集同款的空機（大廳是延後渲染的，不捲就看不到） */
  const findOther = async () => {
    for (let i = 0; i < 8; i++) {
      const list = await page.evaluate(() => [...document.querySelectorAll('.grid-item')].map(el => ({
        name: el.querySelector('.grid-item-name')?.textContent.trim() ?? '',
        kids: [...el.querySelectorAll('*')].map(k => k.className?.toString?.() ?? '').join(' '),
      })))
      const prefix = X.split(/\s+/).slice(0, 2).join(' ')
      const hit = list.find(m => m.name && m.name !== X && m.name.startsWith(prefix) && !/occupied/i.test(m.kids))
      if (hit) { log({ 掃到第幾輪: i + 1, 清單筆數: list.length }); return hit }
      await page.evaluate(() => {
        let best = null, area = 0
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight - el.clientHeight <= 40) continue
          const r = el.getBoundingClientRect()
          if (r.width * r.height > area) { best = el; area = r.width * r.height }
        }
        if (best) best.scrollTop += 800
      })
      await page.waitForTimeout(1800)
    }
    return null
  }
  const other = await findOther()
  log({ 挑中: other?.name })
  await page.screenshot({ path: `${OUT}/lim-1-machine-list.png` })
  check('③ 找得到同款的另一台空機', !!other, other?.name ?? '(沒有)')
  if (other) {
    await tap(page.locator(`.grid-item:has(.grid-item-name:text-is("${other.name}"))`).first(), `點 ${other.name}`)
    await page.waitForTimeout(6000)
    // Game Preview 面板 → 進場鍵
    await tap(page.locator('.gm-info-join').first(), '按進場（.gm-info-join）')
    await page.waitForTimeout(16000)
    await pickDenom(page)
  }
  const Y = await machineName(page)
  check('④ 進到同款的另一台（不是原本那台）', !!Y && Y !== X, `X=${X}｜Y=${Y}`)

  // ── ③ 在 Y 按 Reserve Now → 應該跳「替換」提示 ──────────────────────────
  await tap(page.locator('.reserve').first(), '開預約面板')
  await page.waitForTimeout(4500)
  await tap(page.locator('.reserve-btn-long').first(), '在 Y 按 Reserve Now（此時同款已達上限 1）')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${OUT}/lim-2-replace-prompt.png` })
  const prompt = await page.evaluate(() => {
    const box = document.querySelector('.box-content, .box, .my-dialog')
    return (box?.textContent ?? document.body.innerText).replace(/\s+/g, ' ').trim().slice(0, 240)
  })
  log({ 提示內容: prompt })
  check('⑤ 有跳出提示（提到 replace／取代／已預約）', /replace|取代|替換|reserved machine/i.test(prompt), prompt.slice(0, 90))

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  try {
    if (page && reserved) {
      if (!h5InGame(page)) {
        await tap(page.locator('.grid-item').first(), '收尾：點卡片')
        await page.waitForTimeout(8000)
        await tap(page.locator('text=Quick Join').first(), '收尾：Quick Join')
        await page.waitForTimeout(16000)
        await pickDenom(page)
      }
      if (!(await page.locator('.cancel-btn').count().catch(() => 0))) {
        await tap(page.locator('.reserve').first(), '收尾：開面板')
        await page.waitForTimeout(4000)
        await tap(page.locator('.reserved').first(), '收尾：Reserved 分頁')
        await page.waitForTimeout(4000)
      }
      let n = await page.locator('.cancel-btn').count().catch(() => 0)
      let guard = 0
      while (n > 0 && guard++ < 5) {
        await tap(page.locator('.cancel-btn').first(), '收尾：取消預約')
        await page.waitForTimeout(4000)
        if (await page.locator('.box-btn_text2').count().catch(() => 0)) {
          await tap(page.locator('.box-btn_text2').first(), '收尾：確認')
          await page.waitForTimeout(4000)
        }
        n = await page.locator('.cancel-btn').count().catch(() => 0)
      }
      log({ 收尾後剩下的預約: n })
    }
    if (page && h5InGame(page)) {
      const back = await h5BackToLobby(page, { log: l => log({ exit: l }), reloadUrl: URL_H5 })
      log({ exit: back.ok ? '✅ 已退出機台' : '❌ 退出失敗' })
    }
  } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}
