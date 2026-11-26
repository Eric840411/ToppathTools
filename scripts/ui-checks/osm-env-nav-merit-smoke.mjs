/**
 * 銀月功德（全員共用計數）本機冒煙：打真正在跑的 server（預設 http://localhost:3000）。
 *
 * 驗：未登入擋下、批次去重、併發不漏算、參數檢查、過期週拒收、
 *     畫面沒有型態切換鈕、未滿 30 是狐形、同一週跨過 30 才變人形、點角色不會變身。
 * 會把本週計數先存起來，跑完還原（測試批次的去重紀錄一併刪掉）。
 *
 * 跑法：node scripts/ui-checks/osm-env-nav-merit-smoke.mjs [baseUrl]
 */
import { mintDevSession, devSidHash } from './lib/dev-session.mjs'
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = process.argv[2] || 'http://localhost:3000'
const db = new Database(path.join(root, 'server/data.db'))
const sess = mintDevSession(db)
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
const H = { Cookie: `toppath_auth=${sess.sid}`, 'Content-Type': 'application/json' }
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const get = async () => (await fetch(`${BASE}/api/osm-env-nav/merit`, { headers: H })).json()
const hit = async body => { const r = await fetch(`${BASE}/api/osm-env-nav/merit/hit`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }
const bid = tag => `smoke${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
const setCount = (week, n) => db.prepare('INSERT INTO osm_env_nav_merit (week_start, count) VALUES (?, ?) ON CONFLICT(week_start) DO UPDATE SET count = excluded.count').run(week, n)

let week, saved, browser
try {
  const anon = await fetch(`${BASE}/api/osm-env-nav/merit`)
  check('未登入 GET 被擋', anon.status === 401, `status=${anon.status}`)
  const anonHit = await fetch(`${BASE}/api/osm-env-nav/merit/hit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: bid('a'), n: 1 }) })
  check('未登入 POST 被擋', anonHit.status === 401, `status=${anonHit.status}`)

  const s0 = await get()
  week = s0.weekStart
  saved = s0.count
  check('GET 回 weekStart／count／evoAt=30', /^\d{4}-\d{2}-\d{2}$/.test(week) && Number.isInteger(s0.count) && s0.evoAt === 30, JSON.stringify(s0))
  check('weekStart 是星期一', new Date(week + 'T00:00:00Z').getUTCDay() === 1, week)

  setCount(week, 0)
  const b1 = bid('b')
  const r1 = await hit({ batchId: b1, n: 3, weekStart: week })
  check('累加 3', r1.status === 200 && r1.body.count === 3, JSON.stringify(r1.body))
  const r2 = await hit({ batchId: b1, n: 3, weekStart: week })
  check('同一個 batchId 重送不重複算', r2.status === 200 && r2.body.count === 3, JSON.stringify(r2.body))
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => hit({ batchId: bid('c' + i), n: 2, weekStart: week })))
  const after = await get()
  check('10 個併發批次各 2 不漏算', many.every(r => r.status === 200) && after.count === 23, `count=${after.count}`)
  for (const [name, body] of [['n=0', { batchId: bid('d'), n: 0 }], ['n=21', { batchId: bid('d'), n: 21 }], ['n=1.5', { batchId: bid('d'), n: 1.5 }], ['n 是字串', { batchId: bid('d'), n: '3' }], ['沒有 batchId', { n: 1 }], ['過期的週', { batchId: bid('d'), n: 1, weekStart: '2020-01-06' }]]) {
    const r = await hit(body)
    check(`拒收 ${name}`, r.status === 400, `status=${r.status}`)
  }
  check('被拒收的都沒算進去', (await get()).count === 23)

  // 畫面：未滿 30 是狐形、沒有切換鈕、點角色不變身；跨過 30 才變人形
  setCount(week, 28)
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  await ctx.addCookies([{ name: 'toppath_auth', value: sess.sid, domain: new URL(BASE).hostname, path: '/' }])
  const page = await ctx.newPage()
  await page.goto(`${BASE}/osm-env-nav/page?embed=1&theme=classic`)
  const f = page.frameLocator('#meritFrame')
  await f.locator('#num').waitFor()
  await page.waitForFunction(() => document.getElementById('meritFrame').contentDocument.getElementById('num').textContent === '28', null, { timeout: 10000 })
  const isHuman = () => f.locator('#stage').evaluate(el => el.classList.contains('is-human'))
  check('畫面顯示伺服器的 28', (await f.locator('#num').textContent()) === '28')
  check('沒有型態切換鈕', (await f.locator('#switch, .switch').count()) === 0)
  check('28 時是狐形', !(await isHuman()))
  check('顯示化形進度 28 / 30', (await f.locator('#evoLbl').textContent()).includes('28 / 30'))
  await f.locator('#char').click({ force: true })
  await page.waitForTimeout(800)
  check('點角色不會變身', !(await isHuman()))
  await f.locator('#fish').dispatchEvent('pointerdown')
  await page.waitForTimeout(1500)
  check('敲到 29 還是狐形', (await f.locator('#num').textContent()) === '29' && !(await isHuman()) && (await get()).count === 29)
  await f.locator('#fish').dispatchEvent('pointerdown')
  await page.waitForFunction(() => document.getElementById('meritFrame').contentDocument.getElementById('stage').classList.contains('is-human'), null, { timeout: 8000 }).catch(() => {})
  check('敲到 30 變人形', (await isHuman()) && (await get()).count === 30)
  await page.screenshot({ path: path.join(root, '.scratch-merit', 'v2-human-30.png'), clip: { x: 1600 - 460, y: 900 - 140, width: 460, height: 140 } })

  // 重新載入：已滿 30 直接是人形；別人敲的也看得到
  setCount(week, 12)
  await page.reload()
  await page.waitForFunction(() => document.getElementById('meritFrame').contentDocument.getElementById('num').textContent === '12', null, { timeout: 10000 })
  check('換週歸零／數字變少時重新載入是狐形', !(await isHuman()))
  await page.screenshot({ path: path.join(root, '.scratch-merit', 'v2-fox-12.png'), clip: { x: 1600 - 460, y: 900 - 140, width: 460, height: 140 } })
  await hit({ batchId: bid('e'), n: 5, weekStart: week })
  await page.waitForFunction(() => document.getElementById('meritFrame').contentDocument.getElementById('num').textContent === '17', null, { timeout: 20000 }).catch(() => {})
  check('別人敲的 15 秒內會出現在畫面上', (await f.locator('#num').textContent()) === '17')
} catch (e) {
  check('冒煙腳本沒有中途出錯', false, String(e?.message ?? e).slice(0, 300))
} finally {
  if (browser) await browser.close()
  if (week !== undefined && saved !== undefined) setCount(week, saved)
  db.prepare("DELETE FROM osm_env_nav_merit_batch WHERE batch_id LIKE 'smoke%'").run()
  db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(devSidHash(sess.sid))
  console.log(`\n功德冒煙：${pass} 過／${fail} 失敗（本週計數已還原為 ${saved}）`)
  process.exit(fail ? 1 : 0)
}
