/**
 * 1015 長按 long_press／拖動 drag 積木：走真的 H5 腳本編輯器。
 * 新增 → 填欄位 → 清空一個 X → 儲存 → 重新載入 → 重開腳本讀回 inspector → 對照 API 存的 JSON → 兩種主題截圖 → 刪除腳本。
 * 跑法（repo 根目錄；server 3000 和 worker 3010 都要開——/api/frontend-auto/* 轉給 worker，沒開存檔會靜默失敗）：node scripts/ui-checks/uat-gesture-editor-walk.mjs
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const HOST = process.env.UI_HOST || '192.168.3.36'
const OUT = process.env.OUT || '.'
const NAME = 'ZZ gesture walk 1015'
const SUF = process.env.SUF || ''
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'), { readonly: true })
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }

let fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++ }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: HOST, path: '/' }])
const page = await ctx.newPage()
page.on('dialog', d => d.accept())
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)))

const setTheme = async mode => { await page.evaluate(m => localStorage.setItem('toppath-theme-mode', m), mode) }
const openH5 = async () => {
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await page.locator('.sidebar-nav-item', { hasText: 'OSM Tools' }).first().click()
  await page.waitForTimeout(800)
  await page.locator('text=/UAT 整合測試|UAT/').first().click()
  await page.waitForTimeout(1500)
  await page.locator('.uat-main-tabs button', { hasText: 'H5' }).first().click()
  await page.waitForTimeout(1500)
}
const insp = () => page.locator('.uat-inspector')
const field = label => insp().getByLabel(label, { exact: true })
const apiScripts = async () => page.evaluate(async () => (await (await fetch('/api/frontend-auto/scripts?platform=h5')).json()).scripts ?? [])

try {
  await page.goto(`http://${HOST}:3000/`, { waitUntil: 'networkidle' })
  await setTheme('classic')
  await openH5()

  // 不留舊垃圾：同名的先記下來
  const pre = (await apiScripts()).filter(s => s.name === NAME)
  if (pre.length) console.log(`  注意：已有 ${pre.length} 份同名腳本`, pre.map(s => s.id))

  await page.getByRole('button', { name: '手動新增腳本' }).click()
  await page.waitForTimeout(500)
  await page.getByLabel('腳本名稱', { exact: true }).fill(NAME)
  await page.getByRole('button', { name: '編輯流程' }).first().click()
  await page.locator('.uat-editor-modal').waitFor()

  // (1) 新增長按
  await page.locator('.uat-add-step').selectOption('long_press')
  await page.waitForTimeout(300)
  check('(1) 長按積木加進清單', await page.locator('.uat-step-block.is-long_press').count() === 1)
  check('long_press 預設 holdMs=1500', await field('按住毫秒').inputValue() === '1500', await field('按住毫秒').inputValue())
  for (const l of ['目標 Selector', '目標 X', '目標 Y', '按住毫秒']) check(`long_press 有欄位「${l}」`, await field(l).count() === 1)
  check('long_press 有危險操作勾選', await insp().getByText('允許這個危險操作').count() === 1)
  // (2) 填值；X 先填 5 再清空
  await field('目標 Selector').fill('.btn-spin')
  await field('目標 X').fill('5')
  await field('目標 X').fill('')
  await field('按住毫秒').fill('1800')
  await insp().getByRole('checkbox').check()
  await page.screenshot({ path: `${OUT}/gesture-longpress-classic.png` })
  await insp().screenshot({ path: `${OUT}/gesture-longpress-inspector-classic.png` })

  // 新增拖動
  await page.locator('.uat-add-step').selectOption('drag')
  await page.waitForTimeout(300)
  check('(1) 拖動積木加進清單', await page.locator('.uat-step-block.is-drag').count() === 1)
  for (const l of ['起點 Selector', '起點 X', '起點 Y', '終點 Selector', '終點 X', '終點 Y', '先按住毫秒', '移動毫秒', '分幾段']) check(`drag 有欄位「${l}」`, await field(l).count() === 1)
  check('drag 有危險操作勾選', await insp().getByText('允許這個危險操作').count() === 1)
  await field('起點 X').fill('30')
  await field('起點 Y').fill('40')
  await field('終點 Selector').fill('.slot')
  await field('終點 X').fill('99')
  await field('終點 X').fill('')
  await field('先按住毫秒').fill('400')
  await field('移動毫秒').fill('700')
  await field('分幾段').fill('12')
  await insp().screenshot({ path: `${OUT}/gesture-drag-inspector-classic.png` })

  await page.locator('.uat-editor-modal').getByRole('button', { name: '關閉', exact: true }).click()
  await page.getByRole('button', { name: '儲存腳本' }).click()
  await page.waitForTimeout(1500)

  // 存進去的 JSON
  const saved = (await apiScripts()).filter(s => s.name === NAME && !pre.some(p => p.id === s.id))
  check('存成一份新腳本', saved.length === 1, `count=${saved.length}`)
  const sid = saved[0]?.id
  const steps = saved[0] ? JSON.parse(saved[0].steps) : []
  const lp = steps.find(s => s.action === 'long_press'), dr = steps.find(s => s.action === 'drag')
  console.log('  saved long_press:', JSON.stringify(lp))
  console.log('  saved drag      :', JSON.stringify(dr))
  check('(3) JSON long_press selector/holdMs/allowDangerous', lp?.selector === '.btn-spin' && lp?.holdMs === 1800 && lp?.allowDangerous === true)
  check('(4) JSON long_press 清空的 x 不存在（不是 0）', lp && !('x' in lp) && !('y' in lp))
  check('(3) JSON drag 值', dr?.fromX === 30 && dr?.fromY === 40 && dr?.toSelector === '.slot' && dr?.holdMs === 400 && dr?.durationMs === 700 && dr?.moveSteps === 12)
  check('(4) JSON drag 清空的 toX 不存在（不是 0）', dr && !('toX' in dr) && !('toY' in dr) && !('fromSelector' in dr))

  // (3) 重新載入、重開腳本，從 inspector 讀回
  for (const mode of ['classic', 'xianxia']) {
    await setTheme(mode)
    await openH5()
    await page.locator('.uat-backend-plan button, button').filter({ hasText: NAME }).first().click()
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: '編輯流程' }).first().click()
    await page.locator('.uat-editor-modal').waitFor()
    await page.locator('.uat-step-block.is-long_press').click()
    await page.waitForTimeout(300)
    const rlp = { sel: await field('目標 Selector').inputValue(), x: await field('目標 X').inputValue(), y: await field('目標 Y').inputValue(), hold: await field('按住毫秒').inputValue(), danger: await insp().getByRole('checkbox').isChecked() }
    console.log(`  [${mode}] reload long_press inspector:`, JSON.stringify(rlp))
    check(`(3) [${mode}] 重載後 long_press 值一致`, rlp.sel === '.btn-spin' && rlp.hold === '1800' && rlp.danger === true)
    check(`(4) [${mode}] 重載後 目標 X 是空的（不是 0）`, rlp.x === '' && rlp.y === '')
    const fsLp = await insp().locator('.uat-hint', { hasText: 'Selector 和座標擇一填' }).evaluate(el => getComputedStyle(el).fontSize)
    console.log(`  [${mode}] long_press hint font-size: ${fsLp}`)
    check(`[${mode}] long_press 說明字級 11px`, fsLp === '11px', fsLp)
    await insp().screenshot({ path: `${OUT}/gesture-longpress-inspector-${mode}-reloaded${SUF}.png` })
    await page.locator('.uat-step-block.is-drag').click()
    await page.waitForTimeout(300)
    const rdr = {}
    for (const l of ['起點 Selector', '起點 X', '起點 Y', '終點 Selector', '終點 X', '終點 Y', '先按住毫秒', '移動毫秒', '分幾段']) rdr[l] = await field(l).inputValue()
    console.log(`  [${mode}] reload drag inspector:`, JSON.stringify(rdr))
    check(`(3) [${mode}] 重載後 drag 值一致`, rdr['起點 X'] === '30' && rdr['起點 Y'] === '40' && rdr['終點 Selector'] === '.slot' && rdr['先按住毫秒'] === '400' && rdr['移動毫秒'] === '700' && rdr['分幾段'] === '12' && rdr['起點 Selector'] === '')
    check(`(4) [${mode}] 重載後 終點 X/Y 是空的`, rdr['終點 X'] === '' && rdr['終點 Y'] === '')
    const fsDr = await insp().locator('.uat-hint', { hasText: '起點、終點各自' }).evaluate(el => getComputedStyle(el).fontSize)
    console.log(`  [${mode}] drag hint font-size: ${fsDr}`)
    check(`[${mode}] drag 說明字級 11px`, fsDr === '11px', fsDr)
    await insp().screenshot({ path: `${OUT}/gesture-drag-inspector-${mode}-reloaded${SUF}.png` })
    await page.screenshot({ path: `${OUT}/gesture-editor-${mode}.png` })
    await page.locator('.uat-editor-modal').getByRole('button', { name: '關閉', exact: true }).click()
    await page.waitForTimeout(300)
    check(`[${mode}] 只是開關編輯器沒有變成未儲存`, await page.getByText('尚未儲存').count() === 0)
  }

  // 清理：用畫面上的「刪除腳本」
  await page.getByRole('button', { name: '刪除腳本' }).click()
  await page.waitForTimeout(1500)
  const left = (await apiScripts()).filter(s => s.id === sid)
  check('清理：腳本已從清單刪掉', left.length === 0, `sid=${sid}`)
} catch (e) {
  console.log('FATAL', String(e).split('\n').slice(0, 4).join(' | '))
  await page.screenshot({ path: `${OUT}/gesture-fatal.png` }).catch(() => {})
  fail++
} finally {
  await browser.close()
}
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過')
process.exit(fail ? 1 : 0)
