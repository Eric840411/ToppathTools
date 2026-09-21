/**
 * PC 機台內的兩顆新積木（`pc_click_node`／`assert_pc_node`）在真站台跑一次。
 *
 *   PC_URL='<PC 版 token URL>' [GAME=Phoenix] npx tsx scripts/ui-checks/pc-node-verify.ts
 *
 * 🚨 **重點一樣是「該紅的會紅」**：每個正向檢查都配一個故意給錯的（不存在的節點名）。
 * ⚠️ 會真的進機台（佔位子），跑完退回大廳。**先鎖帳號。**
 * ⚠️ **只點資訊類面板**（Road／Favorite／History／Rank）——不碰 Play／Bet／Spin，
 *    那些會動到餘額。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities, pcSceneName, pcBackToLobby } from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const GAME = process.env.GAME ?? 'Phoenix'
const OUT = process.env.OUT ?? '.'
if (!PC_URL) { console.log('要給 PC_URL'); process.exit(1) }

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`)
  if (ok) pass++; else fail++
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let page: import('playwright').Page | null = null
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await ctx.newPage()
  const log = async (l: string) => console.log('   ' + l)
  const host = {
    log, page, browser, recordedLocator: async () => { throw new Error('PC 沒有 DOM 選擇器') },
    netCapture: null, startUrl: PC_URL, viewportHeight: 800, backend: null,
    state: { netMark: Date.now() }, pc: pcEngineCapabilities,
  }
  const run = async (step: Record<string, unknown>) => {
    try { await runFrontendStep(step, { ...host, idx: '[*]', label: String(step.name) }); return { ok: true, err: '' } }
    catch (e) { return { ok: false, err: String((e as Error).message ?? e).split('\n')[0].slice(0, 130) } }
  }

  await run({ name: '前往 PC 大廳', action: 'goto' })
  const entered = await run({ name: '進機台', action: 'pc_enter_machine', value: GAME })
  check('① 進得了機台', entered.ok, entered.err)
  if (!entered.ok) process.exit(1)
  await page.waitForTimeout(6000)

  // ── 機台內的功能鍵（節點名是實測量到的：btn-road／btn-favorite／btn-history／btn-rank）──
  for (const [node, label] of [['btn-road', '路書'], ['btn-favorite', '最愛'], ['btn-history', 'History'], ['btn-rank', 'Rank']]) {
    const r = await run({ name: `驗 ${label} 鍵在`, action: 'assert_pc_node', value: node })
    check(`② ${label}（${node}）在`, r.ok, r.err)
  }
  // 用畫面上的字找（標籤比對那條路）
  const byLabel = await run({ name: '用標籤文字找 CCTV', action: 'assert_pc_node', value: 'CCTV' })
  check('③ 用畫面上的字（CCTV）也找得到', byLabel.ok, byLabel.err)

  // 🚨 反向：不存在的節點必須紅
  const noSuch = await run({ name: '（故意）驗不存在的節點', action: 'assert_pc_node', value: 'btn-no-such-zzz' })
  check('④ 不存在的節點必須失敗', !noSuch.ok, noSuch.err)
  const clickNoSuch = await run({ name: '（故意）點不存在的節點', action: 'pc_click_node', value: 'btn-no-such-zzz' })
  check('⑤ 點不存在的節點必須失敗', !clickNoSuch.ok, clickNoSuch.err)

  // ── 真的點開一個面板，看看多了什麼（下一步要拿它當斷言目標）────────────
  const clicked = await run({ name: '點開路書', action: 'pc_click_node', value: 'btn-road' })
  check('⑥ 點得開路書', clicked.ok, clicked.err)
  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${OUT}/pc-node-road.png` })
  const opened = await page.evaluate(() => {
    interface N { name?: string; activeInHierarchy?: boolean; children?: N[]; components?: Array<{ string?: string }> }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
    if (!cc) return []
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 18) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const labelOf = (n: N) => { for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim(); return '' }
    return all.filter(n => n.activeInHierarchy !== false && /road|panel|pop|list|record|view/i.test(String(n.name ?? '')))
      .map(n => ({ name: String(n.name ?? '').slice(0, 26), label: labelOf(n).slice(0, 20) })).slice(0, 20)
  })
  console.log('   路書打開後看得到的節點：')
  opened.forEach(o => console.log('      ' + JSON.stringify(o)))

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  try {
    if (page && await pcSceneName(page).catch(() => '') === 'game') {
      const back = await pcBackToLobby(page)
      console.log(`退回大廳：${back.ok ? '✅' : '❌'} ${back.steps.join(' → ')}`)
    }
  } catch { /* ignore */ }
  await browser.close()
}
