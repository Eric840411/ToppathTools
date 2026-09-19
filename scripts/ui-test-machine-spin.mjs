/**
 * UI simulation test: 從使用者角度執行 873-DFDC-0003 Spin 測試
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { resolve } from 'path'

const APP_URL = 'http://localhost:3000'
const LOBBY_URL = 'https://osm-redirect.osmslot.org/?token=4856597e673bda5a11cf674e783ac372-328883&platform=pc&mode=live&language=zh_cn&studioid=cp&gameid=osmdfdcgrand&lang=en_us&username=osmel078&device=mobile&isPwaClaimed=1'
const MACHINE_CODE = '873-DFDC-0003'
const PIN = '123456'
const LOGS_DIR = resolve('C:/Users/user/Desktop/Toppath tools/logs')

mkdirSync(LOGS_DIR, { recursive: true })
const shot = async (page, name) => {
  const path = resolve(LOGS_DIR, `ui-test-${name}.png`)
  await page.screenshot({ path, fullPage: false })
  log(`📸 截圖: ${name}`)
}

const log = (msg) => console.log(`[UI Test] ${msg}`)

const browser = await chromium.launch({ headless: false, slowMo: 200 })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(120000)

try {
  // ── Step 1: 開啟 App ──────────────────────────────────────────────────────
  log('Step 1: 開啟 App...')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForLoadState('networkidle')
  await shot(page, '01-loaded')

  // ── Step 2: 登入 ──────────────────────────────────────────────────────────
  log('Step 2: 登入 Eric Wu...')
  await page.waitForSelector('button:has-text("Eric Wu")', { timeout: 10000 })
  await shot(page, '02-login-modal')
  await page.click('button:has-text("Eric Wu")')

  // PIN 輸入
  const pinInput = page.locator('input[placeholder="Enter PIN"]')
  await pinInput.waitFor({ timeout: 5000 })
  await pinInput.fill(PIN)
  await shot(page, '03-pin-entered')
  await page.click('button.auth-login-primary:has-text("登入")')

  // 等待 modal 關閉（body 上帳號名稱出現，modal 消失）
  await page.waitForFunction(() => {
    // Modal 的 Eric Wu 按鈕不在 DOM 了，或 modal 容器隱藏
    const modal = document.querySelector('.auth-login-modal, .modal-overlay, [class*="modal"]')
    return !modal || getComputedStyle(modal).display === 'none' || getComputedStyle(modal).opacity === '0'
  }, { timeout: 15000 }).catch(() => log('(modal 關閉偵測 fallback)'))
  await page.waitForTimeout(1000)
  await shot(page, '04-logged-in')
  log('登入完成')

  // ── Step 3: 導航至 OSM Tools → Machine Test ─────────────────────────────
  log('Step 3: 導航至 Machine Test...')
  // 先設定 sessionStorage，讓 MachineTestPage 的 isAdmin 從 true 初始化（避免 PIN modal）
  await page.evaluate((pin) => sessionStorage.setItem('jira_admin_pin', pin), PIN)
  log('已設定 sessionStorage jira_admin_pin')
  await page.click('button.sidebar-nav-item:has-text("OSM Tools")')
  await page.waitForTimeout(500)

  // 點機台自動化測試 subtab
  const machineTestBtn = page.locator('button.sidebar-subtab-item').filter({ hasText: '機台自動化測試' })
  await machineTestBtn.waitFor({ timeout: 5000 })
  await machineTestBtn.click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  await shot(page, '05-machine-test-page')
  log('Machine Test 頁面已載入')

  // ── Step 4: 確認帳號顯示 ──────────────────────────────────────────────────
  const pageText = await page.textContent('body')
  if (pageText?.includes('Eric Wu') || pageText?.includes('eric.wu')) {
    log('✅ 帳號確認：Eric Wu 已登入')
  } else {
    log('⚠️ 未偵測到 Eric Wu 帳號資訊')
  }

  // ── Step 5: 填入大廳 URL ──────────────────────────────────────────────────
  log('Step 5: 填入大廳 URL...')
  const lobbyInput = page.locator('input[placeholder*="example.com/lobby"]').first()
  await lobbyInput.waitFor({ timeout: 5000 })
  await lobbyInput.fill(LOBBY_URL)
  log(`大廳 URL 已填入 (osmel078)`)

  // ── Step 6: 填入機台代碼 ──────────────────────────────────────────────────
  log('Step 6: 填入機台代碼...')
  const codesTextarea = page.locator('textarea.mt-codes-textarea')
  await codesTextarea.fill(MACHINE_CODE)
  log(`機台代碼: ${MACHINE_CODE}`)

  // ── Step 7: 設定測試步驟：entry + spin + cctv + exit（關掉 stream/audio）──────
  log('Step 7: 設定測試步驟...')
  // 順序: 0=entry 1=stream 2=spin 3=audio 4=ideck 5=touchscreen 6=cctv 7=exit
  const allCheckboxes = page.locator('.mt-step-check input[type="checkbox"]')
  const count = await allCheckboxes.count()
  log(`找到 ${count} 個步驟 checkbox`)

  // 取消 stream（index 1）
  const streamCb = allCheckboxes.nth(1)
  if (await streamCb.isChecked()) { await streamCb.uncheck(); log('取消 stream') }
  // 取消 audio（index 3）
  const audioCb = allCheckboxes.nth(3)
  if (await audioCb.isChecked()) { await audioCb.uncheck(); log('取消 audio') }
  // 確保 CCTV（index 6）已勾選
  if (count > 6) {
    const cctvCb = allCheckboxes.nth(6)
    if (!await cctvCb.isChecked()) { await cctvCb.check(); log('啟用 CCTV') }
    else { log('CCTV 已勾選') }
  }

  await shot(page, '06-configured')

  // ── Step 8: 確認按鈕狀態 ──────────────────────────────────────────────────
  log('Step 8: 確認開始按鈕狀態...')
  const startBtn = page.getByRole('button', { name: /開始測試/ })
  await startBtn.waitFor({ timeout: 5000 })
  const isDisabled = await startBtn.isDisabled()
  const btnText = await startBtn.textContent()
  log(`按鈕文字: "${btnText?.trim()}" | disabled=${isDisabled}`)

  if (isDisabled) {
    log('⚠️ 按鈕是 disabled 狀態，檢查原因...')
    const bodyText = await page.textContent('body')
    if (!bodyText?.includes('eric.wu') && !bodyText?.includes('Eric Wu')) {
      log('原因：帳號未設定（account=null）')
    }
    // 嘗試找帳號 indicator
    const accountIndicator = await page.locator('[class*="account"], [class*="user-info"]').first().textContent().catch(() => '(not found)')
    log(`帳號 indicator: ${accountIndicator}`)
    await shot(page, '07-btn-disabled-debug')
    throw new Error('開始按鈕是 disabled，無法繼續測試')
  }

  // ── Step 9: 點擊開始測試 ──────────────────────────────────────────────────
  log('Step 9: 點擊開始測試...')
  await startBtn.click()
  log('已點擊')

  // 等待測試開始（loading 狀態出現，最多 5 秒）
  const loadingStarted = await page.waitForSelector('button.submit-btn.loading, button:has-text("測試進行中")', { timeout: 5000 })
    .then(() => true).catch(() => false)

  if (!loadingStarted) {
    // 可能彈出 PIN modal（placeholder 是「輸入 PIN」中文）
    const adminPinModal = page.locator('input[placeholder="輸入 PIN"]')
    if (await adminPinModal.isVisible()) {
      log('偵測到管理員 PIN modal，輸入 PIN...')
      await adminPinModal.fill(PIN)
      await page.keyboard.press('Enter')
      await page.waitForSelector('button.submit-btn.loading', { timeout: 5000 }).catch(() => {})
    } else {
      await shot(page, '07-start-failed')
      // 抓錯誤訊息
      const errMsg = await page.locator('[class*="error"], [class*="alert"], .toast, [role="alert"]').first().textContent().catch(() => '')
      log(`⚠️ 測試未進入 loading 狀態，錯誤訊息：${errMsg || '(無)'}`)
    }
  }

  await shot(page, '08-running')
  log('測試執行中，等待完成...')

  // ── Step 10: 等待測試完成 ──────────────────────────────────────────────────
  // 最多等 2 分鐘 — waitForFunction 的第三個參數才是 options
  await page.waitForFunction(() => {
    const btn = document.querySelector('button.submit-btn, button[class*="submit"]')
    if (!btn) return false
    const text = btn.textContent ?? ''
    return text.includes('開始測試') && !text.includes('進行中') && !text.includes('重新連線')
  }, null, { timeout: 120000 })

  await shot(page, '09-done')
  log('測試完成！')

  // ── Step 11: 讀取結果 ──────────────────────────────────────────────────────
  log('Step 11: 讀取測試結果...')
  await page.waitForTimeout(1000)

  // 找結果 table（機台代碼欄）
  const resultCells = await page.locator('td code, .result-code, [class*="result"]').allTextContents().catch(() => [])
  log(`結果 cells: ${resultCells.slice(0, 10).join(' | ')}`)

  // 找 PASS/WARN/FAIL badges
  const passBadges = await page.locator(':text("PASS"), :text("✅"), [class*="pass"]').allTextContents().catch(() => [])
  const warnBadges = await page.locator(':text("WARN"), :text("⚠️"), [class*="warn"]').allTextContents().catch(() => [])
  const failBadges = await page.locator(':text("FAIL"), :text("❌"), [class*="fail"]').allTextContents().catch(() => [])
  log(`PASS badges (${passBadges.length}): ${passBadges.slice(0, 3).join(', ')}`)
  log(`WARN badges (${warnBadges.length}): ${warnBadges.slice(0, 3).join(', ')}`)
  log(`FAIL badges (${failBadges.length}): ${failBadges.slice(0, 3).join(', ')}`)

  // 搜尋 Spin 結果
  const allText = await page.textContent('body')
  const spinMatch = allText?.match(/(Spin[^\n]*?(PASS|WARN|FAIL)[^\n]*)/g)
  if (spinMatch) log(`Spin 結果: ${spinMatch[0]}`)

  await shot(page, '10-results')

} catch (err) {
  log(`❌ 錯誤: ${err.message}`)
  await page.screenshot({ path: resolve(LOGS_DIR, 'ui-test-ERROR.png') }).catch(() => {})
} finally {
  log('等待 5 秒後關閉...')
  await page.waitForTimeout(5000)
  await browser.close()
}
