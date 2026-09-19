/**
 * 把 INSPECTOR 在各種積木下**實際**的欄位名稱倒出來。
 * 不要用猜的——我猜「選擇器」「毫秒」，結果兩個都填不進去，
 * 而 `setField` 回 false 是我自己加的回報；沒有這個回報的話會變成「存檔了但欄位是空的」。
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const EMAIL = process.env.EMAIL ?? 'lusa@toppath.tw'
const OUT = process.env.OUT ?? '.'

const log = (o) => console.log(JSON.stringify(o))

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(4000)
  const card = page.locator(`text=${EMAIL}`).first()
  if (await card.count()) { await card.click({ timeout: 10000 }); await page.waitForTimeout(3500) }

  await page.locator('.sidebar-nav-item', { hasText: 'OSM Tools' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(1200)
  await page.locator('text=/UAT 整合測試/').first().click({ timeout: 10000 })
  await page.waitForTimeout(3500)
  await page.locator('.uat-main-tabs button', { hasText: 'H5' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(2500)
  await page.locator('button', { hasText: '新的 H5 測試' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(2000)
  await page.locator('button', { hasText: '編輯流程' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(2500)

  // 逐一點左邊清單裡的步驟，把右邊 INSPECTOR 的欄位名稱與型別抓出來
  const rows = page.locator('[class*="workflow"] [class*="step"], [class*="step-row"], [class*="uat-step"]')
  const n = await rows.count()
  log({ stepRows: n })

  const seenTypes = new Set()
  for (let i = 0; i < Math.min(n, 20); i++) {
    await rows.nth(i).click({ timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(600)
    const info = await page.evaluate(() => {
      const panel = Array.from(document.querySelectorAll('*')).find(el => (el.textContent ?? '').includes('步驟設定') && el.querySelector('input, select'))
      if (!panel) return null
      const fields = []
      for (const input of panel.querySelectorAll('input, select, textarea')) {
        // 欄位名稱：往上找最近一個有純文字的兄弟
        let label = ''
        let cur = input.parentElement
        for (let d = 0; d < 3 && cur && !label; d++, cur = cur.parentElement) {
          for (const c of cur.children) {
            const t = (c.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (c !== input && t && t.length <= 12 && !c.querySelector('input, select, textarea')) { label = t; break }
          }
        }
        fields.push({ label, tag: input.tagName, type: input.getAttribute('type') ?? '', ph: input.getAttribute('placeholder') ?? '', value: String(input.value ?? '').slice(0, 20) })
      }
      const type = panel.querySelector('select')?.value ?? ''
      return { actionValue: type, fields }
    })
    if (!info) continue
    const key = JSON.stringify(info.fields.map(f => f.label))
    if (seenTypes.has(key)) continue
    seenTypes.add(key)
    log({ row: i, info })
  }
  await page.screenshot({ path: `${OUT}/uat-inspector-labels.png` })
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  await browser.close()
}
