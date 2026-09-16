/**
 * 錄製腳本工作台：「各 TC 對照」解除綁定 ＋ Esc 關閉。
 *
 *   npx vite --port 5199 --strictPort      （另開一個視窗）
 *   node scripts/ui-checks/multi-tc-unbind-esc.mjs
 *
 * 為什麼要有這支：使用者回報「誤加了 TC，儲存後想刪除卻無法刪除」。
 * 根因不是漏做刪除，是**解除的入口會消失**——原本只有左側候選清單的 checkbox，
 * 而那份清單被搜尋字串過濾、也要 Lark TC 載入成功才有。
 *
 * 驗收條件照 CodeX review 開的四項：搜尋遮住 TC、載入失敗、解除後儲存重開、
 * 錄製啟停途中按 Esc。
 */
import { chromium } from 'playwright'
import { BLOCK_DEFS } from '../../server/uat-runner/block-engine.js'

const base = process.env.UAT_UI_TEST_URL || 'http://127.0.0.1:5199'
let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  // ⚠️ 用常駐 handler + 旗標，不要用 page.once。
  //    once 在「這一步其實沒跳對話框」時會殘留下來，攔到後面某個不相干的
  //    對話框，錯誤訊息是 'already handled'，跟真正的原因完全對不起來（踩過）。
  let dialogAnswer = 'accept'
  const dialogs = []
  page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAnswer === 'accept' ? d.accept() : d.dismiss()) })

  let saved = null
  let scanFails = false
  let scanRows = ['藍底：可用機器數量', '橘底：大廳玩家數量', '綠底：投入與出金'].map((text, i) => ({
    recordId: `rec${i}`, storageKey: `tblFixture:rec${i}`, number: `T-A-00${i + 1}`, text, sub: 'Dashboard', source: 'live',
  }))
  // 錄製維持「進行中」：停止要靠測試自己放行，才驗得到「錄製途中 Esc 不關」
  let recordDone = false

  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url())
    let data = { ok: true }
    if (url.pathname.endsWith('/scan')) data = scanFails ? { ok: false, error: 'fixture scan failure' } : { ok: true, tcs: scanRows }
    else if (url.pathname.endsWith('/blocks')) data.blockDefs = BLOCK_DEFS
    else if (url.pathname.endsWith('/recorded-scripts')) {
      if (req.method() === 'PUT') { saved = { ...req.postDataJSON(), id: 'script-1' }; data.script = saved }
      else data.scripts = saved ? [saved] : []
    } else if (url.pathname.endsWith('/record/start')) data = { ok: true, sessionId: 'fixture-session', agentLabel: 'Fixture Agent' }
    else if (url.pathname.includes('/record/status/') || url.pathname.includes('/record/stop/')) data = { ok: true, steps: [], done: recordDone }
    else if (url.pathname.endsWith('/results')) data.runs = []
    await route.fulfill({ json: data })
  })

  const closeCount = () => page.evaluate(() => window.__closeCount || 0)
  const reviews = () => page.locator('.uat-multi-review')
  const unbind = name => page.locator('.uat-multi-review').filter({ hasText: name }).getByRole('button', { name: '解除綁定' })

  await page.goto(`${base}/scripts/ui-checks/multi-tc-fixture.html`)
  await page.getByLabel('腳本名稱').fill('解除綁定回歸')
  for (const cb of await page.locator('.uat-multi-candidates input').all()) await cb.check()
  eq('三筆都綁上了', await reviews().count(), 3)
  eq('每張卡都有解除綁定鈕', await page.getByRole('button', { name: '解除綁定' }).count(), 3)

  // ── ① 搜尋遮住 TC：checkbox 不見了，但卡片上的解除鈕還在 ──
  await page.getByLabel('搜尋可綁定 TC').fill('綠底')
  eq('搜尋後候選清單只剩 1 筆（另外兩筆的 checkbox 消失）',
    await page.locator('.uat-multi-candidates input').count(), 1)
  eq('「各 TC 對照」仍然列出全部 3 筆', await reviews().count(), 3)
  // ⚠️ 先把「新增步驟歸屬」指到等一下要解除的那筆，驗解除有沒有把它清掉。
  //    **不能用 select 的 inputValue 判斷**——option 被移掉之後瀏覽器會讓 select
  //    自動回報 ''，不管 React state 裡的值還在不在。這正是 CodeX 提醒的
  //    「畫面退回顯示共用、值其實還在」，用 DOM 量會拿到假的綠燈（實際踩過）。
  //    真正看得到的地方是「加入步驟」實際寫進去的 tcId。
  await page.getByLabel('新增步驟歸屬').selectOption('rec0')
  await unbind('藍底').click()
  eq('搜尋遮住時仍解除得掉', await reviews().count(), 2)
  await page.getByRole('button', { name: '加入步驟', exact: true }).click()
  const ownerAfter = await page.evaluate(() =>
    document.querySelectorAll('.uat-multi-steps li').length)
  eq('解除後新增的步驟有被加進去', ownerAfter > 0, true)

  // ⚠️ 載入失敗**不會**清空候選清單——`tcScan` 還留著上一次成功的結果，
  //    所以「重新載入失敗」這條路其實仍看得到 checkbox。真正變成空的是下面 ②
  //    那個「重開頁面、Lark 還沒載進來」的情境，也正是使用者實際踩到的那個。
  await page.getByLabel('搜尋可綁定 TC').fill('')
  scanFails = true
  await page.getByRole('button', { name: '重新載入 Lark TC' }).click()
  await page.getByRole('alert').filter({ hasText: '載入 TC 失敗' }).waitFor()
  eq('載入失敗時已綁的仍然列得出來', await reviews().count(), 2)
  eq('載入失敗時解除鈕仍可按', await unbind('橘底').isEnabled(), true)

  // ── 存檔 ──
  scanFails = false
  await page.getByRole('button', { name: '重新載入 Lark TC' }).click()
  await page.waitForTimeout(250)
  const saveBtn = page.getByRole('button', { name: /^儲存( \*)?$/ })
  await saveBtn.click()
  await page.getByText('腳本已儲存。').waitFor()
  eq('存進後端的 bindings 是 2 筆', saved.bindings.length, 2)
  // 這才是「addOwner 有沒有被清掉」唯一看得準的地方：實際寫進步驟的 tcId。
  eq('解除之後加的步驟歸屬是 null，不是那個已經失效的 rec0',
    saved.steps.at(-1).tcId, null)

  // ── ② 重開頁面、Lark TC 還沒載進來：checkbox 一個都沒有 ──
  //    這就是使用者說的「儲存後想刪除卻無法刪除」。
  scanFails = true
  await page.goto(`${base}/scripts/ui-checks/multi-tc-fixture.html?empty`)
  await page.getByLabel('已儲存的錄製腳本').selectOption('script-1')
  await page.waitForTimeout(250)
  eq('候選清單完全是空的（舊版在這裡連 checkbox 都沒有）',
    await page.locator('.uat-multi-candidates input').count(), 0)
  eq('但「各 TC 對照」照樣列出已綁的 2 筆', await reviews().count(), 2)
  await unbind('橘底').click()
  eq('沒有候選清單也解除得掉', await reviews().count(), 1)

  // ── ③ 解除 → 儲存 → 重開，解除結果要留得住 ──
  await page.getByRole('button', { name: /^儲存( \*)?$/ }).click()
  await page.getByText('腳本已儲存。').waitFor()
  eq('存進後端的 bindings 只剩 1 筆', saved.bindings.length, 1)
  eq('留下的是綠底那筆', saved.bindings[0].recordId, 'rec2')
  dialogAnswer = 'accept'
  await page.getByLabel('已儲存的錄製腳本').selectOption('')
  await page.getByLabel('已儲存的錄製腳本').selectOption('script-1')
  eq('重開後仍是 1 筆（解除沒有被復活）', await reviews().count(), 1)
  scanFails = false

  // ── ④ Esc ──
  // ⚠️ 每一條開跑前都要把 dirty 清掉（存檔後「儲存」那顆會沒有 * 號）。
  //    不清的話 dirty 會一路撐著 hasUnsaved，下面驗 JSON 草稿、驗錄製中防線的
  //    那幾條會「因為別的原因而通過」——注入違規也不會變紅（實際踩過）。
  const saveNow = async () => {
    await page.getByRole('button', { name: /^儲存( \*)?$/ }).click()
    await page.getByRole('button', { name: '儲存', exact: true }).waitFor()
    // 還要等它變回 enabled——「儲存」這顆的 disabled 綁的是 busy，而 setDirty(false)
    // （* 號消失）發生在 act() 的 finally 之前。只等 * 號消失的話，接著按 Esc 會被
    // closeWorkbench 裡的 busy 擋掉，看起來像「Esc 壞了」，其實是測試按太快。
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent === '儲存')
      return !!b && !b.disabled
    })
  }
  await saveNow()
  eq('起始沒有被關過', await closeCount(), 0)
  dialogAnswer = 'accept'
  const d0 = dialogs.length
  await page.keyboard.press('Escape')
  eq('沒有未儲存變更時 Esc 直接關', await closeCount(), 1)
  eq('而且沒有多問一次', dialogs.length, d0)

  await page.getByLabel('腳本名稱').fill('改個名字製造未儲存')
  dialogAnswer = 'dismiss'
  await page.keyboard.press('Escape')
  eq('未儲存時按取消，不會關', await closeCount(), 1)
  dialogAnswer = 'accept'
  await page.keyboard.press('Escape')
  eq('未儲存時按確定，才會關', await closeCount(), 2)

  // ⚠️ JSON 編輯框打字不會標記 dirty（只有「套用 JSON」才走 edit()）。
  //    先存檔把 dirty 清乾淨，這一條才是真的在驗 jsonDraft。
  await saveNow()
  await page.getByRole('button', { name: 'JSON 編輯' }).click()
  await page.getByLabel('多 TC 步驟 JSON').fill('[{"action":"open_page","path":"/x"}]')
  dialogAnswer = 'dismiss'
  const dJson = dialogs.length
  await page.keyboard.press('Escape')
  eq('dirty 已清時，未套用的 JSON 草稿仍要觸發確認', dialogs.length, dJson + 1)
  eq('JSON 草稿還沒套用時，Esc 不會直接關', await closeCount(), 2)
  await page.getByRole('button', { name: '套用 JSON' }).click()

  // ── 錄製中：關閉鈕本來就 disabled，Esc 必須跟著擋 ──
  // ⚠️ 這裡一定要先存檔 + dialogAnswer = 'accept'：
  //    留著未儲存變更的話，就算防線被拿掉，Esc 也會被「確認對話框」擋下來，
  //    測試照樣綠——那是假的。存乾淨之後，唯一擋得住的就只剩 recId/busy 那道。
  await page.goto(`${base}/scripts/ui-checks/multi-tc-fixture.html`)
  await page.waitForTimeout(250)
  await page.locator('.uat-multi-candidates input').first().check()
  await page.getByLabel('腳本名稱').fill('錄製中按 Esc')
  await saveNow()
  dialogAnswer = 'accept'
  await page.getByRole('button', { name: '錄製並接在後面' }).click()
  await page.getByRole('button', { name: /^停止錄製/ }).waitFor()
  const before = await closeCount()
  eq('錄製中關閉鈕是 disabled', await page.getByRole('button', { name: '關閉' }).isDisabled(), true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  eq('錄製中按 Esc 不會關（不然就沒有停止錄製的入口了）', await closeCount(), before)

  recordDone = true
  await page.getByRole('button', { name: /^停止錄製/ }).click()
  await page.getByRole('button', { name: '錄製並接在後面' }).waitFor()

  eq('過程中沒有 pageerror', errors, [])
} finally {
  await browser.close()
}

console.log('\n通過 ' + pass + '｜失敗 ' + fails.length)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }
