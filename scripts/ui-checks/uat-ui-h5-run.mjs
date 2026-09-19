/**
 * 用真的瀏覽器操作 UAT 工具自己的畫面，把 H5 測試從頭建到跑完。
 * 使用者 2026-09-19 明確要求：**要在前端實際操作，不能單純打 API**。
 *
 * 流程：登入 → OSM Tools → UAT → H5 分頁 → 新增腳本 → 編輯流程（Workflow Editor）
 *      → 一步一步加積木 → 儲存 → 設定目標網址／解析度 → 執行 → 看結果
 *
 * ⚠️ 每一段都截圖，因為這支的重點就是「畫面上真的能不能操作」——
 *    只看 API 回 200 是看不出畫面壞掉的。
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const EMAIL = process.env.EMAIL ?? 'lusa@toppath.tw'
const OUT = process.env.OUT ?? '.'
const STOP_AT = process.env.STOP_AT ?? 'end'
const H5_URL = process.env.H5_URL ?? ''

const snap = (page, name) => page.screenshot({ path: `${OUT}/uath5-${name}.png`, fullPage: false })
const log = (o) => console.log(JSON.stringify(o))

/** 畫面上看得到的可互動元素（找選擇器用） */
const dumpInteractive = (page, limit = 40) => page.evaluate((lim) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 6 && r.height > 6 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const out = []
  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, textarea, label')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName,
      cls: (el.className?.toString() ?? '').slice(0, 34),
      txt: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 26),
      ph: el.getAttribute?.('placeholder') ?? '',
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    })
  }
  const seen = new Set()
  return out.filter(o => { const k = o.tag + o.cls + o.txt + o.ph; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, lim)
}, limit)

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(4000)

  // ── 登入 ────────────────────────────────────────────────────────────────
  const card = page.locator(`text=${EMAIL}`).first()
  if (await card.count()) { await card.click({ timeout: 10000 }); await page.waitForTimeout(3500) }
  log({ step: 'login', as: EMAIL })

  // ── 進 OSM Tools → UAT ─────────────────────────────────────────────────
  const osm = page.locator('.sidebar-nav-item', { hasText: 'OSM Tools' }).first()
  if (await osm.count()) { await osm.click({ timeout: 10000 }); await page.waitForTimeout(1500) }
  await snap(page, '1-osm-menu')
  const subItems = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar-nav-item, .sidebar-sub-item, aside button, aside a'))
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28)).filter(Boolean).slice(0, 40))
  log({ step: 'osm-submenu', subItems })

  const uat = page.locator('text=/UAT|整合測試|整測/').first()
  if (await uat.count()) { await uat.click({ timeout: 10000 }); await page.waitForTimeout(3500) }
  await snap(page, '2-uat-page')
  log({ step: 'uat-page', heading: await page.locator('h1').first().innerText().catch(() => '(無)') })
  if (STOP_AT === 'uat') { log({ stopped: 'uat' }); await browser.close(); process.exit(0) }

  // ── 切到 H5 分頁 ───────────────────────────────────────────────────────
  const h5tab = page.locator('.uat-main-tabs button', { hasText: 'H5' }).first()
  if (await h5tab.count()) { await h5tab.click({ timeout: 10000 }); await page.waitForTimeout(3000) }
  await snap(page, '3-h5-tab')
  log({ step: 'h5-tab', ok: await h5tab.count() > 0 })
  // ── 選取腳本 → 編輯流程（Workflow Editor）─────────────────
  /**
   * ⚠️ **每次都開一份新腳本**，不要沿用舊的——
   *    編輯器的「新增步驟」是**追加**，跑第二次會變成 35 顆、第三次 53 顆，
   *    而畫面上只看得到前幾顆，很容易以為「沒加進去」。
   */
  const createBtn = page.locator('button', { hasText: '新增測試腳本' }).first()
  await createBtn.click({ timeout: 10000 })
  await page.waitForTimeout(2500)
  const scriptName = 'H5 完整流程 ' + new Date().toISOString().slice(11, 19)
  const nameBox = page.locator('input[placeholder="腳本名稱"]').first()
  if (await nameBox.count()) { await nameBox.fill(scriptName, { timeout: 8000 }) }
  log({ step: 'create-script', name: scriptName })

  await snap(page, '4-script-selected')

  const editBtn = page.locator('button', { hasText: '編輯流程' }).first()
  log({ step: 'edit-button', found: await editBtn.count() })
  if (await editBtn.count()) {
    await editBtn.click({ timeout: 10000 })
    await page.waitForTimeout(3000)
  }
  await snap(page, '5-workflow-editor')
  // ── 在編輯器裡用「＋新增步驟」一顆一顆加 ─────────────────
  // 下拉選單的項目（使用者截圖裡的）：
  //   瀏覽器：前往頁面 / 等待
  //   互動：點擊元素 / 點擊畫面 / 點擊 Canvas / 輸入文字
  //   驗證：驗證可見 / 尋找基準圖 / 這支 API 必須被呼叫
  //   證據：截圖
  /**
   * ⚠️ 「＋新增步驟」**是一個原生 `<select>`**，不是點一下展開的選單。
   *    我一開始當成按鈕去點，它的 textContent 是所有選項串在一起
   *    （「＋ 新增步驟前往頁面等待點擊元素…」），所以文字比對永遠對不上。
   *    正確做法是 `selectOption`。
   */
  const stepSelect = page.locator('select').filter({ hasText: '新增步驟' }).first()
  const addStep = async (label) => {
    if (!await stepSelect.count()) { log({ addStep: label, selectNotFound: true }); return false }
    let ok = true
    await stepSelect.selectOption({ label }).catch((e) => {
      ok = false
      log({ addStep: label, selectFailed: String(e).split('\n')[0].slice(0, 90) })
    })
    await page.waitForTimeout(1200)
    if (ok) log({ addStep: label, ok: true })
    return ok
  }

  await addStep('前往頁面')
  /**
   * 🚨 **用 label 文字找欄位是錯的，而且錯得無聲。**
   *
   * 我原本寫 `setField('網址', url)`，它回報 ok:true——但實際上**填到「步驟名稱」去了**
   * （所以第 01 步的標題變成一整串網址，而真正的網址欄位還是空的）。
   * label 在這個版面上不是 `<label for>`，是旁邊的 div，往上找兄弟會先撞到別的欄位。
   *
   * 改成**照 INSPECTOR 的實際結構**取：
   *   [0] 步驟名稱(input) [1] 動作類型(select) [2] 該動作的參數 [3] 失敗處理(select)
   * 參數欄位隨動作不同（前往頁面=網址、等待=毫秒、點擊/驗證=選擇器），
   * 但**位置都是第 3 個控制項**，比猜名字穩。
   */
  /**
   * 找 INSPECTOR 面板：先在頁面裡幫它貼一個標記，再用 Playwright 定位。
   * ⚠️ 直接用 `div` + hasText 會命中一堆祖先節點（或一個都沒有），
   *    實測 `inputs: 0`。貼標記的好處是選擇範圍精確，
   *    而且後續的輸入還是走 Playwright 的真實事件。
   */
  const tagInspector = () => page.evaluate(() => {
    document.querySelectorAll('[data-claude-inspector]').forEach(el => el.removeAttribute('data-claude-inspector'))
    const cands = Array.from(document.querySelectorAll('div, section, aside'))
      .filter(el => (el.textContent ?? '').includes('步驟設定') && el.querySelectorAll('input').length >= 1)
    const panel = cands[cands.length - 1]
    if (!panel) return 0
    panel.setAttribute('data-claude-inspector', '1')
    return panel.querySelectorAll('input').length
  })
  const inspector = page.locator('[data-claude-inspector="1"]')
  const fillInspector = async (name, param) => {
    // ⚠️ 用 Playwright 的 `fill()`（真的輸入事件），**不要直接寫 DOM 的 value**。
    //    先前我用原生 setter + dispatchEvent 寫值，讀回來**完全正確**，
    //    但存檔之後所有選擇器都是空的——React 根本沒有收到。
    //    症狀是「畫面上看起來填好了、跡也正常、跡到實際跑的時候整批失敗」，
    //    而且我自己的 read-back 還給了綿燈。使用者要的「真的在前端操作」也是這個意思。
    const tagged = await tagInspector()
    const inputs = inspector.locator('input')
    const n = await inputs.count()
    if (!n) { log({ fillInspector: name, panelInputs: tagged, note: '找不到輸入框' }); return false }
    if (n >= 1 && name != null) await inputs.nth(0).fill(name, { timeout: 8000 }).catch(() => {})
    if (n >= 2 && param != null) await inputs.nth(1).fill(param, { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(350)
    const back = { name: n >= 1 ? await inputs.nth(0).inputValue().catch(() => '') : '', param: n >= 2 ? await inputs.nth(1).inputValue().catch(() => '') : '' }
    const okName = name == null || back.name === name
    const okParam = param == null || back.param === param
    log({ fillInspector: name, inputs: n, back, okName, okParam })
    return okName && okParam
  }

  // 剛剛加的「前往頁面」把網址填進去（留空的話會用執行設定的目標網址）
  await fillInspector('開啟 H5 大廳', H5_URL)
  await snap(page, '7-goto-filled')

  /**
   * 剩下的積木。選擇器全部是 2026-09-19 在真站台量的：
   *   `.grid-item` 大廳卡片 / `.video_cctv` CCTV / `.btn_bet` 面額 / `.btn_play` 帶入額度
   * ⚠️ 進機台是「點卡片 → Game Preview → Quick Join」三段，不是點一下就進去。
   * ⚠️ 進機台後**一定要先選面額**，否則整個畫面（含 header）都點不動。
   */
  const plan = [
    ['等待', '等大廳載入', '12000'],
    ['驗證可見', '大廳有機台卡片', '.grid-item-name'],
    ['截圖', '大廳畫面', null],
    ['點擊元素', '點第一張遊戲卡片', '.grid-item >> nth=0'],
    ['等待', '等遊戲分頁', '9000'],
    ['點擊元素', 'Quick Join 自動配台', ':text-is("Quick Join")'],
    ['等待', '等機台載入', '15000'],
    ['截圖', '進到機台', null],
    ['驗證可見', '機台內：CCTV', '.video_cctv'],
    ['驗證可見', '機台內：Cash Out', '.btn_cashout'],
    ['驗證可見', '機台內：路單', '.road'],
    ['驗證可見', '機台內：Top Up', '.header_btn_item_deposit'],
    // ⚠️ `.btn_bet:not(.my-button--disabled)` 命中 4 個 → click 要求唯一，直接失敗。
    //    而且「哪一顆是 disabled」隨當下狀態變，不能當成過濾條件。用 nth 指定一顆最穩。
    ['點擊元素', '選面額 ₱2', '.btn_bet >> nth=1'],
    ['等待', '等面額面板收起', '7000'],
    ['截圖', '選完面額', null],
    ['點擊元素', '帶入額度（會動到餘額）', '.btn_play >> nth=0'],
    ['等待', '等帶入完成', '9000'],
    ['截圖', '帶入後', null],
  ]

  for (const [type, name, param] of plan) {
    const added = await addStep(type)
    if (!added) continue
    await fillInspector(name, param)
  }
  await snap(page, '8-all-steps')
  const blockCount = await page.locator('text=/\d+ 個區塊/').first().innerText().catch(() => '?')
  log({ step: 'steps-built', blockCount })

  // ── 儲存 ────────────────────────────────────────────────────────────────
  const closeBtn = page.locator('button:has-text("關閉")').first()
  if (await closeBtn.count()) { await closeBtn.click({ timeout: 8000 }); await page.waitForTimeout(1500) }
  const saveBtn = page.locator('button:has-text("儲存腳本")').first()
  if (await saveBtn.count()) { await saveBtn.click({ timeout: 8000 }); await page.waitForTimeout(2500) }
  log({ step: 'saved', saveFound: await saveBtn.count() })
  await snap(page, '9-saved')

  // ── RUN SETTINGS：目標網址／解析度／執行位置 ────────────────────────────
  // ⚠️ 這幾個欄位在右邊那一欄，用 placeholder 認比用 label 穩（label 是旁邊的 div）。
  const urlBox = page.locator('input[placeholder="https://..."]').first()
  if (await urlBox.count()) {
    await urlBox.fill(H5_URL, { timeout: 8000 })
    log({ runSetting: '目標網址', ok: true })
  }
  // 執行位置：挑自己的 agent（沒有的話留「自動挑一台」）
  const agentSel = page.locator('select.uat-field').first()
  if (await agentSel.count()) {
    const opts = await agentSel.locator('option').allTextContents()
    const mine = opts.find(o => /WIN-UAT/i.test(o))
    if (mine) { await agentSel.selectOption({ label: mine }); log({ runSetting: '執行位置', picked: mine }) }
    else log({ runSetting: '執行位置', options: opts.slice(0, 6) })
  }
  await snap(page, '10-run-settings')

  // 勾選這份腳本，然後按「執行所選腳本」
  const rowCheckbox = page.locator('input[type="checkbox"]').nth(0)
  if (await rowCheckbox.count()) await rowCheckbox.check({ timeout: 6000 }).catch(() => {})
  const runBtn = page.locator('button:has-text("執行所選腳本")').first()
  log({ step: 'run-button', found: await runBtn.count() })
  if (await runBtn.count()) {
    await runBtn.click({ timeout: 10000 })
    log({ step: 'clicked-run' })
  }
  await page.waitForTimeout(6000)
  await snap(page, '11-running')

  // 盯著畫面上的通過/失敗計數
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(8000)
    const stats = await page.evaluate(() => {
      const txt = (document.body?.innerText ?? '').replace(/\s+/g, ' ')
      const pass = txt.match(/通過\s*(\d+)/)?.[1]
      const fail = txt.match(/失敗\s*(\d+)/)?.[1]
      const running = /執行中|running/i.test(txt)
      return { pass, fail, running }
    })
    log({ t: new Date().toISOString().slice(11, 19), ...stats })
    if (!stats.running && (stats.pass !== '0' || stats.fail !== '0')) break
  }
  await snap(page, '12-result')
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
} finally {
  await browser.close()
}
