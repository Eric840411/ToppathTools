/**
 * 錄製時「標記上傳欄位」——真的開瀏覽器、真的注入錄製器、真的點。
 *
 *   node scripts/ui-checks/uat-upload-mark.browser-test.mjs
 *
 * 為什麼一定要開瀏覽器：這段的重點全在「點下去之後發生什麼」——
 * 有沒有攔住原本的點擊（不然會跳出作業系統的選檔視窗）、有沒有從看得到的按鈕
 * 找到藏起來的 input、找不到時有沒有停下來。單元測試只驗轉換邏輯，這些全蓋不到。
 *
 * DOM 照使用者那一頁（Bonus Page Setting）：H5 Icon 與 PC Icon 兩塊上傳區，
 * 結構一模一樣，只有標題不同。
 */
import { chromium } from 'playwright'
import { backendRecorderScript, RECORDER_MARKER } from '../../server/uat-runner/backend-recorder.js'

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

const card = (title, opts = {}) => `
  <div class="el-card"><div class="el-card__body">
    <span class="title">${title}</span>
    ${opts.noInput ? '<div class="el-upload"><i class="plus" id="plus-' + title.replace(/\s/g, '') + '">+</i></div>'
      : `<div class="el-upload">
           <input type="file" class="el-upload__input" id="in-${title.replace(/\s/g, '')}" style="display:none">
           ${opts.twoInputs ? '<input type="file" class="el-upload__input" style="display:none">' : ''}
           <i class="plus" id="plus-${title.replace(/\s/g, '')}">+</i>
         </div>`}
  </div></div>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const events = []
  await page.exposeFunction('__recSink', payload => { events.push(payload) })
  // 錄製器把事件丟到 console，用 marker 認出來
  page.on('console', msg => {
    const t = msg.text()
    if (!t.startsWith(RECORDER_MARKER)) return
    try { events.push(JSON.parse(t.slice(RECORDER_MARKER.length))) } catch { /* 非 JSON 的忽略 */ }
  })
  // ⚠️ 用真的 goto，不要 setContent——init script 的執行時機不同，
  //    用 setContent 測會得到假的結論（backend-recorder 那支測試踩過）。
  await page.route('**/uploadpage', r => r.fulfill({
    contentType: 'text/html',
    body: `<html><body>${card('H5 Icon')}${card('PC Icon')}
      ${card('No Input', { noInput: true })}${card('Two Inputs', { twoInputs: true })}</body></html>`,
  }))
  await page.addInitScript(backendRecorderScript({ sessionId: 'test' }))
  await page.goto('http://localhost/uploadpage')
  // 登入階段不錄，要先解鎖
  await page.evaluate(() => { window.__toppathRecArmed = true })

  // ⚠️ 常駐 handler，不要用 page.once：沒跳對話框那次會殘留下來，
  //    攔到後面不相干的對話框，錯誤訊息 'already handled' 跟真正原因對不起來。
  const dialogs = []
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept() })
  const markAndPick = async (plusId, optionText) => {
    events.length = 0
    dialogs.length = 0
    await page.evaluate(() => { window.__toppathMarkMode = true })
    await page.click('#' + plusId, { modifiers: ['Alt'] })
    await page.waitForTimeout(150)
    const menu = await page.locator('[data-toppath-recorder-ui]').count()
    if (menu && optionText) {
      const item = page.locator('[data-toppath-recorder-ui]').getByText(optionText, { exact: false }).first()
      if (await item.count()) { await item.click(); await page.waitForTimeout(200) }
    }
    return { events: [...events], dialogs: [...dialogs], menuShown: menu > 0 }
  }

  // ── 0. 選單不可以被視窗裁掉 ──
  // ⚠️ 使用者實際遇到：選單從下面被切掉，最後兩個選項（含「這裡是上傳欄位」）
  //    整個看不到——功能等於碰不到。原因是位置用寫死的高度去夾，選單一變長就爆。
  //    沒有捲軸的頁面特別明顯，連捲下去看的機會都沒有。
  for (const [w, h, where] of [[1200, 800, '一般視窗'], [900, 420, '很矮的視窗'], [900, 300, '極矮的視窗']]) {
    await page.setViewportSize({ width: w, height: h })
    // 點畫面很下面的位置，這是最容易被裁到的情況
    await page.evaluate(() => { window.__toppathRecArmed = true })
    const plus = page.locator('#plus-PCIcon')
    await plus.scrollIntoViewIfNeeded()
    await plus.click({ modifiers: ['Alt'] })
    await page.waitForTimeout(150)
    const menu = page.locator('[data-toppath-recorder-ui]').filter({ hasText: '要檢查這個元素的什麼' }).first()
    const fits = await menu.evaluate((el, vp) => {
      const b = el.getBoundingClientRect()
      return { top: b.top >= 0, bottom: b.bottom <= vp.h, left: b.left >= 0, right: b.right <= vp.w,
               scrollable: el.scrollHeight > el.clientHeight ? el.clientHeight > 0 : true }
    }, { w, h })
    ok(`${where}：選單完全在畫面內`, fits.top && fits.bottom && fits.left && fits.right, JSON.stringify(fits))
    // 最後一個選項要點得到（碰不到就等於沒有這個功能）
    const last = menu.getByText('這裡是上傳欄位', { exact: false }).first()
    if (await last.count()) {
      await last.scrollIntoViewIfNeeded()
      const vis = await last.isVisible()
      ok(`${where}：「這裡是上傳欄位」碰得到`, vis)
    } else {
      ok(`${where}：「這裡是上傳欄位」碰得到`, false, '選項根本不在選單裡')
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.mouse.click(2, 2)
    await page.waitForTimeout(120)
  }
  await page.setViewportSize({ width: 1200, height: 800 })

  // ── 1. 正常：標 PC Icon 的 + 方塊 ──
  const pc = await markAndPick('plus-PCIcon', '這裡是上傳欄位')
  const upl = pc.events.find(e => e.action === 'upload_file')
  ok('標記後產生了一顆 upload_file 積木', !!upl, JSON.stringify(pc.events.slice(-2)))
  ok('selector 用標題文字圈住那張卡，不是結構路徑',
    !!upl && upl.selector.includes('PC Icon') && upl.selector.includes('input[type=file]'), upl?.selector)
  eq('帶出欄位名稱（報告要顯示是哪一格）', upl?.fieldLabel, 'PC Icon')
  ok('沒有順便多錄一顆 click（不然會多一個沒用的步驟）',
    !pc.events.some(e => e.action === 'click'), JSON.stringify(pc.events.map(e => e.action)))

  // ── 2. 產生的 selector 真的只打到 PC Icon ──
  if (upl) {
    const hits = await page.locator(upl.selector).count()
    eq('產生的 selector 只命中一個', hits, 1)
    const id = await page.locator(upl.selector).getAttribute('id')
    eq('而且命中的是 PC Icon 那個 input', id, 'in-PCIcon')
  }

  // ── 3. 那一塊沒有 input：要當場說，不可以退回別的欄位 ──
  const none = await markAndPick('plus-NoInput', '這裡是上傳欄位')
  ok('找不到檔案欄位時跳出說明', none.dialogs.length > 0, none.dialogs[0])
  ok('而且不產生積木（不可以退回結構路徑或第一個）',
    !none.events.some(e => e.action === 'upload_file'), JSON.stringify(none.events.map(e => e.action)))

  // ── 4. 同一塊裡有兩個 input：也要停 ──
  const two = await markAndPick('plus-TwoInputs', '這裡是上傳欄位')
  ok('容器內有兩個檔案欄位時跳出說明', two.dialogs.length > 0, two.dialogs[0])
  ok('而且不產生積木（不可以猜一個）',
    !two.events.some(e => e.action === 'upload_file'), JSON.stringify(two.events.map(e => e.action)))
} finally {
  await browser.close()
}

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }
