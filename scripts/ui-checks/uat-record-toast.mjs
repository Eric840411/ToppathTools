/** 驗證沒有 Local Agent 時，錄製錯誤顯示為 viewport 內的浮動提示。 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const session = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!session) throw new Error('沒有有效登入 session')

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([{ name: 'toppath_auth', value: session.sid, domain: 'localhost', path: '/' }])
  const page = await context.newPage()
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.setItem('toppath-theme-mode', 'xianxia'))
  await page.reload({ waitUntil: 'networkidle' })
  for (const label of ['OSM Tools', 'UAT 整合測試']) {
    const link = page.getByText(label, { exact: true }).first()
    if (await link.count()) {
      await link.click()
      await page.waitForTimeout(900)
    }
  }

  await page.getByRole('button', { name: '錄製新 TC' }).click()
  const toast = page.locator('.uat-record-toast')
  await toast.waitFor({ state: 'visible' })
  await page.waitForTimeout(250)
  const result = await toast.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const topbarBottom = document.querySelector('.app-topbar')?.getBoundingClientRect().bottom ?? 0
    const samplePoints = [
      [rect.left + rect.width / 2, rect.top + 3],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.bottom - 3],
    ]
    return {
      text: element.textContent ?? '',
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      topCentered: rect.top < innerHeight / 3 && Math.abs((rect.left + rect.right) / 2 - innerWidth / 2) < 2,
      belowTopbar: rect.top >= topbarBottom,
      fullyUncovered: samplePoints.every(([x, y]) => document.elementsFromPoint(x, y)
        .some(node => node === element || element.contains(node))),
      position: getComputedStyle(element).position,
      oldErrorBarVisible: [...document.querySelectorAll('.uat-backend-rec-bar')]
        .some(row => (row.textContent ?? '').includes('目前沒有 Local Agent')),
    }
  })
  await page.screenshot({ path: path.join(root, 'uat-record-toast-preview.png') })
  const pass = result.inViewport && result.topCentered && result.belowTopbar && result.fullyUncovered
    && result.position === 'fixed' && !result.oldErrorBarVisible
    && result.text.includes('無法開始錄製') && result.text.includes('Local Agent')
  console.log(JSON.stringify(result, null, 2))
  console.log(pass ? 'PASS 浮動提示顯示正確' : 'FAIL 浮動提示不符合預期')
  process.exitCode = pass ? 0 : 1
} finally {
  await browser.close()
  db.close()
}
