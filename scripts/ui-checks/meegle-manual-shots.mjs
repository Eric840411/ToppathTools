/**
 * Meegle 批量工具操作手冊的截圖（普通版）。讀 Sheet／讀 Meegle 用真的；**所有會寫入的請求一律假掉**
 * （開單、評論、狀態、修改、補回填、AI 產生名稱），最後印出所有 POST 讓人核對沒有漏網的寫入。
 * 跑法：node scripts/ui-checks/meegle-manual-shots.mjs [create|comment|status|edit|backfill ...]
 * 圖存到 docs/manual-meegle/
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import fs from 'fs'

const HOST = '192.168.3.41'
const SHEET = 'https://casinoplus.sg.larksuite.com/sheets/JjLosMhsShlrfatriEBlX3d7gLd?sheet=1Xp7sf'
const OUT = 'docs/manual-meegle'
fs.mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const want = k => !only.length || only.includes(k)
const db = new Database('server/data.db', { readonly: true })
const { sid } = db.prepare("SELECT sid FROM auth_sessions WHERE email = 'eric.wu@toppath.tw' AND expires_at > ? ORDER BY created_at DESC").get(Date.now())

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await ctx.addCookies([{ name: 'toppath_auth', value: sid, domain: HOST, path: '/' }])
await ctx.addInitScript(() => {
  localStorage.setItem('toppath-theme-mode', 'classic'); localStorage.setItem('meegle-guide-open', '0')
  // 截圖時藏起右下角浮動的 AI Agent 監控（會蓋到畫面）
  document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.ai-monitor-widget{display:none!important}'; document.head.appendChild(st) })
})

// ── 寫入一律假掉 ──
const posts = []
const WRITE = /\/api\/meegle\/(batch\/(row(\/[\w-]+)?|finish|people\/verify|generate-names)|comment\/(row|continue|writeback|finish|retry)|status\/(row|finish|retry|date)|edit\/(row|finish|retry)|backfill\/(retry|dismiss|restore))\b/
ctx.on('request', r => { if (r.method() !== 'GET' && r.url().includes('/api/')) posts.push(r.url().replace(/^https?:\/\/[^/]+/, '')) })
let n = 0
await ctx.route(u => WRITE.test(u.pathname), async r => {
  const url = r.request().url(), b = r.request().postDataJSON() ?? {}
  n++
  if (/batch\/generate-names/.test(url)) return r.fulfill({ json: { ok: true, results: (b.rows ?? []).map(x => ({ rowIndex: x.rowIndex, name: `${x.prefix}${x.prefix ? ' ' : ''}${String(x.content ?? '').replace(/^(\[[^\]]*\])+/, '').slice(0, 22)}` })) } })
  if (/batch\/row$/.test(url)) return r.fulfill({ json: { ok: true, row: { batchId: b.batchId, rowKey: b.rowKey, createPhase: 'created', workItemId: String(15250000 + n), url: null, statePhase: 'done', message: null, writebackPhase: 'done', writebackMsg: null } } })
  if (/status\/row$/.test(url)) return r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: [{ step: 'state', phase: 'done', message: null, attemptAt: 1 }, { step: 'date', phase: 'skipped', message: null, attemptAt: 1 }, { step: 'writeback', phase: 'done', message: null, attemptAt: 1 }] } })
  if (/edit\/row$/.test(url)) return r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: ['fields', 'roles', 'verify', 'writeback'].map(s => ({ step: s, phase: 'done', message: null, attemptAt: 1 })) } })
  if (/comment\/row$/.test(url)) return r.fulfill({ json: { ok: true, claim: { kind: 'claimed' }, steps: ['desc', 'comment', 'review', 'writeback'].map(s => ({ step: s, phase: s === 'review' ? 'skipped' : 'done', message: null, attemptAt: 1 })) } })
  if (/backfill\/restore/.test(url)) return r.fulfill({ json: { ok: true, results: (b.items ?? []).map(i => ({ ...i, ok: true, message: '已補回單號與處理階段' })) } })
  return r.fulfill({ json: { ok: true, results: [] } })
})

const page = await ctx.newPage()
page.on('pageerror', e => console.log('  pageerror', String(e).slice(0, 200)))
const shot = async (name, loc) => { await page.waitForTimeout(400); await (loc ?? page.locator('.page-layout').first()).screenshot({ path: `${OUT}/${name}.png` }); console.log('  📸', name) }
async function openTab(tab) {
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.getByText(/^(Meegle 批量工具|Jira 批量開單|卷宗管理)$/).first().click()
  await page.getByRole('button', { name: tab }).click()
  await page.waitForTimeout(800)
}
async function loadSheet() {
  await page.locator('.mb-input').first().fill(SHEET)
  await page.getByRole('button', { name: /讀取 Sheet/ }).first().click()
  await page.waitForFunction(() => document.querySelector('.mb-table tbody tr')
    || [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === '下一步' && !b.disabled), null, { timeout: 120000 })
  await page.waitForTimeout(1200)
}

if (want('create')) {
  console.log('== 開單')
  await openTab('Meegle 開單')
  await page.screenshot({ path: `${OUT}/00-entry.png` }); console.log('  📸 00-entry')
  await loadSheet()
  await shot('c1-load')
  await page.getByRole('button', { name: '下一步' }).click()
  // 等名單讀完（約 20 秒）
  await page.waitForFunction(() => !document.body.innerText.includes('正在讀取空間角色人員'), null, { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(800)
  await shot('c2-people')
  await page.getByRole('button', { name: '前往預覽' }).click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${OUT}/c3-preview.png` }); console.log('  📸 c3-preview（一開始：沒有關聯需求的都被擋）')
  // 只勾第 5、6 列
  const all = page.locator('.mb-selbar-all input')
  if (await all.isChecked()) await all.uncheck()
  for (const r of ['5', '6']) await page.locator('.mb-table tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${r}$`) }) }).locator('input[type=checkbox]').check()
  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.waitForTimeout(500)
  const reqSel = page.locator('.mb-bulk .mb-field', { hasText: '關聯需求' }).locator('select')
  const reqOpts = await reqSel.locator('option').allInnerTexts()
  const req = reqOpts.find(o => /P7-005/.test(o)) ?? reqOpts[1]
  await reqSel.selectOption({ label: req })
  const ttSel = page.locator('.mb-bulk .mb-field', { hasText: '任務類型' }).locator('select')
  if (await ttSel.count()) { const tt = await ttSel.locator('option').allInnerTexts(); await ttSel.selectOption({ label: tt.find(o => /BUG/i.test(o)) ?? tt[1] }) }
  await shot('c3-bulk', page.locator('.mb-bulk').last())
  await page.getByRole('button', { name: '套用到已勾選的列' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /批量設定/ }).click()
  await page.getByRole('button', { name: /AI 產生任務名稱/ }).click()
  const opts = await page.locator('.mb-ai select option').allInnerTexts()
  const pick = opts.find(c => /^摘要$/.test(c)) ?? opts.find(c => /描述/.test(c)); if (pick) await page.locator('.mb-ai select').selectOption({ label: pick })
  for (const c of ['類別', '主題']) await page.locator('.mb-ai-col', { hasText: new RegExp(`^${c}$`) }).locator('input').check().catch(() => {})
  await page.waitForTimeout(400)
  await shot('c3-ai', page.locator('.mb-ai'))
  await page.getByRole('button', { name: /為勾選的 \d+ 列產生名稱/ }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /AI 產生任務名稱/ }).click()
  await page.locator('.mb-chip--ok').click()
  await page.waitForTimeout(600)
  await shot('c3-ready')
  const send = page.getByRole('button', { name: /^送出 \d+ 列$/ })
  if (await send.isEnabled().catch(() => false)) {
    await send.click()
    await page.locator('.mb-tally').first().waitFor({ timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2000)
    await shot('c4-result')
  } else console.log('  ⚠ 沒有可送出的列，略過 ④')
}

if (want('comment')) {
  console.log('== 評論')
  await openTab('Meegle 評論')
  await loadSheet()
  const meegleRows = page.locator('.mb-table tbody tr').filter({ has: page.locator('a[href*="/detail/"]') })
  if (await meegleRows.count()) { const f = meegleRows.first().locator('input[type=checkbox]'); if (!(await f.isChecked())) await f.check() }
  await shot('m1-load')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.locator('.mc-identity').waitFor().catch(() => {})
  await page.locator('.mb-field').filter({ hasText: '評論內容欄' }).locator('select').selectOption('備註').catch(() => {})
  await page.waitForTimeout(1200)
  await shot('m2-fields')
  await page.getByRole('button', { name: '產生預覽' }).click()
  await page.locator('.mc-overwrite').waitFor({ timeout: 60000 }).catch(() => {})
  await page.waitForFunction(() => [...document.querySelectorAll('.mc-dot')].every(d => !/讀取中/.test(d.textContent || '')), null, { timeout: 120000 }).catch(() => {})
  await shot('m3-preview')
}

if (want('status')) {
  console.log('== 狀態')
  await openTab('Meegle 狀態')
  await loadSheet()
  for (const cb of (await page.locator('.mb-table tbody input[type=checkbox]:not([disabled])').all()).slice(0, 2)) if (!(await cb.isChecked())) await cb.check()
  await shot('s1-load')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.locator('.mb-field').filter({ hasText: '整批預設' }).locator('select').selectOption({ label: '完成' }).catch(() => {})
  await page.waitForTimeout(600)
  await shot('s2-target')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.ms-from')].some(e => e.textContent?.includes('讀取中')), null, { timeout: 60000 }).catch(() => {})
  await page.locator('.ms-table tbody tr').first().click().catch(() => {})
  await shot('s3-preview')
  await page.getByRole('button', { name: '前往送出' }).click()
  await page.locator('.mb-result').first().waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1200)
  await shot('s4-result')
}

if (want('edit')) {
  console.log('== 修改')
  const field = label => page.locator('.me-field').filter({ has: page.locator('.me-field-label', { hasText: new RegExp(`^${label}$`) }) })
  await openTab('Meegle 修改')
  await loadSheet()
  for (const cb of (await page.locator('.mb-table tbody input[type=checkbox]:not([disabled])').all()).slice(0, 2)) if (!(await cb.isChecked())) await cb.check()
  await shot('e1-load')
  await page.getByRole('button', { name: '下一步' }).click()
  await field('優先順序').locator('.me-mode').selectOption('fixed')
  await field('優先順序').locator('.me-field-value select').selectOption('P1')
  await field('難易度').locator('.me-mode').selectOption('fixed').catch(() => {})
  await page.waitForTimeout(600)
  await shot('e2-fields')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.me-st')].some(e => /讀取中|圖片載入中/.test(e.textContent || '')), null, { timeout: 90000 }).catch(() => {})
  await shot('e3-preview')
}

if (want('backfill')) {
  console.log('== 補回填')
  await openTab('Meegle 補回填')
  await page.getByLabel('Sheet 網址').fill(SHEET)
  await page.getByRole('button', { name: '掃描' }).click()
  await page.locator('.bf-scan ~ .mb-table-wrap tbody tr').first().waitFor({ timeout: 60000 }).catch(() => {})
  await shot('b1-backfill')
}

await browser.close()
console.log('\n所有非 GET 的 /api 請求：')
for (const p of [...new Set(posts)]) console.log(`  ${WRITE.test(p) ? '🛡 假' : '  真'} ${p}`)
